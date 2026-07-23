// gramjs-bot.js — Termux-friendly Telegram userbot with a multi-provider LLM agent loop.
//
// What it does:
//   - Logs into a real Telegram user account (teleproto / GramJS fork).
//   - Listens for DMs; replies using an LLM (Gemini, OpenAI, Groq, OpenRouter,
//     Cerebras, GitHub Models, or any OpenAI-compatible endpoint) with a
//     tool-calling agent loop.
//   - Exposes ~27 native Telegram tools (chat, search, channels, media, etc.)
//     plus any AGENT_TOOLS you define in .env.
//   - Slash commands (/help, /tools, /reset, /ping, /whoami) are handled
//     directly — no model cost.
//   - Automatic failover: when a provider hits 429 (rate-limited) or 5xx, the
//     next provider in the list takes over for that request. Pair with
//     multiple free keys to multiply your effective quota.
//
// Safety:
//   - Channel write actions are gated by AGENT_CHANNELS per-channel flags.
//   - Write actions (post/react/comment/pin/forward) require the sender to
//     be in AGENT_ADMIN_IDS.
//   - Read-only tools (get_chat_history, list_channel_media, etc.) are
//     available to anyone messaging the bot in a DM.
//   - Tool errors are returned to the model instead of thrown, so it can recover.
//
// Setup: see README.md / .env.example.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api, utils } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { NewMessage } = require('teleproto/events');

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const downloadDir = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads');
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

const adminIds = (process.env.AGENT_ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

// ──────────────────────────────────────────────────────────────────────────
// LLM Providers — ordered list, automatic failover on 429/5xx
// ──────────────────────────────────────────────────────────────────────────
//
// Each provider is { name, baseUrl, apiKey, model, format }.
//   format: 'openai'  — OpenAI-compatible /chat/completions (Groq, OpenRouter,
//                       Cerebras, GitHub Models, llama.cpp, LM Studio, etc.)
//   format: 'gemini'  — Google's generateContent endpoint
//
// Configure via env: AGENT_PROVIDERS as a JSON array (recommended for
// multiple providers), OR set the GEMINI_API_KEY / OPENAI_API_KEY / GROQ_API_KEY
// / OPENROUTER_API_KEY convenience vars to spin up single-provider configs.

function loadProviders() {
  // 1) Explicit JSON config wins.
  if (process.env.AGENT_PROVIDERS) {
    try {
      const arr = JSON.parse(process.env.AGENT_PROVIDERS);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (err) {
      console.error('AGENT_PROVIDERS is not valid JSON:', err.message);
    }
  }
  // 2) Convenience single-provider shortcuts.
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
if (!providers.length) {
  console.log(
    'No LLM provider configured. Set one of: GEMINI_API_KEY, GROQ_API_KEY, ' +
      'OPENROUTER_API_KEY, CEREBRAS_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, ' +
      'or AGENT_PROVIDERS as a JSON array.'
  );
  process.exit(1);
}
console.log('LLM providers (in order):', providers.map((p) => `${p.name}:${p.model}`).join(', '));

const conversations = new Map();

// Reminders: array of { fireAt: epochMs, chatId, text, timer }
const reminders = [];

// ──────────────────────────────────────────────────────────────────────────
// Conversation history
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

// ──────────────────────────────────────────────────────────────────────────
// Channel config helpers
// ──────────────────────────────────────────────────────────────────────────

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
// Slash commands — handled directly, no model round-trip
// ──────────────────────────────────────────────────────────────────────────

const SLASH_HELP =
  `Commands:
/help     — this message
/tools    — list available tools
/reset    — clear our chat history
/ping     — health check
/whoami   — your Telegram ID + admin status

Everything else: just text me, I'll figure it out and may use tools.`;

function runSlash(client, msg, command, args, isAdmin) {
  switch (command) {
    case 'help':
      return SLASH_HELP;
    case 'tools': {
      const names = ALL_TOOL_NAMES.join(', ');
      return `Available tools (${ALL_TOOL_NAMES.length}):\n${names}\n\nChannel config: ${
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
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Native Telegram tool implementations
// ──────────────────────────────────────────────────────────────────────────

async function execTelegramTool(client, name, args, ctx) {
  const isAdmin = ctx.isAdmin;
  const senderId = ctx.senderId;

  switch (name) {
    // ── Personal chat ──────────────────────────────────────────────────
    case 'send_message': {
      if (!args.chat) return { error: 'chat is required' };
      await client.sendMessage(args.chat, { message: args.text || '' });
      return { ok: true };
    }

    case 'reply_to_message': {
      if (!args.chat) return { error: 'chat is required' };
      if (!args.messageId) return { error: 'messageId is required' };
      await client.sendMessage(args.chat, {
        message: args.text || '',
        replyTo: args.messageId,
      });
      return { ok: true };
    }

    case 'get_chat_history': {
      const messages = await client.getMessages(args.chat, { limit: args.limit || 20 });
      return {
        items: messages.map((m) => ({
          id: m.id,
          date: m.date,
          senderId: m.senderId,
          text: (m.message || '').slice(0, 1000),
          hasMedia: !!m.media,
        })),
      };
    }

    case 'get_me': {
      const me = await client.getMe();
      return {
        id: me.id,
        username: me.username,
        firstName: me.firstName,
        phone: me.phone,
      };
    }

    case 'set_typing': {
      try {
        await client.invoke(
          new Api.messages.SetTyping({
            peer: args.chat,
            action: new Api.SendMessageTypingAction(),
          })
        );
      } catch (e) {
        // non-fatal
      }
      return { ok: true };
    }

    // ── Search & discovery ─────────────────────────────────────────────
    case 'search_messages': {
      const result = await client.invoke(
        new Api.messages.Search({
          peer: args.peer || 'global',
          q: args.query || '',
          limit: args.limit || 20,
          filter: new Api.InputMessagesFilterEmpty(),
        })
      );
      const items = (result.messages || []).map((m) => ({
        id: m.id,
        chatId: m.peerId,
        date: m.date,
        text: (m.message || '').slice(0, 500),
      }));
      return { count: items.length, items };
    }

    case 'resolve_username': {
      try {
        const res = await client.invoke(
          new Api.contacts.ResolveUsername({ username: String(args.username || '').replace(/^@/, '') })
        );
        const peer = res.peer;
        return {
          type:
            peer.className === 'PeerUser'
              ? 'user'
              : peer.className === 'PeerChat'
              ? 'group'
              : 'channel',
          id: peer.userId || peer.chatId || peer.channelId,
          user: res.users?.[0]
            ? {
                id: res.users[0].id,
                firstName: res.users[0].firstName,
                lastName: res.users[0].lastName,
                username: res.users[0].username,
              }
            : null,
          chat: res.chats?.[0]
            ? {
                id: res.chats[0].id,
                title: res.chats[0].title,
                username: res.chats[0].username,
              }
            : null,
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'get_user_info': {
      try {
        const res = await client.invoke(
          new Api.users.GetFullUser({ id: args.userId })
        );
        const u = res.users[0];
        const f = res.fullUser;
        return {
          id: u?.id,
          firstName: u?.firstName,
          lastName: u?.lastName,
          username: u?.username,
          bio: f?.about,
          isBot: u?.bot,
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'get_dialogs': {
      const dialogs = await client.getDialogs({ limit: args.limit || 30 });
      return {
        items: dialogs.map((d) => ({
          id: d.id,
          name: d.name,
          isGroup: d.isGroup,
          isChannel: d.isChannel,
          unreadCount: d.unreadCount,
        })),
      };
    }

    // ── Channels (gated) ───────────────────────────────────────────────
    case 'list_channel_media': {
      const gate = ensureChannel(args.channel, 'canPullMedia');
      if (gate.error) return gate;
      const messages = await client.getMessages(args.channel, { limit: args.limit || 20 });
      const items = messages
        .filter((m) => m.media)
        .map((m) => ({
          id: m.id,
          date: m.date,
          caption: (m.message || '').slice(0, 500),
          type: m.video ? 'video' : m.photo ? 'photo' : 'other',
          durationSeconds:
            m.video?.attributes?.find((a) => a.duration != null)?.duration ?? null,
        }))
        .filter(
          (m) =>
            !gate.cfg.maxVideoSeconds ||
            m.type !== 'video' ||
            (m.durationSeconds ?? 0) <= gate.cfg.maxVideoSeconds
        );
      return { items };
    }

    case 'get_channel_info': {
      const gate = ensureChannel(args.channel);
      if (gate.error) return gate;
      const res = await client.invoke(
        new Api.channels.GetFullChannel({ channel: args.channel })
      );
      const c = res.chats[0];
      const f = res.fullChat;
      return {
        id: c?.id,
        title: c?.title,
        username: c?.username,
        participants: f?.participantsCount,
        about: f?.about,
        linkedChatId: f?.linkedChatId,
      };
    }

    case 'react_to_message': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canReact');
      if (gate.error) return gate;
      try {
        await client.invoke(
          new Api.messages.SendReaction({
            peer: args.channel,
            msgId: args.messageId,
            reaction: [new Api.ReactionEmoji({ emoticon: args.emoji })],
          })
        );
        return { ok: true };
      } catch (e) {
        return { error: `SendReaction failed: ${e.message}. Check Api.messages.SendReaction schema for your teleproto version.` };
      }
    }

    case 'comment_on_post': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canComment');
      if (gate.error) return gate;
      const full = await client.invoke(
        new Api.channels.GetFullChannel({ channel: args.channel })
      );
      const linkedId = full.fullChat.linkedChatId;
      if (!linkedId) return { error: 'This channel has no linked discussion group.' };
      await client.sendMessage(linkedId, {
        message: args.text,
        replyTo: args.messageId,
      });
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
        await client.invoke(
          new Api.messages.UpdatePinnedMessage({
            peer: args.channel,
            id: args.messageId,
            unpin: name === 'unpin_message',
          })
        );
        return { ok: true };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'post_to_channel': {
      if (!isAdmin) return { error: 'admin-only action' };
      const gate = ensureChannel(args.channel, 'canPost');
      if (gate.error) return gate;
      const messageOpts = { message: args.text || '' };
      if (args.mediaUrl) {
        // Download to a temp file and send as file.
        const filename = path.basename(new URL(args.mediaUrl).pathname);
        const localPath = path.join(downloadDir, `up_${Date.now()}_${filename}`);
        const res = await fetch(args.mediaUrl);
        if (!res.ok) return { error: `failed to download media: HTTP ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localPath, buf);
        messageOpts.file = localPath;
      }
      await client.sendMessage(args.channel, messageOpts);
      return { ok: true };
    }

    // ── Media ──────────────────────────────────────────────────────────
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
      if (!args.filePath && !args.fileUrl) {
        return { error: 'filePath or fileUrl is required' };
      }
      let filePath = args.filePath;
      if (!filePath) {
        const filename = path.basename(new URL(args.fileUrl).pathname);
        filePath = path.join(downloadDir, `dl_${Date.now()}_${filename}`);
        const res = await fetch(args.fileUrl);
        if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
        fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
      }
      const opts = { file: filePath, message: args.caption || '' };
      await client.sendFile(args.chat, opts);
      return { ok: true };
    }

    case 'send_voice': {
      if (!isAdmin) return { error: 'admin-only action' };
      if (!args.chat) return { error: 'chat is required' };
      if (!args.filePath && !args.fileUrl) {
        return { error: 'filePath or fileUrl is required' };
      }
      let filePath = args.filePath;
      if (!filePath) {
        const filename = path.basename(new URL(args.fileUrl).pathname);
        filePath = path.join(downloadDir, `voice_${Date.now()}_${filename}`);
        const res = await fetch(args.fileUrl);
        if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
        fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
      }
      await client.sendFile(args.chat, {
        file: filePath,
        voiceNote: true,
      });
      return { ok: true };
    }

    // ── Utilities ──────────────────────────────────────────────────────
    case 'translate_text': {
      return await translateText(args.text, args.target || 'en');
    }

    case 'summarize_chat': {
      const messages = await client.getMessages(args.chat, { limit: args.limit || 50 });
      const text = messages
        .map((m) => `[${m.date}] ${m.senderId || '?'}: ${m.message || ''}`)
        .join('\n');
      return await summarizeText(text, args.focus);
    }

    case 'schedule_reminder': {
      if (!args.when) return { error: 'when is required (ISO date or relative like "in 5m")' };
      if (!args.text) return { error: 'text is required' };
      const fireAt = parseWhen(args.when);
      if (!fireAt) return { error: `could not parse "when": ${args.when}` };
      const chatId = args.chat || String(ctx.chatId);
      const delay = Math.max(0, fireAt - Date.now());
      const entry = { fireAt, chatId, text: args.text, timer: null };
      entry.timer = setTimeout(async () => {
        try {
          await client.sendMessage(chatId, { message: `⏰ Reminder: ${args.text}` });
        } catch (e) {
          console.error('reminder send failed:', e.message);
        }
        const idx = reminders.indexOf(entry);
        if (idx !== -1) reminders.splice(idx, 1);
      }, delay);
      reminders.push(entry);
      return { ok: true, fireAt: new Date(fireAt).toISOString(), delaySeconds: Math.round(delay / 1000) };
    }

    case 'list_reminders': {
      return {
        items: reminders.map((r) => ({
          fireAt: new Date(r.fireAt).toISOString(),
          chatId: r.chatId,
          text: r.text,
        })),
      };
    }

    case 'cancel_reminder': {
      const idx = reminders.findIndex(
        (r) => r.text === args.text && r.chatId === String(ctx.chatId)
      );
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
// Time parser for reminders ("in 5m", "2025-12-25T09:00", "tomorrow 9am")
// ──────────────────────────────────────────────────────────────────────────

function parseWhen(input) {
  if (!input) return null;
  // ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) {
    const t = Date.parse(input);
    return Number.isFinite(t) ? t : null;
  }
  // Relative: "in 30s / 5m / 2h / 1d"
  const m = String(input)
    .trim()
    .match(/^in\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60_000 :
      unit.startsWith('h') ? n * 3_600_000 :
      n * 86_400_000;
    return Date.now() + ms;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Multi-provider LLM layer (Gemini + OpenAI-compatible endpoints)
// ──────────────────────────────────────────────────────────────────────────
//
// Single internal representation: { system, messages, tools }
//   messages: [{ role: 'user'|'assistant'|'tool', content?, tool_calls?, tool_call_id?, name? }]
//   tools:    [{ name, description, parameters }]  (JSON Schema)
//
// Each provider has a `toRequest()` that converts the internal form to the
// provider's wire format, and a `fromResponse()` that normalizes the
// response back to { text?, toolCalls: [{name, args}]? }.

function internalToProvider(provider, internal) {
  if (provider.format === 'gemini') {
    // Gemini uses "contents" with role user/model, plus system_instruction
    // and a "tools" array of { functionDeclarations }.
    const contents = [];
    for (const m of internal.messages) {
      if (m.role === 'tool') {
        // Gemini expects a "functionResponse" part on a user turn.
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: m.name,
                response: typeof m.content === 'string' ? safeJsonParse(m.content) : m.content,
              },
            },
          ],
        });
      } else if (m.role === 'assistant') {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        if (m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
          }
        }
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
  // OpenAI-compatible format
  const messages = [];
  if (internal.system) messages.push({ role: 'system', content: internal.system });
  for (const m of internal.messages) {
    if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: m.tool_call_id,
        name: m.name,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc, i) => ({
          id: tc.id || `call_${Date.now()}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      messages.push(msg);
    } else {
      messages.push({ role: m.role, content: m.content || '' });
    }
  }
  const body = { model: provider.model, messages };
  if (internal.tools?.length) {
    body.tools = internal.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

function providerToInternal(provider, raw) {
  if (provider.format === 'gemini') {
    const parts = raw?.candidates?.[0]?.content?.parts || [];
    let text = '';
    const toolCalls = [];
    for (const p of parts) {
      if (p.text) text += p.text;
      if (p.functionCall) {
        toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, name: p.functionCall.name, args: p.functionCall.args || {} });
      }
    }
    return { text: text.trim() || null, toolCalls };
  }
  // OpenAI-compatible
  const choice = raw?.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    args: safeJsonParse(tc.function?.arguments) || {},
  }));
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
    const err = new Error(`${provider.name} ${res.status}: ${txt.slice(0, 500)}`);
    err.status = res.status;
    err.provider = provider.name;
    throw err;
  }
  if (!txt) {
    throw Object.assign(new Error(`${provider.name} returned empty response body`), { status: 502, provider: provider.name });
  }
  let parsed;
  try { parsed = JSON.parse(txt); } catch (err) {
    throw Object.assign(new Error(`${provider.name} returned non-JSON: ${txt.slice(0, 200)}`), { status: 502, provider: provider.name });
  }
  return providerToInternal(provider, parsed);
}

// Try providers in order, fall back on 429/5xx, with exponential backoff.
async function callModel(internal) {
  let lastErr;
  for (const provider of providers) {
    for (let attempt = 0; attempt < maxRetriesPerRequest; attempt++) {
      try {
        return await callProviderOnce(provider, internal);
      } catch (err) {
        lastErr = err;
        const retryable = err.status === 429 || (err.status >= 500 && err.status < 600);
        console.warn(`[${provider.name}] ${err.status || 'ERR'}: ${(err.message || '').slice(0, 200)}`);
        if (!retryable) throw err; // 4xx other than 429 is a real client error, don't burn other providers
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

// Plain text completion (no tools) for translate/summarize utilities.
async function callModelPlain(prompt, systemOverride) {
  const internal = {
    system: systemOverride || 'You are a helpful assistant. Follow the user instructions exactly.',
    messages: [{ role: 'user', content: prompt }],
  };
  const result = await callModel(internal);
  return result.text || '';
}

async function translateText(text, target) {
  if (!text) return { error: 'text is required' };
  const out = await callModelPlain(
    `Translate the following to ${target}. Return ONLY the translation, no preamble, no quotes.\n\n${text}`
  );
  return { translation: out };
}

async function summarizeText(text, focus) {
  if (!text) return { error: 'empty text' };
  const prompt = focus
    ? `Summarize the following chat messages, focusing on: ${focus}. Be concise.\n\n${text}`
    : `Summarize the following chat messages in 5-8 bullet points.\n\n${text}`;
  const out = await callModelPlain(prompt);
  return { summary: out };
}

// ──────────────────────────────────────────────────────────────────────────
// Tool schemas (sent to Gemini as function declarations)
// ──────────────────────────────────────────────────────────────────────────

const telegramToolSchemas = [
  // Personal chat
  {
    name: 'send_message',
    description: 'Send a message to any chat, group, or channel (by username or id).',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat identifier: @username, numeric id, or "me" for Saved Messages' },
        text: { type: 'string', description: 'Message text' },
      },
      required: ['chat', 'text'],
    },
  },
  {
    name: 'reply_to_message',
    description: 'Send a message that replies to a specific message id in a chat.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        messageId: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['chat', 'messageId', 'text'],
    },
  },
  {
    name: 'get_chat_history',
    description: 'Fetch recent messages from a chat.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        limit: { type: 'number', description: 'How many recent messages (default 20)' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'get_me',
    description: 'Return information about the logged-in Telegram account.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_typing',
    description: 'Show "typing…" status in a chat. Useful while gathering info.',
    parameters: {
      type: 'object',
      properties: { chat: { type: 'string' } },
      required: ['chat'],
    },
  },

  // Search & discovery
  {
    name: 'search_messages',
    description: 'Search for messages. Pass "global" to search across all chats, or a specific chat.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        peer: { type: 'string', description: 'Chat to search, or "global" for global search' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'resolve_username',
    description: 'Resolve a @username to a user or chat with its id.',
    parameters: {
      type: 'object',
      properties: { username: { type: 'string', description: 'Without the @' } },
      required: ['username'],
    },
  },
  {
    name: 'get_user_info',
    description: 'Get profile info for a user by their numeric Telegram id.',
    parameters: {
      type: 'object',
      properties: { userId: { type: 'string', description: 'Numeric Telegram user id' } },
      required: ['userId'],
    },
  },
  {
    name: 'get_dialogs',
    description: 'List recent chats, groups, and channels.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },

  // Channels (gated)
  {
    name: 'list_channel_media',
    description: 'List recent media posts from an allowed channel. Filtered by max video length if configured.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '@channelname' },
        limit: { type: 'number' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'get_channel_info',
    description: 'Get metadata about an allowed channel (subs, bio, linked discussion group).',
    parameters: {
      type: 'object',
      properties: { channel: { type: 'string' } },
      required: ['channel'],
    },
  },
  {
    name: 'react_to_message',
    description: 'Send an emoji reaction to a message in an allowed channel. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        messageId: { type: 'number' },
        emoji: { type: 'string', description: 'A single emoji, e.g. 👍' },
      },
      required: ['channel', 'messageId', 'emoji'],
    },
  },
  {
    name: 'comment_on_post',
    description: 'Post a comment on a channel post via its linked discussion group. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        messageId: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['channel', 'messageId', 'text'],
    },
  },
  {
    name: 'forward_post',
    description: 'Forward a channel post to another chat. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        messageId: { type: 'number' },
        to: { type: 'string', description: 'Target chat (username or id)' },
      },
      required: ['channel', 'messageId', 'to'],
    },
  },
  {
    name: 'pin_message',
    description: 'Pin a message in a channel you admin. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        messageId: { type: 'number' },
      },
      required: ['channel', 'messageId'],
    },
  },
  {
    name: 'unpin_message',
    description: 'Unpin a message in a channel you admin. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        messageId: { type: 'number' },
      },
      required: ['channel', 'messageId'],
    },
  },
  {
    name: 'post_to_channel',
    description: 'Publish a new post to an allowed channel. Admin only. Optional mediaUrl attaches a file from a URL.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        text: { type: 'string' },
        mediaUrl: { type: 'string', description: 'Public URL of an image/video/file to attach' },
      },
      required: ['channel', 'text'],
    },
  },

  // Media
  {
    name: 'download_media',
    description: 'Download media from a specific message to local disk and return the file path.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        messageId: { type: 'number' },
      },
      required: ['chat', 'messageId'],
    },
  },
  {
    name: 'send_photo',
    description: 'Send a photo by file path or URL. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        filePath: { type: 'string' },
        fileUrl: { type: 'string' },
        caption: { type: 'string' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'send_video',
    description: 'Send a video by file path or URL. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        filePath: { type: 'string' },
        fileUrl: { type: 'string' },
        caption: { type: 'string' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'send_document',
    description: 'Send any file (document) by file path or URL. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        filePath: { type: 'string' },
        fileUrl: { type: 'string' },
        caption: { type: 'string' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'send_voice',
    description: 'Send a voice note by file path or URL. Admin only.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        filePath: { type: 'string' },
        fileUrl: { type: 'string' },
      },
      required: ['chat'],
    },
  },

  // Utilities
  {
    name: 'translate_text',
    description: 'Translate text into a target language using the configured LLM. target defaults to "en".',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target: { type: 'string', description: 'Target language code, e.g. "en", "es", "zh"' },
      },
      required: ['text'],
    },
  },
  {
    name: 'summarize_chat',
    description: 'Fetch recent messages from a chat and summarize them with the configured LLM.',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        limit: { type: 'number' },
        focus: { type: 'string', description: 'Optional focus question for the summary' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'schedule_reminder',
    description: 'Schedule a one-shot reminder to be sent in the current chat.',
    parameters: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          description: 'ISO date (e.g. "2025-12-25T09:00") or relative ("in 5m", "in 1h", "in 2d")',
        },
        text: { type: 'string', description: 'What the reminder should say' },
        chat: { type: 'string', description: 'Optional: send to a different chat. Defaults to the current DM.' },
      },
      required: ['when', 'text'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List all currently scheduled reminders.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a scheduled reminder by exact text match (for the current chat).',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const ALL_TOOL_NAMES = [
  ...telegramToolSchemas.map((t) => t.name),
  ...httpTools.map((t) => t.name),
];

// ──────────────────────────────────────────────────────────────────────────
// Agent loop — provider-agnostic, talks in the internal representation.
// ──────────────────────────────────────────────────────────────────────────

function historyToMessages(history) {
  // history entries are { role, parts } (legacy Gemini shape we already
  // store in the conversations Map). Normalize to the internal messages list.
  const out = [];
  for (const entry of history) {
    if (entry.role === 'user') {
      const text = (entry.parts || []).map((p) => p.text || '').join('');
      const fr = (entry.parts || []).find((p) => p.functionResponse);
      if (fr) {
        out.push({
          role: 'tool',
          tool_call_id: fr.functionResponse.tool_call_id || `tr_${out.length}`,
          name: fr.functionResponse.name,
          content: JSON.stringify(fr.functionResponse.response || {}),
        });
      } else {
        out.push({ role: 'user', content: text });
      }
    } else if (entry.role === 'model') {
      const text = (entry.parts || []).map((p) => p.text || '').join('');
      const fc = (entry.parts || []).find((p) => p.functionCall);
      if (fc) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: [
            { id: `call_${out.length}_${Date.now()}`, name: fc.functionCall.name, args: fc.functionCall.args || {} },
          ],
        });
      } else {
        out.push({ role: 'assistant', content: text });
      }
    }
  }
  return out;
}

async function runAgent(client, ctx, userText) {
  const { chatId, isAdmin, senderId } = ctx;
  const history = getHistory(chatId);
  history.push({ role: 'user', parts: [{ text: userText }] });

  const availableTools = [
    ...telegramToolSchemas,
    ...httpTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  ];

  for (let step = 0; step < maxAgentSteps; step++) {
    const internal = {
      system: systemPrompt,
      messages: historyToMessages(history),
      tools: availableTools,
    };

    let result;
    try {
      result = await callModel(internal);
    } catch (err) {
      return `Model error: ${err.message}`;
    }

    // No tool call — return the text reply.
    if (!result.toolCalls?.length) {
      const reply = result.text || "Hmm, didn't quite catch that.";
      history.push({ role: 'model', parts: [{ text: reply }] });
      trimHistory(history);
      return reply;
    }

    // One or more tool calls. For now, we honor the first; multi-call
    // fan-out is rare in practice and most providers don't emit more than one.
    const tc = result.toolCalls[0];
    if (!tc.name) return 'Model returned an empty tool call.';

    // Record the assistant turn in legacy history shape.
    history.push({
      role: 'model',
      parts: [{ functionCall: { name: tc.name, args: tc.args || {} } }],
    });

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
    } catch (err) {
      execResult = { error: err.message };
    }

    history.push({
      role: 'user',
      parts: [{ functionResponse: { name: tc.name, response: { result: execResult }, tool_call_id: tc.id } }],
    });
    trimHistory(history);
  }
  return 'That took too many steps — try rephrasing or /reset to clear context.';
}

// ──────────────────────────────────────────────────────────────────────────
// Message handling
// ──────────────────────────────────────────────────────────────────────────

async function handleMessage(client, msg) {
  if (!msg?.message) return;
  if (msg.out) return; // ignore our own
  if (!msg.isPrivate) return; // DMs only

  const sender = await msg.getSender();
  const senderId = String(sender?.id ?? '');
  const isAdmin = adminIds.includes(senderId);
  const chatId = String(msg.chatId);

  const text = msg.message.trim();
  console.log(`[${sender?.username || senderId}] (${isAdmin ? 'admin' : 'guest'}) ${text}`);

  // Slash command fast path
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const reply = runSlash(client, msg, cmd.toLowerCase(), rest, isAdmin);
    if (reply) {
      try {
        await client.sendMessage(msg.chatId, { message: reply, replyTo: msg.id });
      } catch (e) {
        console.error('slash reply failed:', e.message);
      }
      return;
    }
  }

  // Show typing while we think
  try {
    await client.invoke(
      new Api.messages.SetTyping({
        peer: msg.chatId,
        action: new Api.SendMessageTypingAction(),
      })
    );
  } catch {}

  let reply;
  try {
    reply = await runAgent(client, { chatId, isAdmin, senderId }, text);
  } catch (err) {
    reply = `Sorry, something blew up: ${err.message}`;
    console.error('runAgent error:', err);
  }

  try {
    await client.sendMessage(msg.chatId, { message: reply, replyTo: msg.id });
  } catch (err) {
    console.error('sendMessage failed:', err.message);
  }
}

async function start() {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
  });

  await client.connect();
  const me = await client.getMe();
  console.log(`Connected — running as @${me.username || me.firstName} (id ${me.id}).`);
  if (channelConfig.length) {
    console.log('Channels configured:', channelConfig.map((c) => c.channel).join(', '));
  }
  if (adminIds.length) {
    console.log('Admin IDs:', adminIds.join(', '));
  } else {
    console.log('WARNING: AGENT_ADMIN_IDS is empty — admin-only tools will be unreachable.');
  }

  client.addEventHandler(
    (event) => handleMessage(client, event.message),
    new NewMessage({})
  );

  console.log('Listening for messages...');
}

// ──────────────────────────────────────────────────────────────────────────
// Entry
// ──────────────────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error('Failed to start, retrying in 5s:', err.message);
  setTimeout(start, 5000);
});

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
  })
  .listen(Number(process.env.PORT) || 3000, () => {
    console.log(`Health server on :${process.env.PORT || 3000}`);
  });

// Internal exports — used by smoke-test.js only. Harmless at runtime.
if (process.env.GRAMJS_BOT_EXPORT === '1') {
  module.exports = {
    parseWhen,
    ensureChannel,
    findChannelConfig,
    ALL_TOOL_NAMES,
    telegramToolSchemas,
    reminders,
    runSlash,
    getHistory,
    resetHistory,
    execTelegramTool,
    providers,
    loadProviders,
    callProviderOnce,
    callModel,
    internalToProvider,
    providerToInternal,
  };
}
