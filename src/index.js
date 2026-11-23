#!/usr/bin/env node
'use strict';
/*
 * WhatsApp MCP server (Baileys session edition)
 * ----------------------------------------------
 * Gives any MCP-capable agent controlled access to a WhatsApp account:
 * status, chats, groups, 1:1/group messaging and CHANNEL (newsletter)
 * posting — using a Baileys session the owner pairs once.
 *
 * Transport: stdio (standard MCP). Logs go to stderr only.
 *
 * Env:
 *   WA_SESSION_DIR    session folder        (default ./session)
 *   WA_PHONE_NUMBER   number for pairing-code login, e.g. 923001234567
 *   WA_AUTOCONNECT    '0' = offline test mode (no WhatsApp connection)
 *   WA_SEND_ALLOWLIST comma list of JIDs/numbers allowed as send targets.
 *                     Empty = allow all (owner's responsibility).
 *   WA_OWNER_NUMBER   owner number; reported in wa_status.
 */
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const wa = process.env.WA_MERGED === '1' ? require('./wa-merged') : require('./wa');

const AUDIT_FILE = path.join(__dirname, '..', 'audit.log');
function audit(action, detail) {
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ t: new Date().toISOString(), action, detail }) + '\n'); } catch (_) {}
}
const ALLOW = (process.env.WA_SEND_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
function checkTarget(jid) {
  if (ALLOW.length === 0) return;
  const num = String(jid).split('@')[0];
  const ok = ALLOW.some((a) => a === jid || a.replace(/\D/g, '') === num);
  if (!ok) throw new Error('Target ' + jid + ' is not in WA_SEND_ALLOWLIST.');
}
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: 'Error: ' + (e && e.message ? e.message : String(e)) }] });
const normJid = (t) => {
  t = String(t || '').trim();
  if (t.endsWith('@s.whatsapp.net') || t.endsWith('@g.us') || t.endsWith('@newsletter')) return t;
  const digits = t.replace(/\D/g, '');
  return digits + '@s.whatsapp.net';
};

function buildServer() {
const server = new McpServer({ name: 'whatsapp-baileys-mcp', version: '1.0.0' });

server.tool('wa_status', 'Connection status of the WhatsApp session (connected account, pairing state, chats known).',
  {}, async () => ok(Object.assign(wa.getStatus(), { owner_number: process.env.WA_OWNER_NUMBER || undefined })));

server.tool('wa_profile_picture', 'Get the current WhatsApp profile picture URL for a JID (user, group or channel). Returns null when the target has no picture or it is private.',
  { jid: z.string().describe('Full JID ...@s.whatsapp.net / ...@g.us / ...@newsletter, or a phone number') },
  async ({ jid }) => {
    const s = wa.requireSock();
    const target = normJid(jid);
    let url = null;
    try { url = await s.profilePictureUrl(target, 'image'); } catch (_) { url = null; }
    audit('profile_picture', { jid: target, found: !!url });
    return ok({ jid: target, url: url || null });
  });

server.tool('wa_qr', 'Current login QR string (only while status is "qr"). Scan it from a terminal with `npm run pair` for a rendered QR.',
  {}, async () => ok(wa.getQr() ? { qr: wa.getQr() } : { qr: null, note: 'No QR pending. Either already connected, pairing-code mode, or offline.' }));

server.tool('wa_list_chats', 'List known chats (DMs, groups, channels) seen by this session, most recent first.',
  { limit: z.number().int().min(1).max(500).optional() }, async ({ limit }) => {
    const list = wa.getChats()
      .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
      .slice(0, limit || 100);
    return ok(list);
  });

server.tool('wa_list_groups', 'List groups this account is in (id + subject + participant count).',
  {}, async () => {
    const s = wa.requireSock();
    const groups = await s.groupFetchAllParticipating();
    return ok(Object.values(groups).map((g) => ({ id: g.id, subject: g.subject, participants: (g.participants || []).length })));
  });

server.tool('wa_group_metadata', 'Full metadata for one group JID (subject, owner, participants with admin flags).',
  { group_jid: z.string() }, async ({ group_jid }) => ok(await wa.requireSock().groupMetadata(group_jid)));

server.tool('wa_send_text', 'Send a text message to a user number, group JID, or channel JID.',
  { to: z.string().describe('Phone number (e.g. 923001234567), or full JID ...@g.us / ...@newsletter'),
    text: z.string().min(1).max(4096) },
  async ({ to, text }) => {
    const jid = normJid(to);
    checkTarget(jid);
    const payload = jid.endsWith('@newsletter') ? { text, _skipForwardContext: true } : { text };
    const r = await wa.requireSock().sendMessage(jid, payload);
    audit('send_text', { to: jid, len: text.length });
    return ok({ sent: true, to: jid, message_id: r && r.key && r.key.id });
  });

server.tool('wa_send_document', 'Send a document (local file) to a user number or group JID. Optional file_length (bytes) overrides the size WhatsApp displays for the document — the file itself is sent unchanged (used by the -fakedoc prank).',
  { to: z.string().describe('Phone number (e.g. 923001234567), or full JID ...@g.us'),
    file_path: z.string().describe('Absolute path of the local file to send'),
    file_name: z.string().optional().describe('Name shown for the document (default: the file base name)'),
    file_length: z.number().optional().describe('Displayed size in bytes (display only; does not change the file)') },
  async ({ to, file_path, file_name, file_length }) => {
    const jid = normJid(to);
    checkTarget(jid);
    const buf = fs.readFileSync(file_path);
    // _skipForwardContext: documents go out clean — no fake-forward
    // ("Forwarded") header.
    // mimetype MUST be set from the extension: without it Baileys defaults
    // documents to application/pdf (an APK sent from here arrived as a PDF —
    // owner's report 2026-11-20, proto-verified).
    const MIME = { apk: 'application/vnd.android.package-archive', pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', txt: 'text/plain', mp4: 'video/mp4', mp3: 'audio/mpeg', jpg: 'image/jpeg', png: 'image/png', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const shownName = file_name || path.basename(file_path);
    const mimetype = MIME[shownName.split('.').pop().toLowerCase()] || 'application/octet-stream';
    const payload = { document: buf, fileName: shownName, mimetype, _skipForwardContext: true };
    // The displayed size is written exactly as given (owner's order: no clamping).
    let note = null;
    if (file_length) payload.fileLength = file_length;
    const r = await wa.requireSock().sendMessage(jid, payload);
    audit('send_document', { to: jid, file: payload.fileName, real_bytes: buf.length, file_length: file_length || null });
    return ok({ sent: true, to: jid, message_id: r && r.key && r.key.id, real_bytes: buf.length, displayed_bytes: file_length || buf.length, note });
  });

server.tool('wa_send_image', 'Send an image (local file) as a photo with an optional caption to a user number or group JID.',
  { to: z.string().describe('Phone number (e.g. 923001234567), or full JID ...@g.us'),
    file_path: z.string().describe('Absolute path of the local image file to send'),
    caption: z.string().optional().describe('Caption shown under the photo') },
  async ({ to, file_path, caption }) => {
    const jid = normJid(to);
    checkTarget(jid);
    const buf = fs.readFileSync(file_path);
    const payload = { image: buf, _skipForwardContext: true };
    if (caption) payload.caption = caption;
    const r = await wa.requireSock().sendMessage(jid, payload);
    audit('send_image', { to: jid, file: path.basename(file_path), bytes: buf.length });
    return ok({ sent: true, to: jid, message_id: r && r.key && r.key.id });
  });

server.tool('wa_channel_info', 'Resolve a WhatsApp Channel invite link (whatsapp.com/channel/<code>) to its JID, name and follower count.',
  { link: z.string() }, async ({ link }) => {
    const m = String(link).match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
    if (!m) throw new Error('Not a channel invite link.');
    const s = wa.requireSock();
    const info = await s.newsletterMetadata('invite', m[1]);
    if (!info) throw new Error('Channel not found for that invite link.');
    return ok(info);
  });

server.tool('wa_post_channel', 'Post an update to a WhatsApp Channel. The connected number must be an ADMIN of the channel. Accepts a channel JID or invite link. Optionally attach an image (local file path); the text then becomes the image caption.',
  { channel: z.string().describe('...@newsletter JID or https://whatsapp.com/channel/<code>'),
    text: z.string().min(1).max(4096),
    image_path: z.string().optional().describe('Absolute path to a local image file to attach') },
  async ({ channel, text, image_path }) => {
    const s = wa.requireSock();
    let jid = String(channel).trim();
    if (!jid.endsWith('@newsletter')) {
      const m = jid.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
      if (!m) throw new Error('Channel must be a ...@newsletter JID or an invite link.');
      const info = await s.newsletterMetadata('invite', m[1]);
      jid = info && (info.id || info.jid);
      if (!jid) throw new Error('Could not resolve channel link to a JID.');
    }
    checkTarget(jid);
    // _skipForwardContext: channel updates must NEVER carry the bot's fake-forward
    // (forwardedNewsletterMessageInfo) branding — his standing rule, 2026-11-15.
    let content = { text, _skipForwardContext: true };
    if (image_path) {
      const fs = await import('node:fs');
      content = { image: fs.readFileSync(image_path), caption: text, _skipForwardContext: true };
    }
    const r = await s.sendMessage(jid, content);
    audit('post_channel', { channel: jid, len: text.length, image: image_path || undefined });
    return ok({ posted: true, channel: jid, message_id: r && r.key && r.key.id, image: !!image_path });
  });

server.tool('wa_pin_message', 'Pin (or unpin) a message in a WhatsApp chat or group. The message must have been sent by the connected number (fromMe). type: 1 = pin for all (default), 2 = unpin for all.',
  { jid: z.string().describe('Chat/group JID the message lives in'),
    message_id: z.string().describe('Message ID (stanza id) of the message to pin'),
    type: z.number().int().min(1).max(2).optional().describe('1 = pin for all (default), 2 = unpin for all') },
  async ({ jid, message_id, type }) => {
    const s = wa.requireSock();
    const target = String(jid).trim();
    checkTarget(target);
    const key = { remoteJid: target, fromMe: true, id: String(message_id).trim() };
    await s.sendMessage(target, { pin: key, type: type || 1 });
    audit('pin_message', { jid: target, message_id: key.id, type: type || 1 });
    return ok({ pinned: (type || 1) === 1, jid: target, message_id: key.id });
  });

server.tool('wa_delete_message', 'Delete (revoke, for everyone) a message previously sent by the connected number..',
  { jid: z.string().describe('Chat/group JID the message lives in'),
    message_id: z.string().describe('Message ID (stanza id) to delete') },
  async ({ jid, message_id }) => {
    const s = wa.requireSock();
    const target = String(jid).trim();
    checkTarget(target);
    const key = { remoteJid: target, fromMe: true, id: String(message_id).trim() };
    await s.sendMessage(target, { delete: key });
    audit('delete_message', { jid: target, message_id: key.id });
    return ok({ deleted: true, jid: target, message_id: key.id });
  });

server.tool('wa_edit_message', 'Edit the text of a message previously sent by the connected number..',
  { jid: z.string().describe('Chat/group JID the message lives in'),
    message_id: z.string().describe('Message ID (stanza id) to edit'),
    text: z.string().min(1).max(4096).describe('New text') },
  async ({ jid, message_id, text }) => {
    const s = wa.requireSock();
    const target = String(jid).trim();
    checkTarget(target);
    const key = { remoteJid: target, fromMe: true, id: String(message_id).trim() };
    const r = await s.sendMessage(target, { text, edit: key });
    audit('edit_message', { jid: target, message_id: key.id });
    return ok({ edited: true, jid: target, message_id: key.id, new_message_id: (r && r.key && r.key.id) || null });
  });

server.tool('wa_send_poll', 'Send a poll to a chat or group. options: 2-12 choices; selectable_count 1 = single choice (default), >1 = multiple choice up to that many..',
  { to: z.string().describe('Recipient JID or phone/group id'),
    question: z.string().min(1).max(255),
    options: z.array(z.string().min(1).max(100)).min(2).max(12),
    selectable_count: z.number().int().min(1).max(12).optional() },
  async ({ to, question, options, selectable_count }) => {
    const s = wa.requireSock();
    const target = normJid(to);
    checkTarget(target);
    const r = await s.sendMessage(target, { poll: { name: question, values: options, selectableCount: selectable_count || 1 } });
    const mid = (r && r.key && r.key.id) || null;
    audit('send_poll', { to: target, question, options: options.length });
    return ok({ sent: true, to: target, message_id: mid });
  });

server.tool('wa_send_location', 'Send a location pin to a chat or group..',
  { to: z.string().describe('Recipient JID or phone/group id'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().max(120).optional(),
    address: z.string().max(255).optional() },
  async ({ to, latitude, longitude, name, address }) => {
    const s = wa.requireSock();
    const target = normJid(to);
    checkTarget(target);
    const r = await s.sendMessage(target, { location: { degreesLatitude: latitude, degreesLongitude: longitude, ...(name ? { name } : {}), ...(address ? { address } : {}) } });
    const mid = (r && r.key && r.key.id) || null;
    audit('send_location', { to: target, latitude, longitude });
    return ok({ sent: true, to: target, message_id: mid });
  });

server.tool('wa_send_contact', 'Send a contact card (vCard) to a chat or group..',
  { to: z.string().describe('Recipient JID or phone/group id'),
    display_name: z.string().min(1).max(120),
    phone: z.string().describe('Phone number of the contact, international format digits (e.g. 923001234567)') },
  async ({ to, display_name, phone }) => {
    const s = wa.requireSock();
    const target = normJid(to);
    checkTarget(target);
    const digits = String(phone).replace(/\D/g, '');
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:' + display_name.replace(/\n/g, ' ') + '\nTEL;type=CELL;type=VOICE;waid=' + digits + ':+' + digits + '\nEND:VCARD';
    const r = await s.sendMessage(target, { contacts: { displayName: display_name, contacts: [{ vcard }] } });
    const mid = (r && r.key && r.key.id) || null;
    audit('send_contact', { to: target, display_name });
    return ok({ sent: true, to: target, message_id: mid });
  });

server.tool('wa_group_invite_link', 'Get the invite link of a group (the bot must be a member; admin needed to revoke). Set revoke=true to revoke the current link and issue a fresh one..',
  { group_jid: z.string().describe('Group JID ...@g.us'),
    revoke: z.boolean().optional() },
  async ({ group_jid, revoke }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    if (!jid.endsWith('@g.us')) throw new Error('group_jid must be a ...@g.us JID.');
    checkTarget(jid);
    if (revoke) await s.groupRevokeInvite(jid);
    const code = await s.groupInviteCode(jid);
    audit('group_invite_link', { group: jid, revoked: !!revoke });
    return ok({ group: jid, code, link: 'https://chat.whatsapp.com/' + code, revoked: !!revoke });
  });

server.tool('wa_chat_modify', 'Modify a chat from the connected account: archive/unarchive, pin/unpin the CHAT (chat list), mute (mute_hours, default 8) / unmute, mark read/unread..',
  { jid: z.string().describe('Chat/group JID'),
    action: z.enum(['archive', 'unarchive', 'pin', 'unpin', 'mute', 'unmute', 'read', 'unread']),
    mute_hours: z.number().min(0.25).max(24 * 365).optional() },
  async ({ jid, action, mute_hours }) => {
    const s = wa.requireSock();
    const target = normJid(jid);
    let mod;
    if (action === 'archive') mod = { archive: true };
    else if (action === 'unarchive') mod = { archive: false };
    else if (action === 'pin') mod = { pin: true };
    else if (action === 'unpin') mod = { pin: false };
    else if (action === 'mute') mod = { mute: Date.now() + Math.round((mute_hours || 8) * 3600 * 1000) };
    else if (action === 'unmute') mod = { mute: null };
    else if (action === 'read') mod = { markRead: true };
    else mod = { markRead: false };
    await s.chatModify(mod, target);
    audit('chat_modify', { jid: target, action });
    return ok({ modified: true, jid: target, action });
  });

server.tool('wa_block_user', 'Block or unblock a WhatsApp user from the connected account..',
  { jid: z.string().describe('User JID or phone number'),
    action: z.enum(['block', 'unblock']) },
  async ({ jid, action }) => {
    const s = wa.requireSock();
    const target = normJid(jid);
    await s.updateBlockStatus(target, action);
    audit('block_user', { jid: target, action });
    return ok({ done: true, jid: target, action });
  });

server.tool('wa_set_channel_picture', 'Set a WhatsApp Channel profile picture from a local image file. The connected number must be an ADMIN of the channel.',
  { jid: z.string(), image_path: z.string() },
  async ({ jid, image_path }) => {
    const fs = await import('node:fs');
    const buf = fs.readFileSync(image_path);
    await wa.requireSock().newsletterUpdatePicture(jid, buf);
    audit('set_channel_picture', { jid });
    return ok({ updated: true, jid });
  });

server.tool('wa_create_channel', 'Create a new WhatsApp Channel owned by the connected number. Returns the channel metadata (JID, name, invite).',
  { name: z.string().min(1).max(100), description: z.string().max(512).optional() },
  async ({ name, description }) => {
    const s = wa.requireSock();
    const info = await s.newsletterCreate(name, description || '');
    audit('create_channel', { name });
    return ok(info);
  });

server.tool('wa_update_channel', 'Rename a channel and/or update its description. The connected number must be an ADMIN of the channel.',
  { jid: z.string(), name: z.string().min(1).max(100).optional(), description: z.string().max(512).optional() },
  async ({ jid, name, description }) => {
    const s = wa.requireSock();
    if (name) await s.newsletterUpdateName(jid, name);
    if (description) await s.newsletterUpdateDescription(jid, description);
    audit('update_channel', { jid, name: name || undefined });
    return ok({ updated: true, jid });
  });

server.tool('wa_send_reaction', 'React to a message with an emoji.',
  { chat_jid: z.string(), message_id: z.string(), emoji: z.string(), participant: z.string().optional() },
  async ({ chat_jid, message_id, emoji, participant }) => {
    const key = { remoteJid: chat_jid, id: message_id };
    if (participant) key.participant = participant;
    await wa.requireSock().sendMessage(chat_jid, { react: { text: emoji, key } });
    audit('reaction', { chat_jid, message_id, emoji });
    return ok({ reacted: true });
  });

return server;
}

(async () => {
  wa.connect().catch((e) => console.error('[wa-mcp] connect failed:', e.message));
  const port = parseInt(process.env.WA_MCP_HTTP_PORT || '', 10);
  if (port) {
    // Hosted mode: stateless Streamable HTTP transport + /health.
    // Bound to localhost by default — an agent on this host calls the tools;
    // nothing is exposed to the internet.
    const http = require('http');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const host = process.env.WA_MCP_HTTP_HOST || '127.0.0.1';
    const srv = http.createServer(async (req, res) => {
      try {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(wa.getStatus()));
          return;
        }
        if (req.url === '/mcp' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', async () => {
            try {
              const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
              const s = buildServer();
              await s.connect(transport);
              await transport.handleRequest(req, res, JSON.parse(body || '{}'));
              res.on('close', () => { transport.close().catch(() => {}); s.close().catch(() => {}); });
            } catch (e) {
              if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
            }
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      } catch (e) {
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      }
    });
    srv.listen(port, host, () => console.error('[wa-mcp] MCP server ready (http://' + host + ':' + port + '/mcp, health: /health).'));
  } else {
    await buildServer().connect(new StdioServerTransport());
    console.error('[wa-mcp] MCP server ready (stdio).');
  }
})();
