#!/usr/bin/env node
'use strict';
/* pair-live.js — QR pairing into the REAL session dir, for the hosted MCP.
 * Writes the current QR to ../current-qr.png on every rotation.
 * Prints CONNECTED and exits 0 once paired. Run under supervision of the agent.
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');

(async () => {
  const {
    default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion
  } = require('@whiskeysockets/baileys');
  const QRCode = require('qrcode');

  const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '..', 'session');
  const QR_FILE = path.join(__dirname, '..', 'current-qr.png');
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  if (state.creds.registered) { console.log('ALREADY_PAIRED'); process.exit(0); }
  let version; try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}
  let agent; const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) { try { agent = new (require('https-proxy-agent').HttpsProxyAgent)(proxy); } catch (_) {} }

  const sock = makeWASocket({
    version, auth: state, agent,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp MCP', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      try { await QRCode.toFile(QR_FILE, u.qr, { width: 640, margin: 2 }); console.log('QR_READY ' + Date.now()); }
      catch (e) { console.log('QR_WRITE_FAIL ' + e.message); }
    }
    if (u.connection === 'open') { console.log('CONNECTED ' + JSON.stringify(sock.user)); setTimeout(() => process.exit(0), 1500); }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      console.log('CLOSED code=' + code + (code === DisconnectReason.loggedOut ? ' loggedOut' : ''));
      if (code === DisconnectReason.loggedOut) process.exit(1);
      // 515 = restart required right after pairing — treat as progress, exit 0
      if (code === 515) { console.log('RESTART_REQUIRED_AFTER_PAIR'); process.exit(0); }
      process.exit(2);
    }
  });
})();
