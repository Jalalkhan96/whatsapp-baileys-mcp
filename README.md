# WhatsApp MCP Server (Baileys)

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent — Muse, or any
MCP-capable client — controlled access to a WhatsApp account: read chats and groups,
send messages, media, polls, locations and contact cards, post to Channels
(newsletters), pin/edit/delete messages, manage groups and more.

It connects through a normal linked-device session (the same mechanism as
WhatsApp Web), powered by [Baileys](https://github.com/WhiskeySockets/Baileys).
You pair once with a QR code or pairing code; the session is stored locally and
reused. **Your session never leaves your machine.**

## Tools (24)

| Tool | What it does |
| --- | --- |
| `wa_status` | Connection status and the connected account |
| `wa_qr` | Current pairing QR (when not yet linked) |
| `wa_profile_picture` | Fetch a user/group profile picture URL |
| `wa_list_chats` | List recent chats |
| `wa_list_groups` | List groups the account is in |
| `wa_group_metadata` | Group subject, participants, admins |
| `wa_send_text` | Send a text message |
| `wa_send_image` | Send an image from a local file |
| `wa_send_document` | Send a document from a local file |
| `wa_send_poll` | Send a poll (2–12 options) |
| `wa_send_location` | Send a location pin |
| `wa_send_contact` | Send a contact card (vCard) |
| `wa_send_reaction` | React to a message with an emoji |
| `wa_pin_message` | Pin / unpin a message for everyone |
| `wa_edit_message` | Edit a message you sent |
| `wa_delete_message` | Delete (revoke) a message you sent, for everyone |
| `wa_group_invite_link` | Get (or revoke + re-issue) a group invite link |
| `wa_chat_modify` | Archive / pin chat / mute / mark read |
| `wa_block_user` | Block / unblock a user |
| `wa_channel_info` | WhatsApp Channel (newsletter) info |
| `wa_post_channel` | Post to a Channel you admin |
| `wa_set_channel_picture` | Set a Channel profile picture |
| `wa_create_channel` | Create a new Channel |
| `wa_update_channel` | Rename a Channel / update its description |

## Quick start

```bash
git clone https://github.com/Jalalkhan96/whatsapp-baileys-mcp.git
cd whatsapp-baileys-mcp
npm install
cp .env.example .env   # optional; set WA_PHONE_NUMBER for pairing-code login
```

### 1. Pair your WhatsApp (one time)

```bash
npm run pair
```

- With `WA_PHONE_NUMBER` set, a **pairing code** is printed: on your phone open
  WhatsApp → Settings → Linked devices → Link a device → *Link with phone number
  instead* → enter the code.
- Without it, a **QR code** is printed in the terminal to scan.

Keep the terminal open until it prints `connected as ...`, then Ctrl+C.
The session is saved to `./session` (override with `WA_SESSION_DIR`).

### 2. Run the server

```bash
npm start
```

The server speaks MCP over **stdio**.

### 3. Connect your AI client

**Muse** — add `.mcp.json` in your project (or run `Muse mcp add`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-baileys-mcp/src/index.js"],
      "env": { "WA_SESSION_DIR": "/absolute/path/to/whatsapp-baileys-mcp/session" }
    }
  }
}
```

Any other MCP client (Claude Desktop, Cursor, etc.) uses the same
command/args/env shape in its MCP configuration.

## Configuration

| Env var | Meaning |
| --- | --- |
| `WA_SESSION_DIR` | Session folder (default `./session`) |
| `WA_PHONE_NUMBER` | Number used for pairing-code login, e.g. `923001234567` |
| `WA_AUTOCONNECT` | `0` = offline mode (tools load, no WhatsApp connection) |
| `WA_SEND_ALLOWLIST` | Comma list of JIDs/numbers allowed as send targets. Empty = allow all — set this if anyone but you can talk to the agent |
| `WA_OWNER_NUMBER` | Owner number, reported by `wa_status` |
| `HTTPS_PROXY` | Optional proxy for the WhatsApp connection |

Every tool call is appended to a local `audit.log` (action + target + message
id — never message contents you did not send through the tools).

## Safety notes

- **Use a secondary number** if you can. This is an unofficial client
  (WhatsApp Web protocol); automated use carries a small account-restriction
  risk, as with any unofficial tool.
- Set `WA_SEND_ALLOWLIST` so the agent can only message targets you choose.
- Never commit or share your `session/` folder — it is a full login to the
  account. It is in `.gitignore` for a reason.
- You are responsible for complying with WhatsApp's Terms of Service and the
  privacy of the people you message.

## Merged / hosted mode

`src/wa-merged.js` is an optional adapter: if your own host application already
owns a Baileys socket, set `WA_MERGED=1` and publish the socket at
`global.__WA_HOST_SOCK`; the MCP tools then run on that shared connection
instead of opening a second one. One session must only ever have one live
connection — never run two copies of the same session at once.

## License

MIT © Jalal Khan
