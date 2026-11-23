# WhatsApp MCP Server (Baileys)

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent — Muse, or any
MCP-capable client — controlled access to a WhatsApp account: read chats and groups,
send messages, media, polls, locations and contact cards, post to Channels
(newsletters), pin/edit/delete messages, manage groups and more.

It connects through a normal linked-device session (the same mechanism as
WhatsApp Web), powered by [Baileys](https://github.com/WhiskeySockets/Baileys).
You pair once with a QR code or pairing code; the session is stored locally and
reused. **Your session never leaves your machine.**

## Tools (44)

**Messaging**

| Tool | What it does |
|---|---|
| `wa_status` | Connection state of the WhatsApp socket |
| `wa_send_text` | Send a text message to a number, group or channel |
| `wa_send_image` | Send an image with an optional caption |
| `wa_send_document` | Send a file as a document (optional display-size override) |
| `wa_send_poll` | Send a poll (2-12 options, optional multi-select) |
| `wa_send_location` | Send a location pin |
| `wa_send_contact` | Send a contact card (vCard) |
| `wa_forward_message` | Forward a message natively (no download/re-upload) |
| `wa_delete_message` | Delete a message (for everyone where permitted) |
| `wa_edit_message` | Edit a sent text message |
| `wa_pin_message` | Pin or unpin a message in a chat or group |
| `wa_react` | React to a message with an emoji |
| `wa_read_messages` | Read recent messages from the local store |
| `wa_recent_chats` | List recent chats |

**Broadcasts**

| Tool | What it does |
|---|---|
| `wa_broadcast_chats` | Send one message to a list of individual chats (max 60, paced) |
| `wa_broadcast_groups` | Send one message to many groups, or every group the account is in (max 60, paced) |
| `wa_broadcast_channels` | Post one update to several channels at once (max 20, paced) |

**Groups**

| Tool | What it does |
|---|---|
| `wa_list_groups` | List groups with names and JIDs |
| `wa_group_metadata` | Full group metadata (participants, admins, settings) |
| `wa_group_create` | Create a group (verifies who actually joined vs. got an invite) |
| `wa_group_rename` | Change the group name |
| `wa_group_set_description` | Set the group description |
| `wa_group_settings` | Announce-only / locked toggles |
| `wa_group_participants` | Add / remove / promote / demote members |
| `wa_group_ephemeral` | Disappearing messages: off / 24h / 7d / 90d |
| `wa_group_join` | Join a group from an invite link |
| `wa_group_leave` | Leave a group |
| `wa_group_requests` | List / approve / reject join requests |
| `wa_group_invite_link` | Get a group's invite link |

**Channels (Newsletters)**

| Tool | What it does |
|---|---|
| `wa_channel_info` | Resolve an invite link to JID, name and followers |
| `wa_create_channel` | Create a channel |
| `wa_update_channel` | Rename a channel / update its description |
| `wa_set_channel_picture` | Set a channel's profile picture |
| `wa_channel_remove_picture` | Remove a channel's profile picture |
| `wa_post_channel` | Post text or an image update to a channel |
| `wa_channel_subscription` | Follow / unfollow / mute / unmute a channel |
| `wa_channel_subscribers` | Subscriber count (identities are never exposed by WhatsApp) |
| `wa_channel_fetch_messages` | Fetch recent channel post updates |
| `wa_channel_admins` | List a channel's admins |
| `wa_channel_delete` | Delete a channel permanently (owner only) |

**Automation**

| Tool | What it does |
|---|---|
| `wa_schedule_send` | Schedule a text to any chat/group/channel — once, daily or weekly |
| `wa_list_scheduled` | List the pending schedule queue |
| `wa_cancel_scheduled` | Cancel a scheduled message |

**Chats & account**

| Tool | What it does |
|---|---|
| `wa_chat_modify` | Archive / pin chat, mute, mark read |
| `wa_block_user` | Block or unblock a number |
| `wa_set_profile_picture` | Set the account's profile picture |
| `wa_get_profile_picture` | Get a user/group profile picture URL |


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
