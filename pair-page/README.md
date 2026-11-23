# WhatsApp Session Pair

A page that shows a **QR code and a pairing code at the same time** from one
Baileys socket. Once the phone links, the page hands the visitor their
WhatsApp **session** (Session ID base64 + `session.json` download).

**The session is never stored.** The pairing server keeps the auth state in
RAM only — no disk, no database, no credential logs. State is wiped when the
session is delivered (15s grace), when it expires (3 minutes), or when the
visitor cancels.

## Why two parts?

Vercel is serverless: its functions are short-lived and cannot hold the
persistent WebSocket a WhatsApp link needs. So:

- **`web/`** — the page (static). Deploy this to Vercel.
- **`server/`** — a tiny always-on Node server that runs Baileys
  (`@whiskeysockets/baileys` **7.0.0-rc14**, the current `latest`).
  Host it anywhere that can run `node index.js` continuously
  (a VPS, Render, Railway, your own machine…).

The page talks to the server over HTTPS (REST + Server-Sent Events).
Point the page at the server with the **Pair server URL** field, or bake it
in with a query string: `https://your-page.vercel.app/?api=https://your-server.example.com`

## Run the pair server

```bash
cd server
npm install
PORT=8799 node index.js
```

Optional: if the host must go through an HTTP(S) proxy, set `HTTPS_PROXY` —
the server passes it to Baileys as the connection `agent` (never as a fetch
agent; that combination breaks the WhatsApp handshake).

Endpoints:

| Method | Path             | Purpose                                   |
| ------ | ---------------- | ----------------------------------------- |
| POST   | `/api/start`     | `{ phone? }` → `{ id }`, starts a socket  |
| GET    | `/api/events/:id`| SSE stream: qr / pairing / session events |
| POST   | `/api/close/:id` | wipe that session immediately             |
| GET    | `/health`        | `{ ok, active }`                          |

## Deploy the page to Vercel

```bash
npm i -g vercel   # or use npx
vercel deploy --prod
```

`vercel.json` already sets `web/` as the output directory.

## Use the session in a bot

The page gives a **Session ID** (base64) and a **session.json**. With the
bundled helper (`server/use-session-json.js`):

```js
const fs = require('fs');
const { default: makeWASocket } = require('@whiskeysockets/baileys');
const { useSessionJsonAuthState } = require('./use-session-json');

const json = fs.readFileSync('session.json', 'utf8');       // or Buffer.from(sessionId, 'base64').toString('utf8')
const { state, saveCreds } = useSessionJsonAuthState(json, async (updated) => {
  fs.writeFileSync('session.json', updated);                 // your bot's own storage choice
});

const sock = makeWASocket({ auth: state });
sock.ev.on('creds.update', saveCreds);
```

## Security notes

- A session is a full WhatsApp login for that number. The page warns the
  visitor; the server never keeps a copy.
- Anyone who can reach the pair server can link **their own** number only —
  linking still requires physical access to that phone (scan or code entry).
- Put the pair server behind HTTPS before exposing it publicly.
