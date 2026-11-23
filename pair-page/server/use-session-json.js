'use strict';

/**
 * Use a session exported by the WhatsApp Session Pair page inside your own bot.
 *
 * The page gives you two forms of the same session:
 *   1. session.json  — the raw auth JSON (creds + keys, BufferJSON encoded)
 *   2. Session ID    — base64 of that same JSON
 *
 * Example:
 *   const fs = require('fs');
 *   const { default: makeWASocket } = require('@whiskeysockets/baileys');
 *   const { useSessionJsonAuthState } = require('./use-session-json');
 *
 *   const { state, saveCreds } = useSessionJsonAuthState(fs.readFileSync('session.json', 'utf8'));
 *   // or from a Session ID string: useSessionJsonAuthState(Buffer.from(id, 'base64').toString('utf8'))
 *
 *   const sock = makeWASocket({ auth: state });
 *   sock.ev.on('creds.update', saveCreds);
 *
 * NOTE: unlike the pair server (which never stores anything), a bot that
 * uses this helper DOES persist its own session back to the JSON string
 * through saveCreds — wire saveCreds to wherever your bot keeps its state.
 */

const { BufferJSON, proto } = require('@whiskeysockets/baileys');

function useSessionJsonAuthState(jsonText, onSave) {
  const parsed = JSON.parse(String(jsonText), BufferJSON.reviver);
  const creds = parsed.creds;
  const keyStore = parsed.keys || {};

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
        if (onSave) await onSave(JSON.stringify({ creds, keys: keyStore }, BufferJSON.replacer, 2));
      }
    }
  };

  const saveCreds = async () => {
    if (onSave) await onSave(JSON.stringify({ creds, keys: keyStore }, BufferJSON.replacer, 2));
  };

  return { state, saveCreds };
}

module.exports = { useSessionJsonAuthState };
