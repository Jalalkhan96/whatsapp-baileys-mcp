'use strict';
/*
 * pair-core.js — shared, robust WhatsApp pairing engine (Baileys).
 *
 * Why the old logic failed: after a pairing code is entered on the phone,
 * WhatsApp closes the socket with status 515 ("restart required") and
 * expects the client to reconnect IMMEDIATELY with the just-saved creds.
 * The old scripts exited the process on ANY close, so the pairing died at
 * exactly that step and never completed.
 *
 * This engine:
 *  - requests the pairing code on the first QR event (the moment WhatsApp
 *    is ready for it), with the QR kept as a fallback;
 *  - saves creds on every creds.update;
 *  - reconnects IN-PROCESS on 515 and other transient closes (short
 *    backoff), reusing the same auth state — a new code is NEVER requested
 *    after the phone consumed the first one;
 *  - stops on 401 / logged out (the session folder must be deleted);
 *  - gives up after timeoutMs (default 3 minutes) so callers never hang.
 *
 * Resolves with one of:
 *   { status: 'paired', user }        — success, session saved
 *   { status: 'already_paired', user }
 *   { status: 'logged_out' }          — delete the session folder, retry
 *   { status: 'timeout' }             — code/QR was not used in time
 */
const fs = require('fs');
const pino = require('pino');

async function runPairing(opts) {
  const {
    sessionDir,
    phone = '',
    onQr = () => {},
    onCode = () => {},
    onStatus = () => {},
    timeoutMs = 3 * 60 * 1000,
  } = opts || {};
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = require('@whiskeysockets/baileys');

  fs.mkdirSync(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  if (state.creds.registered) {
    return { status: 'already_paired', user: state.creds.me || null };
  }

  let agent;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    try { agent = new (require('https-proxy-agent').HttpsProxyAgent)(proxy); } catch (_) {}
  }
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}

  const deadline = Date.now() + timeoutMs;
  let codeAsked = false;

  return await new Promise((resolve) => {
    let settled = false;
    const killer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    function finish(v) {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(v);
    }

    const start = () => {
      if (settled) return;
      const sock = makeWASocket({
        version,
        auth: state,
        agent,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (u) => {
        try {
          if (u.qr) {
            if (phone && !codeAsked) {
              codeAsked = true;
              try {
                const code = await sock.requestPairingCode(phone);
                onCode(code);
              } catch (e) {
                codeAsked = false;
                onStatus('code_request_failed: ' + e.message);
                onQr(u.qr);
              }
            } else if (!phone) {
              onQr(u.qr);
            }
          }
          if (u.connection === 'open') {
            onStatus('connected');
            finish({ status: 'paired', user: sock.user || null });
          }
          if (u.connection === 'close') {
            const sc = u.lastDisconnect && u.lastDisconnect.error &&
              u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
            if (sc === DisconnectReason.loggedOut || sc === 401) {
              finish({ status: 'logged_out' });
              return;
            }
            if (Date.now() > deadline) { finish({ status: 'timeout' }); return; }
            // 515 = restart required right after pairing; other codes are
            // transient network closes. Either way: reconnect in-process
            // with the SAME auth state and keep waiting for 'open'.
            onStatus('reconnecting (close ' + sc + ')');
            try { sock.end(undefined); } catch (_) {}
            setTimeout(() => { if (!settled) start(); }, sc === 515 ? 800 : 2500);
          }
        } catch (e) {
          onStatus('pairing error: ' + e.message);
        }
      });
    };
    start();
  });
}

module.exports = { runPairing };
