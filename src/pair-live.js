#!/usr/bin/env node
'use strict';
/*
 * pair-live.js — pairing driver for hosted/supervised use.
 * - Writes every QR rotation to ../current-qr.png and prints QR_READY.
 * - If WA_PHONE_NUMBER is set, also prints PAIRING_CODE <code> and writes
 *   it to ../current-code.txt.
 * - Uses the shared pair-core engine: it survives the post-pairing 515
 *   restart in-process and only exits when the outcome is final.
 * Exit codes: 0 = paired (or already paired), 1 = logged out,
 *             2 = timed out (code/QR expired unused).
 * On success it also writes ../session.zip (a full login — keep private).
 */
const fs = require('fs');
const path = require('path');
const { runPairing } = require('./pair-core');

(async () => {
  const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '..', 'session');
  const QR_FILE = path.join(__dirname, '..', 'current-qr.png');
  const CODE_FILE = path.join(__dirname, '..', 'current-code.txt');
  const PHONE = (process.env.WA_PHONE_NUMBER || '').replace(/\D/g, '');
  const QRCode = require('qrcode');

  const res = await runPairing({
    sessionDir: SESSION_DIR,
    phone: PHONE,
    onQr: async (qr) => {
      try {
        await QRCode.toFile(QR_FILE, qr, { width: 640, margin: 2 });
        console.log('QR_READY ' + Date.now());
      } catch (e) {
        console.log('QR_WRITE_FAIL ' + e.message);
      }
    },
    onCode: (code) => {
      try { fs.writeFileSync(CODE_FILE, code); } catch (_) {}
      console.log('PAIRING_CODE ' + code);
    },
    onStatus: (s) => console.log('STATUS ' + s),
  });

  if (res.status === 'already_paired') { console.log('ALREADY_PAIRED'); process.exit(0); }
  if (res.status === 'paired') {
    console.log('CONNECTED ' + JSON.stringify(res.user));
    try {
      const { zipSessionDir } = require('./zip-session');
      const z = zipSessionDir(SESSION_DIR, path.join(__dirname, '..', 'session.zip'));
      console.log('SESSION_ZIP ' + z.path + ' ' + z.bytes);
    } catch (e) {
      console.log('SESSION_ZIP_FAIL ' + e.message);
    }
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  if (res.status === 'logged_out') { console.log('LOGGED_OUT'); process.exit(1); }
  console.log('NOT_LINKED ' + res.status);
  process.exit(2);
})().catch((e) => { console.error('pair-live failed:', e.message); process.exit(1); });
