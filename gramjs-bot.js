// gramjs-bot.js — Termux-friendly Telegram userbot with multi-provider LLM
// agent + a no-prefix automation engine layered on top.
//
// Layers:
//   1) Original AI agent loop (preserved from gramjs-bot-2.js)
//   2) Automation engine (./automation-engine.js) — non-AI automations
//   3) AI mode gate: on | off | hybrid
//        on     — DMs go through the LLM (original behavior)
//        off    — LLM is never called; automations + slash/noprefix only
//        hybrid — automations and commands skip AI; DMs still go through AI
//
// Admin commands work WITHOUT a prefix. Slash also works for everyone.

'use strict';

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api, utils } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { NewMessage, DeletedMessage, EditedMessage, ChatAction } = require('teleproto/events');

const engine = require('./automation-engine');

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const downloadDir = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads');
const antidelDir = process.env.ANTIDEL_DIR || path.join(__dirname, 'antidel-cache');
const maxVideoSeconds = Number(process.env.MAX_VIDEO_SECONDS || 60);
const maxHistory = Number(process.env.MAX_HISTORY || 30);
const maxAgentSteps = Number(process.env.MAX_AGENT_STEPS || 8);
const maxRetriesPerRequest = Number(process.env.MAX_RETRIES || 3);
const backoffBaseMs = Number(process.env.BACKOFF_BASE_MS || 2000);

const systemPrompt =
  process.env.SYSTEM_PROMPT ||
  `You are a helpful, friendly personal assistant replying on Telegram.
Keep answers concise and natural, like texting.
You have access to a rich set of Telegram tools — use them when the user asks.
For write actions (sending, reacting, posting, pinning, forwarding) prefer to
confirm intent first if it's destructive or visible to others.`;

let httpTools = [];
try {
  httpTools = process.env.AGENT_TOOLS ? JSON.parse(process.env.AGENT_TOOLS) : [];
} catch (err) {
  console.error('AGENT_TOOLS is not valid JSON:', err.message);
}

let channelConfig = [];
try {
  channelConfig = process.env.AGENT_CHANNELS ? JSON.parse(process.env.AGENT_CHANNELS) : [];
} catch (err) {
  console.error('AGENT_CHANNELS is not valid JSON:', err.message);
}

let userAutomations = {};
try {
  userAutomations = process.env.AUTOMATIONS ? JSON.parse(process.env.AUTOMATIONS) : {};
} catch (err) {
  console.error('AUTOMATIONS is not valid JSON:', err.message);
}

const adminIds = (process.env.AGENT_ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let aiMode = (process.env.AI_MODE || 'hybrid').toLowerCase();
if (!['on', 'off', 'hybrid'].includes(aiMode)) aiMode = 'hybrid';

const sessionString =
  process.env.SESSION_STRING ||
  (fs.existsSync('.session') ? fs.readFileSync('.session', 'utf8').trim() : '');

if (!sessionString) {
  console.log('No session found. Run gramjs-login.js locally first.');
  process.exit(1);
}
if (!apiId || !apiHash) {
  console.log('Missing API_ID or API_HASH.');
  process.exit(1);
}

fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(antidelDir, { recursive: true });

// Load the automation config
const automations = engine.loadAutomations(userAutomations);
for (const a of engine.AUTOMATIONS) {
  if (a.name === 'antidel' && automations.antidel) {
    automations.antidel.dir = automations.antidel.dir || antidelDir;
  }
}

const ctx = {
  client: null, // set after connect
  Api,
  adminIds,
  channelConfig,
  downloadDir,
  automations,
  aiMode,
  _automationTimers: {},
  log: (...args) => console.log('[auto]', ...args),
};

// ──────────────────────────────────────────────────────────────────────────
// LLM Providers — identical to original (Gemini + OpenAI-compatible)
// ──────────────────────────────────────────────────────────────────────────

function loadProviders() {
  if (process.env.AGENT_PROVIDERS) {
    try {
      const arr = JSON.parse(process.env.AGENT_PROVIDERS);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (err) {
      console.error('AGENT_PROVIDERS is not valid JSON:', err.message);
    }
  }
  const shortcuts = [];
  if (process.env.GEMINI_API_KEY) {
    shortcuts.push({
      name: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      format: 'gemini',
    });
  }
  if (process.env.GROQ_API_KEY) {
    shortcuts.push({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      format: 'openai',
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    shortcuts.push({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
      format: 'openai',
    });
  }
  if (process.env.CEREBRAS_API_KEY) {
    shortcuts.push({
      name: 'cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKey: process.env.CEREBRAS_API_KEY,
      model: process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
      format: 'openai',
    });
  }
  if (process.env.OPENAI_API_KEY) {
    shortcuts.push({
      name: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      format: 'openai',
    });
  }
  if (process.env.GITHUB_TOKEN) {
    shortcuts.push({
      name: 'github',
      baseUrl: 'https://models.inference.ai.azure.com',
      apiKey: process.env.GITHUB_TOKEN,
      model: process.env.GITHUB_MODEL || 'gpt-4o',
      format: 'openai',
    });
  }
  return shortcuts;
}

const providers = loadProviders();
const aiEnabled = providers.length > 0 && aiMode !== 'off';
if (aiEnabled) {
  console.log('LLM providers:', providers.map((p) => `${p.name}:${p.model}`).join(', '));
} else if (providers.length === 0) {
  console.log('No LLM provider configured. Bot will run in commands-only mode.');
} else {
  console.log('AI disabled by AI_MODE=off — running in commands-only mode.');
}
console.log(`AI mode: ${aiMode}`);
console.log(`Automations: ${Object.entries(automations).filter(([, v]) => v?.enabled).map(([k]) => k).join(', ') || '(none enabled)'}`);

const conversations = new Map();
const reminders = [];

// ──────────────────────────────────────────────────────────────────────────
// Conversation history helpers
// ──────────────────────────────────────────────────────────────────────────

function getHistory(chatId) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  return conversations.get(chatId);
}
function trimHistory(history) {
  if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
}
function resetHistory(chatId) {
  conversations.delete(chatId);
}

function findChannelConfig(channel) {
  if (!channel) return null;
  const target = channel.startsWith('@') ? channel : `@${channel}`;
  return channelConfig.find((c) => c.channel === channel || c.channel === target) || null;
}
function ensureChannel(channel, flag) {
  const cfg = findChannelConfig(channel);
  if (!cfg) return { error: `${channel} is not in AGENT_CHANNELS.` };
  if (flag && !cfg[flag]) return { error: `${flag} is not enabled for ${channel}.` };
  return { cfg };
}

// ──────────────────────────────────────────────────────────────────────────
// Slash / no-prefix command dispatch
// ──────────────────────────────────────────────────────────────────────────

const SLASH_HELP = `Commands (slash or no-prefix for admins):
/help              — this message
/tools             — list LLM tools
/automations       — show all automation status
/mode [on|off|hybrid] — AI mode toggle
/reset             — clear DM chat history
/ping              — health check
/whoami            — your Telegram ID + admin status

Automation commands (admin, no prefix needed):
  autolike [on|off|emojis <...>]
  autoreact [on|off|add <pat> <em...>|clear]
  autopost [on|off|target <chat>|add <src>|remove <src>|run]
  autosave [on|off|types <photo,video,...>]
  antidel [on|off|cache]
  antiedit [on|off]
  autoreply [on|off|add <pat> <text>|clear]
  autoforward [on|off|target <chat>|match <pat>]
  autopurge [on|off|<seconds>]
  autoread [on|off]
  autotyping [on|off]
  autobio [on|off|add <text>|interval <min>]
  antiraid [on|off|threshold <n>]
  scheduler [on|off|add <cron> <chat> <text>|list|remove <i>]
  zipchannel <@channel|id> [max]   (or extractchannel / dumpchannel)

AI mode: ${aiMode}`;

function runSlashBuiltin(client, msg, command, args, isAdmin) {
  switch (command) {
    case 'help':
      return SLASH_HELP;
    case 'tools': {
      if (!aiEnabled) return 'AI disabled — no LLM tools available.';
      const names = ALL_TOOL_NAMES.join(', ');
      return `LLM tools (${ALL_TOOL_NAMES.length}):\n${names}\n\nChannel config: ${
        channelConfig.map((c) => c.channel).join(', ') || 'none'
      }\nAdmin: ${isAdmin ? 'yes' : 'no'}`;
    }
    case 'reset':
      resetHistory(String(msg.chatId));
      return 'Cleared. Fresh start.';
    case 'ping':
      return `pong — ${new Date().toISOString()}`;
    case 'whoami': {
      const senderId = String(msg.senderId || msg.fromId?.userId || '');
      return `Your Telegram ID: ${senderId}\nAdmin: ${adminIds.includes(senderId) ? 'yes' : 'no'}`;
    }
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP tool executor (user-defined AGENT_TOOLS)
// ──────────────────────────────────────────────────────────────────────────

async function callHttpTool(tool, args) {
  let url = tool.url;
  for (const [key, value] of Object.entries(args || {})) {
    url = url.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  const options = {
    method: tool.method || 'GET',
    headers: { ...(tool.headers || {}) },
  };
  if ((tool.method || 'GET').toUpperCase() === 'POST') {
    options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
    options.body = JSON.stringify(args || {});
  }
  const res = await fetch(url, options);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 2000) }; }
}

// ──────────────────────────────────────────────────────────────────────────
// Native Telegram tool implementations (unchanged from original)
// ──────────────────────────────────────────────────────────────────────────

async function execTelegramTool(client, name, args, tctx) {
  const isAdmin = tctx.isAdmin;
  const senderId = tctx.senderId;

  switch (name) {
    case 'send_message': {
      if (!args.chat) return { error: 'chat is required' };
      await client.sendMessage(args.chat, { message: args.text || '' });
      return { ok: true };
    }
    case 'reply_to_message': {
      if (!args.chat) return { error: 'chat is required' };
      if (!args.messageId) return { error: 'messageId is required' };
      await client.sendMessage(args.chat, { message: args.text || '', replyTo: args.messageId });
      return { ok: true };
    }
    case 'get_chat_history': {
      const messages = await client.getMessages(args.chat, { limit: args.limit || 20 });
      return {
        items: messages.map((m) => ({
          id: m.id, date: m.date, senderId: m.senderId,
          text: (m.message || '').slice(0, 1000), hasMedia: !!m.media,
        })),
      };
    }
    case 'get_me': {
      const me = await client.getMe();
      return { id: me.id, username: me.username, firstName: me.firstName, phone: me.phone };
    }
    case 'set_typing': {
      try {
        await client.invoke(new Api.messages.SetTyping({
          peer: args.chat, action: new Api.SendMessageTypingAction(),
        }));
      } catch {}
      return { ok: true };
    }
    case 'search_messages': {
      const result = await client.invoke(new Api.messages.Search({
        peer: args.peer || 'global', q: args.query || '', limit: args.limit || 20,
        filter: new Api.InputMessagesFilterEmpty(),
      }));
      const items = (result.messages || []).map((m) => ({
        id: m.id, chatId: m.peerId, date: m.date, text: (m.message || '').slice(0, 500),
      }));
      return { count: items.length, items };
    }
    case 'resolve_username': {
      try {
        const res = await client.invoke(new Api.contacts.ResolveUsername({ username: String(args.username || '').replace(/^@/, '') }));
        const peer = res.peer;
        return {
          type: peer.className === 'PeerUser' ? 'user' : peer.className === 'PeerChat' ? 'group' : 'channel',
          id: peer.userId || peer.chatId || peer.channelId,
          user: res.users?.[0] ? { id: res.users[0].id, firstName: res.users[0].firstName, lastName: res.users[0].lastName, username: res.users[0].username } : null,
          chat: res.chats?.[0] ? { id: res.chats[0].id, title: res.chats[0].title, username: res.chats[0].username } : null,
        };
      } catch (e) { return { error: e.message }; }
    }
    case 'get_user_info': {
      try {
        const res = await client.invoke(new Api.users.GetFullUser({ id: args.userId }));
        const u = res.users[0]; const f = res.fullUser;
        return { id: u?.id, firstName: u?.firstName, lastName: u?.lastName, username: u?.username, bio: f?.about, isBot: u?.bot };
      } catch (e) { return { error: e.message }; }
    }
    case 'get_dialogs': {
      const dialogs = await client.getDialogs({ limit: args.limit || 30 });
      return { items: dialogs.map((d) => ({ id: d.id, name: d.name, isGroup: d.isGroup, isChannel: d.isChannel, unreadCount: d.unreadCount })) };
    }
    case 'list_channel_media': {
      const gate = ensureChannel(args.channel, 'canPullMedia');
      if (gate.error) return gate;
      const messages = await client.getMessages(args.channel, { limit: args.limit || 20 });
      const items = messages.filter((m) => m.media).map((m) => ({
        id: m.id, date: m.date, caption: (m.message || '').slice(0, 500),
        type: m.video ? 'video' : m.photo ? 'photo' : 'other',
        durationSeconds: m.video?.attributes?.find((a) => a.duration != null)?.duration ?? null,
      })).filter((m) => !gate.cfg.maxVideoSeconds || m.type !== 'video' || (m.durationSeconds ?? 0) <= gate.cfg.maxVideoSeconds);
      return { items };
    }
    case 'get_channel_info': {
      const gate = ensureChannel(args.channel);
      if (gate.error) return gate;
      const res = await client.invoke(new Api.channels.GetFullChannel({ channel: args.channel }));
      const c = res.chats[0]; const f = res.fullChat;
      return { id: c?.id, title: c?.title, username: c?.username, participants: f?.participantsCount, about: f?.about, linkedChatId: f?.linkedChatId };
    }
    case 'react_to_message': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canReact');
      if (gate.error) return gate;
      try {
        await client.invoke(new Api.messages.SendReaction({
          peer: args.channel, msgId: args.messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: args.emoji })],
        }));
        return { ok: true };
      } catch (e) { return { error: e.message }; }
    }
    case 'comment_on_post': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canComment');
      if (gate.error) return gate;
      const full = await client.invoke(new Api.channels.GetFullChannel({ channel: args.channel }));
      const linkedId = full.fullChat.linkedChatId;
      if (!linkedId) return { error: 'This channel has no linked discussion group.' };
      await client.sendMessage(linkedId, { message: args.text, replyTo: args.messageId });
      return { ok: true };
    }
    case 'forward_post': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canForward');
      if (gate.error) return gate;
      if (!args.to) return { error: 'to is required' };
      const messages = await client.getMessages(args.channel, { ids: [args.messageId] });
      if (!messages?.length) return { error: 'message not found' };
      await client.forwardMessages(args.to, { messages: messages });
      return { ok: true };
    }
    case 'pin_message':
    case 'unpin_message': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canPin');
      if (gate.error) return gate;
      try {
        await client.invoke(new Api.messages.UpdatePinnedMessage({
          peer: args.channel, id: args.messageId, unpin: name === 'unpin_message',
        }));
        return { ok: true };
      } catch (e) { return { error: e.message }; }
    }
    case 'post_to_channel': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canPost');
      if (gate.error) return gate;
      const messageOpts = { message: args.text || '' };
      if (args.mediaUrl) {
        const filename = path.basename(new URL(args.mediaUrl).pathname);
        const localPath = path.join(downloadDir, `up_${Date.now()}_${filename}`);
        const res = await fetch(args.mediaUrl);
        if (!res.ok) return { error: `failed to download media: HTTP ${res.status}` };
        fs.writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
        messageOpts.file = localPath;
      }
      await client.sendMessage(args.channel, messageOpts);
      return { ok: true };
    }
    case 'download_media': {
      if (!args.chat) return { error: 'chat is required' };
      if (!args.messageId) return { error: 'messageId is required' };
      const messages = await client.getMessages(args.chat, { ids: [args.messageId] });
      const m = messages?.[0];
      if (!m || !m.media) return { error: 'no media on that message' };
      const buffer = await client.downloadMedia(m, {});
      if (!buffer) return { error: 'download returned empty' };
      const filename = `${m.id}_${Date.now()}`;
      const localPath = path.join(downloadDir, filename);
      fs.writeFileSync(localPath, buffer);
      return { ok: true, path: localPath, bytes: buffer.length };
    }
    case 'send_photo':
    case 'send_video':
    case 'send_document': {
      if (!isAdmin) return { error: 'admin-only action' };
      if (!args.chat) return { error: 'chat is required' };
      if (!args.filePath && !args.fileUrl) return { error: 'filePath or fileUrl is required' };
      let filePath = args.filePath;
      if (!filePath) {
        const filename = path.basename(new URL(args.fileUrl).pathname);
        filePath = path.join(downloadDir, `dl_${Date.now()}_${filename}`);
        const res = await fetch(args.fileUrl);
        if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
        fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
      }
      await client.sendFile(args.chat, { file: filePath, message: args.caption || '' });
      return { ok: true };
    }
    case 'send_voice': {
      if (!isAdmin) return { error: 'admin-only action' };
      if (!args.chat) return { error: 'chat is required' };
      if (!args.filePath && !args.fileUrl) return { error: 'filePath or fileUrl is required' };
      let filePath = args.filePath;
      if (!filePath) {
        const filename = path.basename(new URL(args.fileUrl).pathname);
        filePath = path.join(downloadDir, `voice_${Date.now()}_${filename}`);
        const res = await fetch(args.fileUrl);
        if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
        fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
      }
      await client.sendFile(args.chat, { file: filePath, voiceNote: true });
      return { ok: true };
    }
    case 'translate_text': return await translateText(args.text, args.target || 'en');
    case 'summarize_chat': {
      const messages = await client.getMessages(args.chat, { limit: args.limit || 50 });
      const text = messages.map((m) => `[${m.date}] ${m.senderId || '?'}: ${m.message || ''}`).join('\n');
      return await summarizeText(text, args.focus);
    }
    case 'schedule_reminder': {
      if (!args.when) return { error: 'when is required (ISO date or relative like "in 5m")' };
      if (!args.text) return { error: 'text is required' };
      const fireAt = parseWhen(args.when);
      if (!fireAt) return { error: `could not parse "when": ${args.when}` };
      const chatId = args.chat || String(tctx.chatId);
      const delay = Math.max(0, fireAt - Date.now());
      const entry = { fireAt, chatId, text: args.text, timer: null };
      entry.timer = setTimeout(async () => {
        try { await client.sendMessage(chatId, { message: `⏰ Reminder: ${args.text}` }); }
        catch (e) { console.error('reminder send failed:', e.message); }
        const idx = reminders.indexOf(entry);
        if (idx !== -1) reminders.splice(idx, 1);
      }, delay);
      reminders.push(entry);
      return { ok: true, fireAt: new Date(fireAt).toISOString(), delaySeconds: Math.round(delay / 1000) };
    }
    case 'list_reminders': {
      return { items: reminders.map((r) => ({ fireAt: new Date(r.fireAt).toISOString(), chatId: r.chatId, text: r.text })) };
    }
    case 'cancel_reminder': {
      const idx = reminders.findIndex((r) => r.text === args.text && r.chatId === String(tctx.chatId));
      if (idx === -1) return { error: 'no matching reminder' };
      clearTimeout(reminders[idx].timer);
      reminders.splice(idx, 1);
      return { ok: true };
    }
    default:
      return { error: `Unknown native tool: ${name}` };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Time parser
// ──────────────────────────────────────────────────────────────────────────

function parseWhen(input) {
  if (!input) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) { const t = Date.parse(input); return Number.isFinite(t) ? t : null; }
  const m = String(input).trim().match(/^in\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
  if (m) {
    const n = Number(m[1]); const unit = m[2].toLowerCase();
    const ms = unit.startsWith('s') ? n * 1000 : unit.startsWith('m') ? n * 60_000 : unit.startsWith('h') ? n * 3_600_000 : n * 86_400_000;
    return Date.now() + ms;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// LLM layer (identical to original)
// ──────────────────────────────────────────────────────────────────────────

function internalToProvider(provider, internal) {
  if (provider.format === 'gemini') {
    const contents = [];
    for (const m of internal.messages) {
      if (m.role === 'tool') {
        contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response: typeof m.content === 'string' ? safeJsonParse(m.content) : m.content } }] });
      } else if (m.role === 'assistant') {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        if (m.tool_calls?.length) for (const tc of m.tool_calls) parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
        contents.push({ role: 'model', parts });
      } else {
        contents.push({ role: 'user', parts: [{ text: m.content || '' }] });
      }
    }
    const body = { contents };
    if (internal.system) body.system_instruction = { parts: [{ text: internal.system }] };
    if (internal.tools?.length) body.tools = [{ functionDeclarations: internal.tools }];
    return body;
  }
  const messages = [];
  if (internal.system) messages.push({ role: 'system', content: internal.system });
  for (const m of internal.messages) {
    if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc, i) => ({ id: tc.id || `call_${Date.now()}_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
      }
      messages.push(msg);
    } else {
      messages.push({ role: m.role, content: m.content || '' });
    }
  }
  const body = { model: provider.model, messages };
  if (internal.tools?.length) {
    body.tools = internal.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  return body;
}

function providerToInternal(provider, raw) {
  if (provider.format === 'gemini') {
    const parts = raw?.candidates?.[0]?.content?.parts || [];
    let text = ''; const toolCalls = [];
    for (const p of parts) {
      if (p.text) text += p.text;
      if (p.functionCall) toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, name: p.functionCall.name, args: p.functionCall.args || {} });
    }
    return { text: text.trim() || null, toolCalls };
  }
  const choice = raw?.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function?.name, args: safeJsonParse(tc.function?.arguments) || {} }));
  return { text: msg.content || null, toolCalls };
}

function safeJsonParse(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

async function callProviderOnce(provider, internal) {
  const body = internalToProvider(provider, internal);
  let url, headers;
  if (provider.format === 'gemini') {
    url = `${provider.baseUrl}/${provider.model}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': provider.apiKey };
  } else {
    url = `${provider.baseUrl}/chat/completions`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` };
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) {
    const err = new Error(`${provider.name} ${res.status}: ${txt.slice(0, 500)}`); err.status = res.status; err.provider = provider.name; throw err;
  }
  if (!txt) throw Object.assign(new Error(`${provider.name} returned empty response body`), { status: 502, provider: provider.name });
  let parsed; try { parsed = JSON.parse(txt); } catch (err) { throw Object.assign(new Error(`${provider.name} returned non-JSON: ${txt.slice(0, 200)}`), { status: 502, provider: provider.name }); }
  return providerToInternal(provider, parsed);
}

async function callModel(internal) {
  let lastErr;
  for (const provider of providers) {
    for (let attempt = 0; attempt < maxRetriesPerRequest; attempt++) {
      try { return await callProviderOnce(provider, internal); }
      catch (err) {
        lastErr = err;
        const retryable = err.status === 429 || (err.status >= 500 && err.status < 600);
        console.warn(`[${provider.name}] ${err.status || 'ERR'}: ${(err.message || '').slice(0, 200)}`);
        if (!retryable) throw err;
        if (attempt < maxRetriesPerRequest - 1) {
          const wait = backoffBaseMs * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    console.warn(`[${provider.name}] exhausted retries, falling through.`);
  }
  throw lastErr || new Error('All providers failed.');
}

async function callModelPlain(prompt, systemOverride) {
  const internal = { system: systemOverride || 'You are a helpful assistant. Follow the user instructions exactly.', messages: [{ role: 'user', content: prompt }] };
  const result = await callModel(internal);
  return result.text || '';
}

async function translateText(text, target) {
  if (!text) return { error: 'text is required' };
  const out = await callModelPlain(`Translate the following to ${target}. Return ONLY the translation, no preamble, no quotes.\n\n${text}`);
  return { translation: out };
}

async function summarizeText(text, focus) {
  if (!text) return { error: 'empty text' };
  const prompt = focus ? `Summarize the following chat messages, focusing on: ${focus}. Be concise.\n\n${text}` : `Summarize the following chat messages in 5-8 bullet points.\n\n${text}`;
  const out = await callModelPlain(prompt);
  return { summary: out };
}

// ──────────────────────────────────────────────────────────────────────────
// Tool schemas (LLM tools — unchanged from original)
// ──────────────────────────────────────────────────────────────────────────

const telegramToolSchemas = [
  { name: 'send_message', description: 'Send a message to any chat, group, or channel.', parameters: { type: 'object', properties: { chat: { type: 'string' }, text: { type: 'string' } }, required: ['chat', 'text'] } },
  { name: 'reply_to_message', description: 'Reply to a specific message id in a chat.', parameters: { type: 'object', properties: { chat: { type: 'string' }, messageId: { type: 'number' }, text: { type: 'string' } }, required: ['chat', 'messageId', 'text'] } },
  { name: 'get_chat_history', description: 'Fetch recent messages from a chat.', parameters: { type: 'object', properties: { chat: { type: 'string' }, limit: { type: 'number' } }, required: ['chat'] } },
  { name: 'get_me', description: 'Return info about the logged-in account.', parameters: { type: 'object', properties: {} } },
  { name: 'set_typing', description: 'Show typing indicator in a chat.', parameters: { type: 'object', properties: { chat: { type: 'string' } }, required: ['chat'] } },
  { name: 'search_messages', description: 'Search messages globally or in a chat.', parameters: { type: 'object', properties: { query: { type: 'string' }, peer: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'resolve_username', description: 'Resolve a @username to a user/chat id.', parameters: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] } },
  { name: 'get_user_info', description: 'Get profile info for a user by id.', parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] } },
  { name: 'get_dialogs', description: 'List recent chats.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'list_channel_media', description: 'List recent media from an allowed channel.', parameters: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] } },
  { name: 'get_channel_info', description: 'Get metadata about an allowed channel.', parameters: { type: 'object', properties: { channel: { type: 'string' } }, required: ['channel'] } },
  { name: 'react_to_message', description: 'React to a message in an allowed channel. Admin only.', parameters: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'number' }, emoji: { type: 'string' } }, required: ['channel', 'messageId', 'emoji'] } },
  { name: 'comment_on_post', description: 'Comment on a channel post via discussion group. Admin only.', parameters: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'number' }, text: { type: 'string' } }, required: ['channel', 'messageId', 'text'] } },
  { name: 'forward_post', description: 'Forward a channel post. Admin only.', parameters: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'number' }, to: { type: 'string' } }, required: ['channel', 'messageId', 'to'] } },
  { name: 'pin_message', description: 'Pin a message. Admin only.', parameters: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'number' } }, required: ['channel', 'messageId'] } },
  { name: 'unpin_message', description: 'Unpin a message. Admin only.', parameters: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'number' } }, required: ['channel', 'messageId'] } },
  { name: 'post_to_channel', description: 'Post to an allowed channel. Admin only.', parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, mediaUrl: { type: 'string' } }, required: ['channel', 'text'] } },
  { name: 'download_media', description: 'Download media from a message to disk.', parameters: { type: 'object', properties: { chat: { type: 'string' }, messageId: { type: 'number' } }, required: ['chat', 'messageId'] } },
  { name: 'send_photo', description: 'Send a photo. Admin only.', parameters: { type: 'object', properties: { chat: { type: 'string' }, filePath: { type: 'string' }, fileUrl: { type: 'string' }, caption: { type: 'string' } }, required: ['chat'] } },
  { name: 'send_video', description: 'Send a video. Admin only.', parameters: { type: 'object', properties: { chat: { type: 'string' }, filePath: { type: 'string' }, fileUrl: { type: 'string' }, caption: { type: 'string' } }, required: ['chat'] } },
  { name: 'send_document', description: 'Send a document. Admin only.', parameters: { type: 'object', properties: { chat: { type: 'string' }, filePath: { type: 'string' }, fileUrl: { type: 'string' }, caption: { type: 'string' } }, required: ['chat'] } },
  { name: 'send_voice', description: 'Send a voice note. Admin only.', parameters: { type: 'object', properties: { chat: { type: 'string' }, filePath: { type: 'string' }, fileUrl: { type: 'string' } }, required: ['chat'] } },
  { name: 'translate_text', description: 'Translate text via LLM.', parameters: { type: 'object', properties: { text: { type: 'string' }, target: { type: 'string' } }, required: ['text'] } },
  { name: 'summarize_chat', description: 'Summarize recent chat messages.', parameters: { type: 'object', properties: { chat: { type: 'string' }, limit: { type: 'number' }, focus: { type: 'string' } }, required: ['chat'] } },
  { name: 'schedule_reminder', description: 'Schedule a reminder.', parameters: { type: 'object', properties: { when: { type: 'string' }, text: { type: 'string' }, chat: { type: 'string' } }, required: ['when', 'text'] } },
  { name: 'list_reminders', description: 'List scheduled reminders.', parameters: { type: 'object', properties: {} } },
  { name: 'cancel_reminder', description: 'Cancel a scheduled reminder.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

const ALL_TOOL_NAMES = [
  ...telegramToolSchemas.map((t) => t.name),
  ...httpTools.map((t) => t.name),
];

// ──────────────────────────────────────────────────────────────────────────
// Agent loop
// ──────────────────────────────────────────────────────────────────────────

function historyToMessages(history) {
  const out = [];
  for (const entry of history) {
    if (entry.role === 'user') {
      const text = (entry.parts || []).map((p) => p.text || '').join('');
      const fr = (entry.parts || []).find((p) => p.functionResponse);
      if (fr) {
        out.push({ role: 'tool', tool_call_id: fr.functionResponse.tool_call_id || `tr_${out.length}`, name: fr.functionResponse.name, content: JSON.stringify(fr.functionResponse.response || {}) });
      } else {
        out.push({ role: 'user', content: text });
      }
    } else if (entry.role === 'model') {
      const text = (entry.parts || []).map((p) => p.text || '').join('');
      const fc = (entry.parts || []).find((p) => p.functionCall);
      if (fc) {
        out.push({ role: 'assistant', content: text || null, tool_calls: [{ id: `call_${out.length}_${Date.now()}`, name: fc.functionCall.name, args: fc.functionCall.args || {} }] });
      } else {
        out.push({ role: 'assistant', content: text });
      }
    }
  }
  return out;
}

async function runAgent(client, actx, userText) {
  const { chatId, isAdmin, senderId } = actx;
  const history = getHistory(chatId);
  history.push({ role: 'user', parts: [{ text: userText }] });

  const availableTools = [
    ...telegramToolSchemas,
    ...httpTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  ];

  for (let step = 0; step < maxAgentSteps; step++) {
    const internal = { system: systemPrompt, messages: historyToMessages(history), tools: availableTools };
    let result;
    try { result = await callModel(internal); }
    catch (err) { return `Model error: ${err.message}`; }

    if (!result.toolCalls?.length) {
      const reply = result.text || "Hmm, didn't quite catch that.";
      history.push({ role: 'model', parts: [{ text: reply }] });
      trimHistory(history);
      return reply;
    }

    const tc = result.toolCalls[0];
    if (!tc.name) return 'Model returned an empty tool call.';
    history.push({ role: 'model', parts: [{ functionCall: { name: tc.name, args: tc.args || {} } }] });

    let execResult;
    try {
      const isHttp = httpTools.some((t) => t.name === tc.name);
      if (isHttp) {
        const tool = httpTools.find((t) => t.name === tc.name);
        execResult = await callHttpTool(tool, tc.args);
      } else if (telegramToolSchemas.some((t) => t.name === tc.name)) {
        execResult = await execTelegramTool(client, tc.name, tc.args || {}, { isAdmin, senderId, chatId });
      } else {
        execResult = { error: `Unknown tool: ${tc.name}` };
      }
    } catch (err) { execResult = { error: err.message }; }

    history.push({ role: 'user', parts: [{ functionResponse: { name: tc.name, response: { result: execResult }, tool_call_id: tc.id } }] });
    trimHistory(history);
  }
  return 'That took too many steps — try rephrasing or /reset to clear context.';
}

// ──────────────────────────────────────────────────────────────────────────
// Automation dispatcher
// ──────────────────────────────────────────────────────────────────────────

async function runAutomationsOnMessage(msg) {
  // Run every enabled automation that has an onMessage hook
  for (const a of engine.AUTOMATIONS) {
    if (!a.onMessage) continue;
    const cfg = automations[a.name];
    if (!cfg?.enabled) continue;
    try { await a.onMessage(ctx, msg, cfg); } catch (e) { ctx.log(`${a.name} onMessage error: ${e.message}`); }
  }
  // Also call init()'s onMessage hooks (e.g. autopost live mirror)
  for (const [name, hooks] of Object.entries(ctx._automationHooks || {})) {
    if (hooks?.onMessage) {
      try { await hooks.onMessage(msg); } catch (e) { ctx.log(`${name} hook error: ${e.message}`); }
    }
  }
}

async function runAutomationsOnDelete(deletedEntries) {
  for (const a of engine.AUTOMATIONS) {
    if (!a.onDelete) continue;
    const cfg = automations[a.name];
    if (!cfg?.enabled) continue;
    try { await a.onDelete(ctx, deletedEntries, cfg); } catch (e) { ctx.log(`${a.name} onDelete error: ${e.message}`); }
  }
}

async function runAutomationsOnEdit(msg) {
  for (const a of engine.AUTOMATIONS) {
    if (!a.onEdit) continue;
    const cfg = automations[a.name];
    if (!cfg?.enabled) continue;
    try { await a.onEdit(ctx, msg, cfg); } catch (e) { ctx.log(`${a.name} onEdit error: ${e.message}`); }
  }
}

async function runAutomationsOnService(msg) {
  for (const [name, hooks] of Object.entries(ctx._automationHooks || {})) {
    if (hooks?.onService) {
      try { await hooks.onService(msg); } catch (e) { ctx.log(`${name} onService error: ${e.message}`); }
    }
  }
}

async function tryAutomationCommand(client, msg, isAdmin, text) {
  // Only admins can run no-prefix commands
  const resolved = engine.resolveCommand(text);
  if (!resolved) return null;
  const automation = engine.TRIGGER_MAP.get(resolved.name);
  if (!automation?.command) return null;
  // Built-in slash commands like /help, /ping, /reset are handled in handleMessage
  // for everyone; for admin no-prefix, only automation commands are allowed.
  if (!isAdmin) return null;
  try {
    const reply = await automation.command.handler(
      { client, chatId: msg.chatId, automations, adminIds, channelConfig, downloadDir, aiMode, log: ctx.log, _automationTimers: ctx._automationTimers },
      resolved.args
    );
    if (reply != null) {
      await client.sendMessage(msg.chatId, { message: String(reply), replyTo: msg.id });
      return true;
    }
  } catch (e) {
    await client.sendMessage(msg.chatId, { message: `error: ${e.message}`, replyTo: msg.id });
    return true;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Main message handler
// ──────────────────────────────────────────────────────────────────────────

async function handleMessage(client, msg) {
  if (!msg?.message) return;
  if (msg.out) return; // ignore our own outgoing

  const sender = await msg.getSender();
  const senderId = String(sender?.id ?? '');
  const isAdmin = adminIds.includes(senderId);
  const chatId = String(msg.chatId);
  const text = msg.message.trim();

  // ── Phase 1: always run message-driven automations (autolike, autosave, antidel, etc.)
  // These run for ALL chats (not just DMs) and don't need admin.
  await runAutomationsOnMessage(msg);

  // ── Phase 2: command dispatch
  // Admins: any message matching a known automation command runs it, no prefix needed.
  // Slash commands work for everyone (built-ins go to runSlashBuiltin).
  if (isAdmin) {
    const handled = await tryAutomationCommand(client, msg, isAdmin, text);
    if (handled) return;
  }

  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const reply = runSlashBuiltin(client, msg, cmd.toLowerCase(), rest, isAdmin);
    if (reply) {
      try { await client.sendMessage(msg.chatId, { message: reply, replyTo: msg.id }); } catch (e) { console.error('slash reply failed:', e.message); }
      return;
    }
  }

  // ── Phase 3: AI agent
  // Only in DMs (original behavior) and only if AI is enabled.
  if (aiMode === 'off') return; // commands-only mode
  if (!msg.isPrivate) return; // original: DMs only
  if (!aiEnabled) return;

  // Show typing
  try {
    await client.invoke(new Api.messages.SetTyping({ peer: msg.chatId, action: new Api.SendMessageTypingAction() }));
  } catch {}

  let reply;
  try { reply = await runAgent(client, { chatId, isAdmin, senderId }, text); }
  catch (err) { reply = `Sorry, something blew up: ${err.message}`; console.error('runAgent error:', err); }

  try { await client.sendMessage(msg.chatId, { message: reply, replyTo: msg.id }); }
  catch (err) { console.error('sendMessage failed:', err.message); }
}

async function handleDelete(client, event) {
  // teleproto DeletedMessage event: { deletedIds: number[], peer?: EntityLike, isChannel?: boolean }
  // For private chats, Telegram doesn't tell us which chat — so we scan the antidel cache.
  const ids = event.deletedIds || [];
  if (!ids.length) return;
  const peerId = event.peer ? (event.peer.userId || event.peer.chatId || event.peer.channelId) : null;
  const entries = [];

  if (peerId) {
    // Channel/supergroup case: peer is known
    for (const id of ids) entries.push({ chatId: String(peerId), msgId: id });
  } else {
    // Private chat case: scan antidel cache by message ID (unique in DMs)
    const cache = engine._modules.antidel.recentCache;
    for (const id of ids) {
      for (const [key, val] of cache.entries()) {
        if (val?.msg?.id === id) {
          entries.push({ chatId: val.msg.chatId, msgId: id });
          break;
        }
      }
    }
  }
  if (entries.length) await runAutomationsOnDelete(entries);
}

async function handleEdit(client, event) {
  if (!event.message) return;
  await runAutomationsOnEdit(event.message);
}

async function handleService(client, event) {
  // teleproto ChatAction event: { actionMessage?: Api.MessageService, userJoined, userAdded, ... }
  // We pass event through; automations read what they need.
  await runAutomationsOnService(event);
}

// ──────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────

async function start() {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 10, retryDelay: 2000 });
  await client.connect();
  const me = await client.getMe();
  console.log(`Connected — running as @${me.username || me.firstName} (id ${me.id}).`);
  if (channelConfig.length) console.log('Channels configured:', channelConfig.map((c) => c.channel).join(', '));
  if (adminIds.length) console.log('Admin IDs:', adminIds.join(', '));
  else console.log('WARNING: AGENT_ADMIN_IDS is empty.');

  ctx.client = client;

  // Initialize automations that have init() (e.g. autobio, antiraid, scheduler)
  ctx._automationHooks = {};
  for (const a of engine.AUTOMATIONS) {
    if (!a.init) continue;
    try {
      const hooks = await a.init(ctx);
      if (hooks) {
        if (hooks.stop) ctx._automationTimers[a.name] = hooks.stop;
        ctx._automationHooks[a.name] = hooks;
      }
    } catch (e) {
      ctx.log(`${a.name} init failed: ${e.message}`);
    }
  }

  // Event handlers
  client.addEventHandler((event) => handleMessage(client, event.message), new NewMessage({}));

  // Service messages (joins, leaves, etc.) — needed for antiraid
  try {
    client.addEventHandler((event) => handleService(client, event), new ChatAction({}));
  } catch (e) {
    ctx.log('ChatAction event not available:', e.message);
  }

  // Deletions — for antidel
  try {
    client.addEventHandler((event) => handleDelete(client, event), new DeletedMessage({}));
  } catch (e) {
    ctx.log('DeletedMessage event not available:', e.message);
  }

  // Edits — for antiedit
  try {
    client.addEventHandler((event) => handleEdit(client, event), new EditedMessage({}));
  } catch (e) {
    ctx.log('EditedMessage event not available:', e.message);
  }

  console.log('Listening for messages...');
}

start().catch((err) => {
  console.error('Failed to start, retrying in 5s:', err.message);
  setTimeout(start, 5000);
});

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(Number(process.env.PORT) || 3000, () => {
  console.log(`Health server on :${process.env.PORT || 3000}`);
});

// Internal exports for testing
if (process.env.GRAMJS_BOT_EXPORT === '1') {
  module.exports = {
    parseWhen, ensureChannel, findChannelConfig, ALL_TOOL_NAMES,
    telegramToolSchemas, reminders, runSlashBuiltin, getHistory, resetHistory,
    execTelegramTool, providers, loadProviders, callProviderOnce, callModel,
    internalToProvider, providerToInternal,
    engine, automations, ctx, aiMode,
  };
}
