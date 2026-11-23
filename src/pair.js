#!/usr/bin/env node
'use strict';
/*
 * pair.js — one-time pairing helper (terminal). Run:  npm run pair
 * - WA_PHONE_NUMBER set  → a PAIRING CODE is printed: WhatsApp → Linked
 *   devices → Link a device → "Link with phone number instead" → enter it.
 * - WA_PHONE_NUMBER unset → a QR code is rendered here to scan.
 * The pairing engine (pair-core.js) survives WhatsApp's post-pairing 515
 * restart by reconnecting in-process — keep the terminal open until it
 * prints "PAIRED". On success the session is saved to WA_SESSION_DIR
 * (default ./session) AND exported as session.zip next to it, so the
 * session can be moved to another host as a single file.
 * WARNING: session.zip is a full WhatsApp login — keep it private.
 */
const path = require('path');
const { runPairing } = require('./pair-core');

(async () => {
  const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '..', 'session');
  const PHONE = (process.env.WA_PHONE_NUMBER || '').replace(/\D/g, '');
  const qrcode = require('qrcode-terminal');

  const res = await runPairing({
    sessionDir: SESSION_DIR,
    phone: PHONE,
    onQr: (qr) => {
      qrcode.generate(qr, { small: true });
      console.log('Scan the QR with WhatsApp → Linked devices.');
    },
    onCode: (code) => {
      console.log('\n=== PAIRING CODE for +' + PHONE + ':  ' + code + '  ===');
      console.log('Enter it within ~2 minutes: WhatsApp → Linked devices → Link a device → "Link with phone number instead".\n');
    },
    onStatus: (s) => console.log('[pair] ' + s),
  });

  if (res.status === 'already_paired') {
    console.log('Session already paired (' + SESSION_DIR + '). Delete the folder to pair a different number.');
    process.exit(0);
  }
  if (res.status === 'paired') {
    console.log('\n✅ PAIRED as ' + JSON.stringify(res.user));
    try {
      const { zipSessionDir } = require('./zip-session');
      const out = path.join(path.dirname(SESSION_DIR), 'session.zip');
      const z = zipSessionDir(SESSION_DIR, out);
      console.log('Session ZIP written: ' + z.path + ' (' + z.bytes + ' bytes, ' + z.files + ' files) — keep it private.');
    } catch (e) {
      console.log('Session ZIP failed: ' + e.message);
    }
    console.log('Session saved in ' + SESSION_DIR + ' — you can close this (Ctrl+C).');
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  if (res.status === 'logged_out') {
    console.log('Logged out / refused by WhatsApp. Delete the session folder and pair again.');
    process.exit(1);
  }
  console.log('Pairing did not complete (' + res.status + ') — the code/QR expired unused. Run again for a fresh one.');
  process.exit(2);
})().catch((e) => { console.error('pair failed:', e.message); process.exit(1); });
