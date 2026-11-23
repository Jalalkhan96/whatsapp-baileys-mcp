#!/usr/bin/env node
'use strict';
/*
 * pair.js — one-time pairing helper.
 * Run in a real terminal:  npm run pair
 * - If WA_PHONE_NUMBER is set in the environment, a PAIRING CODE is printed:
 *   WhatsApp → Settings → Linked devices → Link a device → "Link with phone
 *   number instead" → enter the code.
 * - Otherwise a QR code is rendered here to scan.
 * Keep the terminal open until it prints "connected as ...", then Ctrl+C.
 * The session is saved to WA_SESSION_DIR (default ./session) and reused by
 * the MCP server from then on.
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');

(async () => {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
  } = require('@whiskeysockets/baileys');
  const qrcode = require('qrcode-terminal');

  const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '..', 'session');
  const PHONE = (process.env.WA_PHONE_NUMBER || '').replace(/\D/g, '');
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  if (state.creds.registered) {
    console.log('Session already paired (' + SESSION_DIR + '). Delete the folder to pair a different number.');
    process.exit(0);
  }
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp MCP', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });
  sock.ev.on('creds.update', saveCreds);

  let codeAsked = false;
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      if (PHONE && !codeAsked) {
        codeAsked = true;
        try {
          const code = await sock.requestPairingCode(PHONE);
          console.log('\n=== PAIRING CODE for +' + PHONE + ':  ' + code + '  ===\n');
          return;
        } catch (e) { console.log('Pairing code failed (' + e.message + '), falling back to QR:'); }
      }
      qrcode.generate(u.qr, { small: true });
      console.log('Scan the QR with WhatsApp → Linked devices.');
    }
    if (u.connection === 'open') {
      console.log('\n✅ connected as ' + JSON.stringify(sock.user));
      console.log('Session saved in ' + SESSION_DIR + ' — you can close this (Ctrl+C).');
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) { console.log('Logged out. Delete the session folder and pair again.'); process.exit(1); }
      console.log('Connection closed (code ' + code + '). Re-run to retry.');
      process.exit(1);
    }
  });
})();
