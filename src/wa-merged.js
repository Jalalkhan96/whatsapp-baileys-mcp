'use strict';
/*
 * wa-merged.js — MCP connection adapter for MERGED mode.
 *
 * In merged mode the host application owns the Baileys connection and this adapter
 * lets the WhatsApp MCP serve its tools on the bot's socket instead of
 * opening a second connection: ONE process, ONE socket, ONE session.
 * The bot publishes its live socket at global.__host-app_SOCK (bot/index.js,
 * right after patchSock) and replaces it on every reconnect.
 *
 * Exposes the same interface as wa.js: connect, getStatus, getSock,
 * requireSock, getChats, getQr, SESSION_DIR.
 */
const fs = require('fs');
const path = require('path');

const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '..', '..', 'bot', 'session');
const startedAt = Date.now();
const chats = new Map(); // jid -> { id, name, unreadCount, conversationTimestamp }
let attachedTo = null;

const log = (...a) => console.error('[wa-mcp-merged]', ...a);

function currentSock() { return global.__host-app_SOCK || null; }

function attach(s) {
  if (!s || attachedTo === s) return;
  attachedTo = s;
  try {
    s.ev.on('chats.upsert', (list) => {
      for (const c of list || []) {
        if (c && c.id) chats.set(c.id, {
          id: c.id,
          name: c.name || '',
          unreadCount: c.unreadCount || 0,
          conversationTimestamp: c.conversationTimestamp || 0
        });
      }
    });
    s.ev.on('chats.update', (list) => {
      for (const c of list || []) {
        if (c && c.id) chats.set(c.id, Object.assign({}, chats.get(c.id), c));
      }
    });
    log('attached to bot socket');
  } catch (e) { log('attach failed:', e.message); }
}

function getSock() { const s = currentSock(); attach(s); return s; }

function isOpen() { const s = currentSock(); return !!(s && s.user); }

function getStatus() {
  const s = currentSock();
  attach(s);
  return {
    status: isOpen() ? 'open' : (s ? 'connecting' : 'disconnected'),
    me: s && s.user ? { id: s.user.id, name: s.user.name } : null,
    phone_configured: false,
    session_dir: SESSION_DIR,
    session_exists: fs.existsSync(path.join(SESSION_DIR, 'creds.json')),
    chats_known: chats.size,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    merged: true
  };
}

function getQr() { return null; }
function getChats() { return Array.from(chats.values()); }

function requireSock() {
  const s = getSock();
  if (!s || !s.user) {
    throw new Error('WhatsApp is not connected yet (merged mode: the host application owns the connection and has not finished connecting).');
  }
  return s;
}

async function connect() {
  // The bot owns the connection; just keep watching for its socket.
  const t = setInterval(() => attach(currentSock()), 2000);
  if (t.unref) t.unref();
  attach(currentSock());
  log('merged mode: MCP tools will run on the host application socket (global.__host-app_SOCK).');
}

module.exports = { connect, getStatus, getSock, requireSock, getChats, getQr, SESSION_DIR };
