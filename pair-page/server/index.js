'use strict';

/**
 * WhatsApp Pair Server
 * -------------------
 * One Baileys socket per visitor. The SAME socket produces BOTH:
 *   - a QR code (rendered to a PNG data URL), and
 *   - a pairing code (when a phone number is supplied).
 * The page shows both at the same time.
 *
 * PRIVACY RULE (by design): the WhatsApp auth state lives ONLY in this
 * process's RAM. Nothing is written to disk, no database, no logs of
 * credentials. When a session is delivered (or expires, or the visitor
 * closes it), the socket is ended and every byte of state is dropped.
 *
 * API:
 *   POST /api/start            { phone?: "923001234567" }  -> { id }
 *   GET  /api/events/:id       Server-Sent Events stream:
 *        { type: "status",  text }
 *        { type: "qr",      dataUrl }          (refreshes as WhatsApp rotates it)
 *        { type: "pairing", code }             (only when a phone was given)
 *        { type: "session", me, sessionJson, sessionId }
 *        { type: "error",   text }
 *        { type: "closed" }
 *   POST /api/close/:id        wipe that session immediately
 *   GET  /health               { ok: true }
 */

const http = require('http');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pino = require('pino');

const {
  default: makeWASocket,
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 8799);
const SESSION_TTL_MS = 3 * 60 * 1000;      // a pairing attempt lives at most 3 minutes
const DELIVERY_GRACE_MS = 15 * 1000;       // after delivery, keep state 15s so the page can copy/download, then wipe

// Optional egress proxy (e.g. the sandbox). Baileys rule learned the hard
// way: pass ONLY `agent` — adding a fetch agent breaks the handshake.
let proxyAgent;
try {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (proxyUrl) proxyAgent = new HttpsProxyAgent(proxyUrl);
} catch { /* no proxy agent available; direct connection */ }

const logger = pino({ level: 'silent' });

/** Fully in-memory Baileys auth state. Nothing here ever touches disk. */
function createInMemoryAuth() {
  const creds = initAuthCreds();
  const keyStore = {}; // { [type]: { [id]: value } }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          let value = keyStore[type] && keyStore[type][id];
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value) data[id] = value;
        }
        return data;
      },
      set: async (data) => {
        for (const category of Object.keys(data)) {
          keyStore[category] = keyStore[category] || {};
          for (const id of Object.keys(data[category])) {
            const value = data[category][id];
            if (value) keyStore[category][id] = value;
            else delete keyStore[category][id];
          }
        }
      }
    }
  };

  // In RAM the creds object is mutated in place, so there is nothing to save.
  const saveCreds = async () => {};

  const exportSession = () => JSON.stringify({ creds, keys: keyStore }, BufferJSON.replacer, 2);

  return { state, saveCreds, exportSession };
}

/** Live pairing sessions: id -> record. RAM only. */
const sessions = new Map();

function sendEvent(rec, event) {
  if (!rec.sse || rec.sse.writableEnded) return;
  rec.sse.write(`data: ${JSON.stringify(event)}\n\n`);
}

function wipeSession(id, reason) {
  const rec = sessions.get(id);
  if (!rec) return;
  sessions.delete(id);
  clearTimeout(rec.ttlTimer);
  clearTimeout(rec.wipeTimer);
  try { rec.sock && rec.sock.end(undefined); } catch { /* already gone */ }
  if (rec.sse && !rec.sse.writableEnded) {
    try {
      rec.sse.write(`data: ${JSON.stringify({ type: 'closed', reason: reason || 'wiped' })}\n\n`);
      rec.sse.end();
    } catch { /* client already left */ }
  }
  // Drop references so the credentials can be garbage-collected.
  rec.auth = null;
  rec.sock = null;
}

async function startPairing(id, phone) {
  const auth = createInMemoryAuth();
  const rec = {
    id,
    auth,
    sock: null,
    sse: null,
    pairingRequested: false,
    delivered: false,
    ttlTimer: null,
    wipeTimer: null
  };
  sessions.set(id, rec);
  rec.ttlTimer = setTimeout(() => wipeSession(id, 'expired'), SESSION_TTL_MS);

  let version;
  try {
    const v = await fetchLatestWaWebVersion({});
    version = v.version;
  } catch { /* fall back to Baileys' built-in version */ }

  rec.phone = phone;
  rec.version = version;

  attachSocket(rec);
  return rec;
}

function attachSocket(rec) {
  const { id, phone } = rec;
  const auth = rec.auth;
  const version = rec.version;
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: auth.state,
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    ...(proxyAgent ? { agent: proxyAgent } : {})
  });
  rec.sock = sock;

  sock.ev.on('creds.update', auth.saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { width: 264, margin: 1 });
        sendEvent(rec, { type: 'qr', dataUrl });
        sendEvent(rec, { type: 'status', text: 'Scan the QR — or use the pairing code below.' });
      } catch { /* qr render failed; next rotation will retry */ }

      // Ask WhatsApp for a pairing code on the SAME socket, once.
      if (phone && !rec.pairingRequested && !auth.state.creds.registered) {
        rec.pairingRequested = true;
        try {
          const raw = await sock.requestPairingCode(phone);
          const code = String(raw || '').replace(/(.{4})(?=.)/g, '$1-');
          if (code) sendEvent(rec, { type: 'pairing', code });
        } catch (err) {
          sendEvent(rec, { type: 'status', text: 'Pairing code failed — QR still works. (' + (err && err.message ? err.message : err) + ')' });
        }
      }
    }

    if (connection === 'open') {
      rec.delivered = true;
      const sessionJson = auth.exportSession();
      const sessionId = Buffer.from(sessionJson, 'utf8').toString('base64');
      sendEvent(rec, {
        type: 'session',
        me: sock.user || null,
        sessionJson,
        sessionId
      });
      // Give the page a short window to copy/download, then wipe everything.
      rec.wipeTimer = setTimeout(() => wipeSession(id, 'delivered'), DELIVERY_GRACE_MS);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;
      if (!rec.delivered) {
        if (statusCode === DisconnectReason.loggedOut) {
          sendEvent(rec, { type: 'error', text: 'Logged out by WhatsApp. Start again.' });
          wipeSession(id, 'logged_out');
        } else {
          // 515 (restartRequired) is EXPECTED right after the code/QR is
          // accepted: WhatsApp closes the socket and the client must
          // reconnect with the just-saved creds. Baileys does NOT do this
          // by itself — the old code waited forever at this step and the
          // session never arrived. Reconnect in-process with the SAME
          // in-memory auth; never request a new pairing code (the phone
          // already consumed it). Other transient closes get the same
          // treatment until the session TTL expires.
          sendEvent(rec, { type: 'status', text: 'Connected — finishing setup…' });
          try { sock.end(undefined); } catch { /* already closed */ }
          setTimeout(() => {
            if (sessions.has(id) && !rec.delivered) attachSocket(rec);
          }, statusCode === DisconnectReason.restartRequired ? 800 : 2500);
        }
      }
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, active: sessions.size }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readBody(req);
      let phone = '';
      try {
        const parsed = body ? JSON.parse(body) : {};
        phone = String(parsed.phone || '').replace(/\D/g, '');
      } catch { /* empty body is fine — QR only */ }
      if (phone && (phone.length < 7 || phone.length > 15)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Phone must be 7-15 digits, country code included, no + or spaces.' }));
        return;
      }
      const id = crypto.randomBytes(12).toString('hex');
      await startPairing(id, phone);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/events\/([a-f0-9]+)$/);
    if (req.method === 'GET' && eventsMatch) {
      const rec = sessions.get(eventsMatch[1]);
      if (!rec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      rec.sse = res;
      sendEvent(rec, { type: 'status', text: 'Connecting to WhatsApp…' });
      req.on('close', () => { if (rec.sse === res) rec.sse = null; });
      return;
    }

    const closeMatch = url.pathname.match(/^\/api\/close\/([a-f0-9]+)$/);
    if (req.method === 'POST' && closeMatch) {
      wipeSession(closeMatch[1], 'client_closed');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
  }
});

server.listen(PORT, () => {
  console.log(`WhatsApp Pair Server listening on :${PORT} (sessions in RAM only, TTL ${SESSION_TTL_MS / 1000}s)`);
});
