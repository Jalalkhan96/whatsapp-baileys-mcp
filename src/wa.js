'use strict';
/*
 * wa.js — Baileys connection manager for the WhatsApp MCP server.
 * One shared socket, multi-file auth state on disk, auto-reconnect.
 * ALL logging goes to stderr (stdout belongs to the MCP protocol).
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '..', 'session');
const PHONE = (process.env.WA_PHONE_NUMBER || '').replace(/\D/g, ''); // for pairing-code login
const AUTOCONNECT = process.env.WA_AUTOCONNECT !== '0';

const log = (...a) => console.error('[wa-mcp]', ...a);

// Sandbox/hosts behind an HTTP(S) proxy: route the WhatsApp WebSocket
// through it (Baileys accepts a custom agent). No proxy env -> undefined.
function proxyAgent() {
  const url = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!url) return undefined;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(url);
  } catch (e) { log('proxy agent unavailable:', e.message); return undefined; }
}

let sock = null;
let status = 'disconnected'; // disconnected | connecting | qr | pairing | open
let me = null;                // { id, name } once connected
let pairingCode = null;
let qrString = null;
const chats = new Map();      // jid -> { id, name, unreadCount, conversationTimestamp }
const startedAt = Date.now();

function getStatus() {
  return {
    status,
    me,
    phone_configured: !!PHONE,
    session_dir: SESSION_DIR,
    session_exists: fs.existsSync(path.join(SESSION_DIR, 'creds.json')),
    chats_known: chats.size,
    pairing_code: status === 'pairing' ? pairingCode : undefined,
    uptime_s: Math.round((Date.now() - startedAt) / 1000)
  };
}
function getQr() { return qrString; }
function getSock() { return sock; }
function getChats() { return Array.from(chats.values()); }
function requireSock() {
  if (!sock || status !== 'open') {
    throw new Error('WhatsApp is not connected (status: ' + status + '). Pair the number first: run `npm run pair` or set WA_PHONE_NUMBER and restart.');
  }
  return sock;
}

async function connect() {
  if (!AUTOCONNECT) { status = 'disconnected'; log('WA_AUTOCONNECT=0 — staying offline (protocol test mode).'); return; }
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
  } = require('@whiskeysockets/baileys');

  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch (_) { version = undefined; }

  status = 'connecting';
  sock = makeWASocket({
    version,
    auth: state,
    agent: proxyAgent(),
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp MCP', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      qrString = qr;
      if (!state.creds.registered && PHONE && !pairingCode) {
        status = 'pairing';
        try {
          pairingCode = await sock.requestPairingCode(PHONE);
          log('PAIRING CODE for +' + PHONE + ': ' + pairingCode + '  (WhatsApp → Linked devices → Link with phone number)');
        } catch (e) { log('pairing code request failed:', e.message); status = 'qr'; }
      } else {
        status = 'qr';
        log('QR received — run `npm run pair` in a terminal to scan it, or read wa_qr via MCP.');
      }
    }
    if (connection === 'open') {
      status = 'open';
      me = { id: sock.user && sock.user.id, name: sock.user && sock.user.name };
      log('connected as', JSON.stringify(me));
    }
    if (connection === 'close') {
      pairingCode = null; // a pairing code dies with its socket session
      qrString = null;
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      status = 'disconnected';
      log('connection closed, code', code, loggedOut ? '(logged out — delete session dir and pair again)' : '— reconnecting in 3s');
      if (!loggedOut) setTimeout(() => connect().catch((e) => log('reconnect failed:', e.message)), 3000);
    }
  });

  sock.ev.on('chats.upsert', (list) => {
    for (const c of list || []) {
      if (c && c.id) chats.set(c.id, {
        id: c.id,
        name: c.name || '',
        unreadCount: c.unreadCount || 0,
        conversationTimestamp: c.conversationTimestamp || 0
      });
    }
  });
  sock.ev.on('chats.update', (list) => {
    for (const c of list || []) {
      if (c && c.id) chats.set(c.id, Object.assign({}, chats.get(c.id), c));
    }
  });
}

module.exports = { connect, getStatus, getSock, requireSock, getChats, getQr, SESSION_DIR };
