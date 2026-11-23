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


// ---------------------------------------------------------------------------
// Expansion pack (2026-11-23): group management, broadcasts (chat / group /
// channel), channel management + automation (in-process scheduler).
// All tools are direct Baileys calls — no external plugins required.
// ---------------------------------------------------------------------------

async function resolveChannelJid(s, channel) {
  let jid = String(channel).trim();
  if (jid.endsWith('@newsletter')) return jid;
  const m = jid.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('Channel must be a ...@newsletter JID or an invite link.');
  const info = await s.newsletterMetadata('invite', m[1]);
  jid = info && (info.id || info.jid);
  if (!jid) throw new Error('Could not resolve channel link to a JID.');
  return jid;
}

async function broadcastOne(s, jid, text, image_path) {
  let payload;
  if (image_path) {
    payload = { image: fs.readFileSync(image_path), _skipForwardContext: true };
    if (text) payload.caption = text;
  } else {
    payload = jid.endsWith('@newsletter') ? { text, _skipForwardContext: true } : { text };
  }
  const r = await s.sendMessage(jid, payload);
  return (r && r.key && r.key.id) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Group management -------------------------------------------------------

server.tool('wa_group_create', 'Create a new WhatsApp group with the connected number as admin. participants: phone numbers or JIDs (at least 1).',
  { name: z.string().min(1).max(100),
    participants: z.array(z.string()).min(1).max(100) },
  async ({ name, participants }) => {
    const s = wa.requireSock();
    const jids = participants.map((p) => normJid(p));
    const md = await s.groupCreate(name, jids);
    // The creation response can over-report members: under LID addressing or
    // a user's privacy settings, an added user may only receive an invite.
    // Verify against live metadata and report who is actually in the group.
    let present = null;
    try {
      const live = await s.groupMetadata(md.id);
      present = (live.participants || []).map((p) => p.phoneNumber || p.id);
    } catch (_) {}
    audit('group_create', { name, group: md.id, requested: jids.length });
    return ok({ created: true, group: md.id, name: md.subject || name, members_present: present, note: 'Anyone missing from members_present was sent an invite instead (their privacy settings) and joins when they accept.' });
  });

server.tool('wa_group_rename', 'Change a group subject (name). The connected number must be an admin if the group is locked.',
  { group_jid: z.string(), subject: z.string().min(1).max(100) },
  async ({ group_jid, subject }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    await s.groupUpdateSubject(jid, subject);
    audit('group_rename', { group: jid, subject });
    return ok({ updated: true, group: jid, subject });
  });

server.tool('wa_group_set_description', 'Set or clear a group description. The connected number must be an admin if the group is locked.',
  { group_jid: z.string(), description: z.string().max(2048) },
  async ({ group_jid, description }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    await s.groupUpdateDescription(jid, description);
    audit('group_set_description', { group: jid, len: description.length });
    return ok({ updated: true, group: jid });
  });

server.tool('wa_group_settings', 'Change a group setting: announce = only admins can message; not_announce = everyone can message; locked = only admins can edit group info; unlocked = everyone can edit group info.',
  { group_jid: z.string(), setting: z.enum(['announce', 'not_announce', 'locked', 'unlocked']) },
  async ({ group_jid, setting }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    await s.groupSettingUpdate(jid, setting);
    audit('group_settings', { group: jid, setting });
    return ok({ updated: true, group: jid, setting });
  });

server.tool('wa_group_participants', 'Add, remove, promote or demote group participants. The connected number must be a group admin. Returns the per-participant status codes from WhatsApp.',
  { group_jid: z.string(),
    action: z.enum(['add', 'remove', 'promote', 'demote']),
    participants: z.array(z.string()).min(1).max(100) },
  async ({ group_jid, action, participants }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    let jids = participants.map((p) => normJid(p));
    if (action !== 'add') {
      // Existing members may be stored under LID JIDs — map each requested
      // number to the participant id exactly as the group metadata stores it,
      // otherwise WhatsApp answers 404 for promote/remove/demote.
      try {
        const md = await s.groupMetadata(jid);
        const byPhone = {};
        for (const p of (md.participants || [])) {
          const phone = (p.phoneNumber || p.id || '').split('@')[0].split(':')[0];
          if (phone) byPhone[phone] = p.id;
        }
        jids = jids.map((j) => byPhone[j.split('@')[0].split(':')[0]] || j);
      } catch (_) {}
    }
    const res = await s.groupParticipantsUpdate(jid, jids, action);
    audit('group_participants', { group: jid, action, count: jids.length });
    return ok({ done: true, group: jid, action, results: res });
  });

server.tool('wa_group_ephemeral', 'Set disappearing messages for a group: expiration_seconds 0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days.',
  { group_jid: z.string(), expiration_seconds: z.number().int() },
  async ({ group_jid, expiration_seconds }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    await s.groupToggleEphemeral(jid, expiration_seconds);
    audit('group_ephemeral', { group: jid, expiration_seconds });
    return ok({ updated: true, group: jid, expiration_seconds });
  });

server.tool('wa_group_join', 'Join a group from an invite code or a chat.whatsapp.com/invite link.',
  { invite: z.string() },
  async ({ invite }) => {
    const s = wa.requireSock();
    const m = String(invite).match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/);
    const code = m ? m[1] : String(invite).trim();
    const jid = await s.groupAcceptInvite(code);
    audit('group_join', { group: jid });
    return ok({ joined: true, group: jid });
  });

server.tool('wa_group_leave', 'Leave a group.',
  { group_jid: z.string() },
  async ({ group_jid }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    await s.groupLeave(jid);
    audit('group_leave', { group: jid });
    return ok({ left: true, group: jid });
  });

server.tool('wa_group_requests', 'Manage group join requests: action list shows pending requests; approve/reject take participants (numbers or JIDs). Admin only.',
  { group_jid: z.string(),
    action: z.enum(['list', 'approve', 'reject']),
    participants: z.array(z.string()).optional() },
  async ({ group_jid, action, participants }) => {
    const s = wa.requireSock();
    const jid = String(group_jid).trim();
    if (action === 'list') {
      const reqs = await s.groupRequestParticipantsList(jid);
      return ok({ group: jid, requests: reqs });
    }
    if (!participants || participants.length === 0) throw new Error('participants are required for approve/reject.');
    const jids = participants.map((p) => normJid(p));
    const res = await s.groupRequestParticipantsUpdate(jid, jids, action === 'approve' ? 'approve' : 'reject');
    audit('group_requests', { group: jid, action, count: jids.length });
    return ok({ done: true, group: jid, action, results: res });
  });

// --- Broadcasts --------------------------------------------------------------

server.tool('wa_broadcast_groups', 'Broadcast one message (text, or an image with the text as caption) to many groups at once. Pass group_jids, or all_groups=true to reach every group the account is in. Max 60 targets, sequential with a delay between sends (default 1500 ms) to stay gentle on WhatsApp rate limits.',
  { group_jids: z.array(z.string()).max(60).optional(),
    all_groups: z.boolean().optional(),
    text: z.string().max(4096).optional(),
    image_path: z.string().optional().describe('Absolute path to a local image file'),
    delay_ms: z.number().int().min(300).max(10000).optional() },
  async ({ group_jids, all_groups, text, image_path, delay_ms }) => {
    const s = wa.requireSock();
    if (!text && !image_path) throw new Error('Provide text and/or image_path.');
    let targets = group_jids ? group_jids.map((j) => String(j).trim()) : [];
    if (all_groups) {
      const all = await s.groupFetchAllParticipating();
      targets = Object.keys(all || {});
    }
    targets = [...new Set(targets)].filter((j) => j.endsWith('@g.us')).slice(0, 60);
    if (targets.length === 0) throw new Error('No group targets resolved.');
    const delay = delay_ms || 1500;
    const sent = [];
    const failed = [];
    for (const jid of targets) {
      try { sent.push({ jid, message_id: await broadcastOne(s, jid, text, image_path) }); }
      catch (e) { failed.push({ jid, error: String((e && e.message) || e).slice(0, 200) }); }
      if (delay) await sleep(delay);
    }
    audit('broadcast_groups', { total: targets.length, sent: sent.length, failed: failed.length });
    return ok({ total: targets.length, sent_count: sent.length, failed_count: failed.length, sent, failed });
  });

server.tool('wa_broadcast_chats', 'Broadcast one message (text, or an image with the text as caption) to a list of individual chats (phone numbers or JIDs). Max 60 targets, sequential with a delay between sends (default 1500 ms). Only message people who expect to hear from the account.',
  { numbers: z.array(z.string()).min(1).max(60),
    text: z.string().max(4096).optional(),
    image_path: z.string().optional().describe('Absolute path to a local image file'),
    delay_ms: z.number().int().min(300).max(10000).optional() },
  async ({ numbers, text, image_path, delay_ms }) => {
    const s = wa.requireSock();
    if (!text && !image_path) throw new Error('Provide text and/or image_path.');
    const targets = [...new Set(numbers.map((n) => normJid(n)))].slice(0, 60);
    const delay = delay_ms || 1500;
    const sent = [];
    const failed = [];
    for (const jid of targets) {
      try { checkTarget(jid); sent.push({ jid, message_id: await broadcastOne(s, jid, text, image_path) }); }
      catch (e) { failed.push({ jid, error: String((e && e.message) || e).slice(0, 200) }); }
      if (delay) await sleep(delay);
    }
    audit('broadcast_chats', { total: targets.length, sent: sent.length, failed: failed.length });
    return ok({ total: targets.length, sent_count: sent.length, failed_count: failed.length, sent, failed });
  });

server.tool('wa_broadcast_channels', 'Broadcast one post (text, or an image with the text as caption) to several WhatsApp Channels at once. The connected number must be an ADMIN of each channel. Channels may be JIDs or invite links. Max 20 channels.',
  { channels: z.array(z.string()).min(1).max(20),
    text: z.string().max(4096).optional(),
    image_path: z.string().optional().describe('Absolute path to a local image file'),
    delay_ms: z.number().int().min(300).max(10000).optional() },
  async ({ channels, text, image_path, delay_ms }) => {
    const s = wa.requireSock();
    if (!text && !image_path) throw new Error('Provide text and/or image_path.');
    const delay = delay_ms || 1500;
    const sent = [];
    const failed = [];
    for (const ch of channels) {
      try {
        const jid = await resolveChannelJid(s, ch);
        sent.push({ channel: jid, message_id: await broadcastOne(s, jid, text, image_path) });
      } catch (e) { failed.push({ channel: ch, error: String((e && e.message) || e).slice(0, 200) }); }
      if (delay) await sleep(delay);
    }
    audit('broadcast_channels', { total: channels.length, sent: sent.length, failed: failed.length });
    return ok({ total: channels.length, sent_count: sent.length, failed_count: failed.length, sent, failed });
  });

// --- Channel management ------------------------------------------------------

server.tool('wa_channel_subscription', 'Follow, unfollow, mute or unmute a WhatsApp Channel from the connected account. Channel may be a JID or an invite link.',
  { channel: z.string(), action: z.enum(['follow', 'unfollow', 'mute', 'unmute']) },
  async ({ channel, action }) => {
    const s = wa.requireSock();
    const jid = await resolveChannelJid(s, channel);
    if (action === 'follow') await s.newsletterFollow(jid);
    else if (action === 'unfollow') await s.newsletterUnfollow(jid);
    else if (action === 'mute') await s.newsletterMute(jid);
    else await s.newsletterUnmute(jid);
    audit('channel_subscription', { channel: jid, action });
    return ok({ done: true, channel: jid, action });
  });

server.tool('wa_channel_subscribers', 'Get a WhatsApp Channel subscriber COUNT from its metadata. WhatsApp does not expose subscriber identities to anyone.',
  { channel: z.string() },
  async ({ channel }) => {
    const s = wa.requireSock();
    const jid = await resolveChannelJid(s, channel);
    // The Baileys subscriber-list call is broken upstream (WhatsApp changed
    // the response shape) - report the count from channel metadata instead.
    const info = await s.newsletterMetadata('jid', jid);
    return ok({ channel: jid, name: info ? info.name : null, subscribers_count: info ? (info.subscribers ?? null) : null, note: 'Subscriber identities are not exposed by WhatsApp; only the count is available.' });
  });

server.tool('wa_channel_fetch_messages', 'Fetch recent posts of a WhatsApp Channel (server ids + timestamps) — useful for automation and moderation checks.',
  { channel: z.string(), count: z.number().int().min(1).max(50).optional() },
  async ({ channel, count }) => {
    const s = wa.requireSock();
    const jid = await resolveChannelJid(s, channel);
    const msgs = await s.newsletterFetchMessages(jid, count || 10);
    // Baileys returns the raw IQ node (or undefined when the server has no
    // updates) - hand back a capped preview instead of the raw node.
    let preview = null;
    try { preview = msgs ? JSON.stringify(msgs).slice(0, 4000) : null; } catch (_) {}
    return ok({ channel: jid, has_updates: !!msgs, raw_preview: preview, note: msgs ? undefined : 'The server returned no message updates for this channel.' });
  });

server.tool('wa_channel_remove_picture', 'Remove a WhatsApp Channel\'s profile picture. Admin only.',
  { channel: z.string() },
  async ({ channel }) => {
    const s = wa.requireSock();
    const jid = await resolveChannelJid(s, channel);
    await s.newsletterRemovePicture(jid);
    audit('channel_remove_picture', { channel: jid });
    return ok({ removed: true, channel: jid });
  });

server.tool('wa_channel_delete', 'DELETE a WhatsApp Channel permanently. The connected number must be the channel owner. This cannot be undone.',
  { channel: z.string() },
  async ({ channel }) => {
    const s = wa.requireSock();
    const jid = await resolveChannelJid(s, channel);
    await s.newsletterDelete(jid);
    audit('channel_delete', { channel: jid });
    return ok({ deleted: true, channel: jid });
  });

// --- Automation: scheduled sends ----------------------------------------------

const SCHED_FILE = path.join(__dirname, '..', 'scheduled.json');
function schedLoad() {
  try { const arr = JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8')); return Array.isArray(arr) ? arr : []; } catch (_) { return []; }
}
function schedSave(items) {
  try { fs.writeFileSync(SCHED_FILE, JSON.stringify(items, null, 2)); } catch (_) {}
}
if (!global.__WA_SCHED_STARTED) {
  global.__WA_SCHED_STARTED = true;
  const timer = setInterval(async () => {
    const items = schedLoad();
    if (items.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const it of items) {
      if (it.next_at && it.next_at <= now) {
        try {
          const s = wa.requireSock();
          const payload = String(it.to).endsWith('@newsletter') ? { text: it.text, _skipForwardContext: true } : { text: it.text };
          await s.sendMessage(it.to, payload);
          audit('scheduled_send', { to: it.to, id: it.id, repeat: it.repeat || 'none' });
          if (it.repeat === 'daily') { it.next_at += 24 * 3600 * 1000; }
          else if (it.repeat === 'weekly') { it.next_at += 7 * 24 * 3600 * 1000; }
          else { it.done = true; }
          changed = true;
        } catch (_) { /* not connected yet — retried on the next tick (catch-up) */ }
      }
    }
    const kept = items.filter((i) => !i.done);
    if (changed || kept.length !== items.length) schedSave(kept);
  }, 20000);
  if (timer.unref) timer.unref();
}

server.tool('wa_schedule_send', 'Schedule a text message to any chat, group or channel — once, or repeating daily/weekly. Automation runs inside this server process (checked every 20 seconds; if the server is offline at the due time, the message is sent on the next check after it reconnects). Give at (ISO time) or delay_minutes.',
  { to: z.string().describe('Recipient: phone number or full JID (...@g.us / ...@newsletter)'),
    text: z.string().min(1).max(4096),
    at: z.string().optional().describe('ISO 8601 time, e.g. 2026-11-24T09:00:00+05:00'),
    delay_minutes: z.number().min(1).max(60 * 24 * 30).optional(),
    repeat: z.enum(['none', 'daily', 'weekly']).optional() },
  async ({ to, text, at, delay_minutes, repeat }) => {
    const target = normJid(to);
    checkTarget(target);
    let when;
    if (at) { when = Date.parse(at); if (!when || Number.isNaN(when)) throw new Error('at is not a valid ISO time.'); }
    else if (delay_minutes) { when = Date.now() + Math.round(delay_minutes * 60000); }
    else throw new Error('Give at or delay_minutes.');
    const items = schedLoad();
    const id = 'sch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    items.push({ id, to: target, text, next_at: when, repeat: repeat || 'none', created_at: Date.now() });
    schedSave(items);
    audit('schedule_add', { to: target, id, at: when, repeat: repeat || 'none' });
    return ok({ scheduled: true, id, to: target, next_at: when, next_at_iso: new Date(when).toISOString(), repeat: repeat || 'none' });
  });

server.tool('wa_list_scheduled', 'List all pending scheduled messages (automation queue).',
  {},
  async () => {
    const items = schedLoad().map((i) => ({ ...i, next_at_iso: i.next_at ? new Date(i.next_at).toISOString() : null }));
    return ok({ count: items.length, scheduled: items });
  });

server.tool('wa_cancel_scheduled', 'Cancel a scheduled message by its id (from wa_schedule_send / wa_list_scheduled).',
  { id: z.string() },
  async ({ id }) => {
    const items = schedLoad();
    const kept = items.filter((i) => i.id !== id);
    if (kept.length === items.length) throw new Error('No scheduled message with that id.');
    schedSave(kept);
    audit('schedule_cancel', { id });
    return ok({ cancelled: true, id });
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
    try {
      const info = await s.newsletterCreate(name, description || '');
      audit('create_channel', { name });
      return ok(info);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // Known Baileys parser bug: a new channel has no picture, and the
      // response parser crashes on thread.picture.id AFTER WhatsApp has
      // already created the channel. Report that honestly instead of failing.
      if (/Cannot read properties of null/.test(msg)) {
        audit('create_channel', { name, note: 'created_likely_parse_bug' });
        return ok({ created_likely: true, name, note: 'WhatsApp accepted the creation but the library could not parse the response (known no-picture bug). The channel should appear in the account Channels list - open it there to copy its link/JID. Do not create it again.' });
      }
      throw e;
    }
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
