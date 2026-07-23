// automation-engine.js
// Plugin-style automation engine for the GramJS Telegram userbot.
//
// Each automation is a self-contained module with:
//   name        — string id
//   description — one-line help
//   defaultCfg  — default config object (merged with user AUTOMATIONS)
//   init(ctx)   — optional, called once at startup; return event-handler fns
//   onMessage(ctx, msg, cfg) — called for every incoming message
//   onDelete(ctx, msgs, cfg) — called when messages are deleted
//   onEdit(ctx, msg, cfg)    — called when a message is edited
//   command     — { triggers: [..], handler(ctx, args) } — admin no-prefix + slash
//
// ctx = { client, Api, adminIds, channelConfig, downloadDir, automations, log }

'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function pickRandom(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function chatMatches(target, chat) {
  // target: string (username with or without @, numeric id, "all", "private", "groups", "channels")
  // chat:   msg.chat (has .id, .username?, isChannel?, isGroup?)
  if (!target || target === 'all') return true;
  if (target === 'private') return !chat.isGroup && !chat.isChannel;
  if (target === 'groups') return !!chat.isGroup;
  if (target === 'channels') return !!chat.isChannel;
  const norm = String(target).replace(/^@/, '').toLowerCase();
  const chatUsername = (chat.username || '').toLowerCase();
  const chatId = String(chat.id);
  if (chatUsername && chatUsername === norm) return true;
  if (chatId === String(target) || chatId === `-100${target}`) return true;
  if (String(target).startsWith('-') && chatId === String(target)) return true;
  return false;
}

function chatMatchesAny(list, chat) {
  if (!Array.isArray(list) || !list.length) return chatMatches('all', chat);
  return list.some((t) => chatMatches(t, chat));
}

function textMatches(pattern, text) {
  if (!pattern) return true;
  if (pattern === '*' || pattern === '.*') return true;
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function safeFileName(s) {
  return String(s || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

// ─────────────────────────────────────────────────────────────────────────
// Automation: autolike — react to every new message in configured chats
// ─────────────────────────────────────────────────────────────────────────

const autolike = {
  name: 'autolike',
  description: 'Auto-react to every message in configured chats with a random emoji from a list.',
  defaultCfg: { enabled: false, chats: 'all', emojis: ['❤️', '🔥', '👍', '😍', '💯', '👏', '✨'], skipOwn: true, skipCommands: true },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (cfg.skipOwn && msg.out) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    const text = (msg.message || '').trim();
    if (cfg.skipCommands && (text.startsWith('/') || text.startsWith('.'))) return;
    const emoji = pickRandom(cfg.emojis || ['❤️']);
    if (!emoji) return;
    try {
      await ctx.client.invoke(
        new ctx.Api.messages.SendReaction({
          peer: msg.chatId,
          msgId: msg.id,
          reaction: [new ctx.Api.ReactionEmoji({ emoticon: emoji })],
          big: false,
        })
      );
    } catch (e) {
      // reactions not allowed in this chat — silently ignore
    }
  },
  command: {
    triggers: ['autolike'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autolike;
      if (args[0] === 'on') { cfg.enabled = true; return `autolike: ON (emojis: ${(cfg.emojis || []).join(' ')})`; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autolike: OFF'; }
      if (args[0] === 'emojis') {
        cfg.emojis = args.slice(1).filter(Boolean);
        return `autolike emojis: ${cfg.emojis.join(' ')}`;
      }
      return `autolike: ${cfg.enabled ? 'ON' : 'OFF'} | emojis: ${(cfg.emojis || []).join(' ')}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autoreact — keyword-driven reactions
// ─────────────────────────────────────────────────────────────────────────

const autoreact = {
  name: 'autoreact',
  description: 'React with configured emojis when a message matches a keyword/regex.',
  defaultCfg: {
    enabled: false,
    chats: 'all',
    skipOwn: true,
    rules: [
      { match: 'hello|hi|hey', emojis: ['👋'] },
      { match: 'love|❤', emojis: ['❤️', '😍'] },
      { match: 'fire|🔥', emojis: ['🔥'] },
      { match: 'lol|lmao|haha', emojis: ['😂', '🤣'] },
      { match: '.*', emojis: ['❤️', '🔥', '👍', '✨'] },
    ],
  },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (cfg.skipOwn && msg.out) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    const text = (msg.message || '');
    if (!text) return;
    for (const rule of cfg.rules || []) {
      if (textMatches(rule.match, text)) {
        const emoji = pickRandom(rule.emojis || ['❤️']);
        if (!emoji) continue;
        try {
          await ctx.client.invoke(
            new ctx.Api.messages.SendReaction({
              peer: msg.chatId,
              msgId: msg.id,
              reaction: [new ctx.Api.ReactionEmoji({ emoticon: emoji })],
              big: false,
            })
          );
          return; // one reaction per message
        } catch {}
      }
    }
  },
  command: {
    triggers: ['autoreact'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autoreact;
      if (args[0] === 'on') { cfg.enabled = true; return 'autoreact: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autoreact: OFF'; }
      if (args[0] === 'add') {
        const match = args[1];
        const emojis = args.slice(2);
        if (!match || !emojis.length) return 'usage: autoreact add <pattern> <emoji1> [emoji2 ...]';
        cfg.rules = cfg.rules || [];
        cfg.rules.unshift({ match, emojis });
        return `autoreact rule added: /${match}/ → ${emojis.join(' ')}`;
      }
      if (args[0] === 'clear') { cfg.rules = []; return 'autoreact rules cleared'; }
      return `autoreact: ${cfg.enabled ? 'ON' : 'OFF'} | ${(cfg.rules || []).length} rule(s)`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autopost — mirror channel posts to a target chat
// (Telegram has no public "story" API for non-Premium users; we mirror to
//  Saved Messages or any target chat, which IS the closest non-Premium
//  equivalent — your own private feed of channel content.)
// ─────────────────────────────────────────────────────────────────────────

const autopost = {
  name: 'autopost',
  description: 'Mirror posts from source channels to a target chat (Saved Messages, group, etc).',
  defaultCfg: { enabled: false, fromChannels: [], toChat: 'me', withCaption: true, onlyMedia: false, limit: 50 },
  command: {
    triggers: ['autopost'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autopost;
      if (args[0] === 'on') { cfg.enabled = true; return `autopost: ON → ${cfg.toChat}`; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autopost: OFF'; }
      if (args[0] === 'target') { cfg.toChat = args[1] || 'me'; return `autopost target: ${cfg.toChat}`; }
      if (args[0] === 'add') {
        cfg.fromChannels = cfg.fromChannels || [];
        cfg.fromChannels.push(args[1]);
        return `autopost source added: ${args[1]}`;
      }
      if (args[0] === 'remove') {
        cfg.fromChannels = (cfg.fromChannels || []).filter((c) => c !== args[1]);
        return `autopost source removed: ${args[1]}`;
      }
      if (args[0] === 'run') {
        return await autopost._runOnce(ctx, cfg);
      }
      return `autopost: ${cfg.enabled ? 'ON' : 'OFF'} | ${(cfg.fromChannels || []).length} source(s) → ${cfg.toChat}`;
    },
  },
  async _runOnce(ctx, cfg) {
    if (!cfg.fromChannels?.length) return 'autopost: no source channels configured';
    let copied = 0;
    for (const source of cfg.fromChannels) {
      try {
        const messages = await ctx.client.getMessages(source, { limit: cfg.limit || 20 });
        for (const m of messages) {
          if (cfg.onlyMedia && !m.media) continue;
          try {
            await ctx.client.forwardMessages(cfg.toChat, { messages: [m] });
            copied++;
            await new Promise((r) => setTimeout(r, 200));
          } catch (e) {
            ctx.log(`autopost: forward failed ${m.id}: ${e.message}`);
          }
        }
      } catch (e) {
        ctx.log(`autopost: source ${source} failed: ${e.message}`);
      }
    }
    return `autopost: forwarded ${copied} message(s) → ${cfg.toChat}`;
  },
  init(ctx) {
    // Auto-mirror on new message
    return {
      onMessage: async (msg) => {
        const cfg = ctx.automations.autopost;
        if (!cfg?.enabled) return;
        if (!cfg.fromChannels?.length) return;
        if (msg.out) return;
        const source = msg.chat?.username ? `@${msg.chat.username}` : String(msg.chatId);
        if (!cfg.fromChannels.includes(source) && !cfg.fromChannels.includes(String(msg.chatId))) return;
        try {
          await ctx.client.forwardMessages(cfg.toChat, { messages: [msg] });
        } catch (e) {
          ctx.log(`autopost live forward failed: ${e.message}`);
        }
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autosave — auto-download media from configured chats
// ─────────────────────────────────────────────────────────────────────────

const autosave = {
  name: 'autosave',
  description: 'Auto-download all media (photo/video/doc/voice) from configured chats to disk.',
  defaultCfg: { enabled: false, chats: 'all', types: ['photo', 'video', 'document', 'voice', 'video_note'], maxBytes: 50 * 1024 * 1024 },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (msg.out) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    if (!msg.media) return;
    const type =
      msg.photo ? 'photo' :
      msg.video ? 'video' :
      msg.voice ? 'voice' :
      msg.videoNote ? 'video_note' :
      msg.document ? 'document' :
      null;
    if (!type || !(cfg.types || []).includes(type)) return;
    try {
      const buffer = await ctx.client.downloadMedia(msg, {});
      if (!buffer) return;
      if (buffer.length > (cfg.maxBytes || Infinity)) return;
      const chatName = safeFileName(msg.chat?.username || msg.chat?.title || msg.chatId);
      const dir = path.join(ctx.downloadDir, 'autosave', chatName);
      ensureDir(dir);
      const ext = msg.fileName ? path.extname(msg.fileName) : (type === 'photo' ? '.jpg' : type === 'voice' ? '.ogg' : '');
      const filename = safeFileName(`${msg.id}_${Date.now()}${ext || ''}`);
      fs.writeFileSync(path.join(dir, filename), buffer);
    } catch (e) {
      ctx.log(`autosave failed: ${e.message}`);
    }
  },
  command: {
    triggers: ['autosave'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autosave;
      if (args[0] === 'on') { cfg.enabled = true; return 'autosave: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autosave: OFF'; }
      if (args[0] === 'types') { cfg.types = args.slice(1); return `autosave types: ${cfg.types.join(', ')}`; }
      return `autosave: ${cfg.enabled ? 'ON' : 'OFF'} | types: ${(cfg.types || []).join(', ')}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: antidel — cache deleted messages so you can recover them
// ─────────────────────────────────────────────────────────────────────────

const antidel = {
  name: 'antidel',
  description: 'Cache deleted messages (and optionally their media) so you can recover them.',
  defaultCfg: { enabled: false, chats: 'all', maxCache: 1000, saveMedia: true, dir: null },
  // In-memory cache of recent messages so when a delete event fires we have the body
  recentCache: new Map(), // key: `${chatId}:${msgId}` -> { msg, media? }

  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    const key = `${msg.chatId}:${msg.id}`;
    let mediaBuf = null;
    if (cfg.saveMedia && msg.media) {
      try { mediaBuf = await ctx.client.downloadMedia(msg, {}); } catch {}
    }
    this.recentCache.set(key, {
      ts: Date.now(),
      msg: {
        id: msg.id,
        chatId: String(msg.chatId),
        senderId: msg.senderId ? String(msg.senderId) : null,
        date: msg.date,
        text: msg.message || '',
        media: !!msg.media,
        mediaType: msg.photo ? 'photo' : msg.video ? 'video' : msg.voice ? 'voice' : msg.document ? 'document' : null,
        fileName: msg.fileName || null,
      },
      mediaBuf,
    });
    // Cap cache
    if (this.recentCache.size > (cfg.maxCache || 1000)) {
      const firstKey = this.recentCache.keys().next().value;
      this.recentCache.delete(firstKey);
    }
  },

  async onDelete(ctx, deletedIds, cfg) {
    if (!cfg.enabled) return;
    const out = [];
    for (const entry of deletedIds) {
      const key = `${entry.chatId}:${entry.msgId}`;
      const cached = this.recentCache.get(key);
      if (!cached) continue;
      out.push(cached);
      // Persist media if present
      if (cfg.saveMedia && cached.mediaBuf) {
        const dir = cfg.dir || path.join(process.cwd(), 'antidel-cache', String(entry.chatId));
        ensureDir(dir);
        const ext = cached.msg.fileName ? path.extname(cached.msg.fileName) : '';
        const filename = safeFileName(`del_${cached.msg.id}_${Date.now()}${ext || '.bin'}`);
        fs.writeFileSync(path.join(dir, filename), cached.mediaBuf);
      }
      this.recentCache.delete(key);
    }
    if (out.length) {
      ctx.log(`antidel: recovered ${out.length} deleted message(s)`);
      // Try to forward the recovered text/messages to the first admin's Saved Messages
      try {
        const adminId = ctx.adminIds[0];
        if (adminId) {
          const lines = out.map((c) => `[${c.msg.date || ''}] from ${c.msg.senderId || '?'} in ${c.msg.chatId}:\n${c.msg.text || '(media)'}`).join('\n\n---\n\n');
          await ctx.client.sendMessage('me', { message: `🗑 antidel — recovered ${out.length} deleted message(s):\n\n${lines.slice(0, 3500)}` });
        }
      } catch (e) {
        ctx.log(`antidel: notify failed: ${e.message}`);
      }
    }
  },

  command: {
    triggers: ['antidel'],
    async handler(ctx, args) {
      const cfg = ctx.automations.antidel;
      if (args[0] === 'on') { cfg.enabled = true; return 'antidel: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'antidel: OFF'; }
      if (args[0] === 'cache') return `antidel cache size: ${antidel.recentCache.size}/${cfg.maxCache}`;
      return `antidel: ${cfg.enabled ? 'ON' : 'OFF'} | cache: ${antidel.recentCache.size}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: antiedit — track edited messages
// ─────────────────────────────────────────────────────────────────────────

const antiedit = {
  name: 'antiedit',
  description: 'Log edited messages with the previous version.',
  defaultCfg: { enabled: false, chats: 'all', maxCache: 500, notify: true },
  editHistory: new Map(), // key: `${chatId}:${msgId}` -> [{text, date}]

  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    const key = `${msg.chatId}:${msg.id}`;
    if (!this.editHistory.has(key)) this.editHistory.set(key, []);
    this.editHistory.get(key).push({ text: msg.message || '', date: Date.now() });
    if (this.editHistory.get(key).length > 5) this.editHistory.get(key).shift();
    if (this.editHistory.size > (cfg.maxCache || 500)) {
      const firstKey = this.editHistory.keys().next().value;
      this.editHistory.delete(firstKey);
    }
  },

  async onEdit(ctx, msg, cfg) {
    if (!cfg.enabled || !cfg.notify) return;
    const key = `${msg.chatId}:${msg.id}`;
    const hist = this.editHistory.get(key) || [];
    const prev = hist[hist.length - 1];
    if (!prev) return;
    try {
      const adminId = ctx.adminIds[0];
      if (adminId) {
        await ctx.client.sendMessage('me', {
          message: `✏️ antiedit in ${msg.chatId} msg ${msg.id}:\n— before: ${(prev.text || '').slice(0, 800)}\n— after:  ${(msg.message || '').slice(0, 800)}`,
        });
      }
    } catch {}
  },

  command: {
    triggers: ['antiedit'],
    async handler(ctx, args) {
      const cfg = ctx.automations.antiedit;
      if (args[0] === 'on') { cfg.enabled = true; return 'antiedit: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'antidel: OFF'.replace('antidel', 'antiedit'); }
      return `antiedit: ${cfg.enabled ? 'ON' : 'OFF'} | tracked: ${antiedit.editHistory.size}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autoreply — canned keyword replies (no AI)
// ─────────────────────────────────────────────────────────────────────────

const autoreply = {
  name: 'autoreply',
  description: 'Reply to messages matching a keyword with a canned response. No AI required.',
  defaultCfg: {
    enabled: false,
    chats: 'all',
    skipOwn: true,
    rules: [
      { match: '^ping$', reply: 'pong' },
      { match: 'shrug', reply: '¯\\_(ツ)_/¯' },
    ],
  },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (cfg.skipOwn && msg.out) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    const text = msg.message || '';
    for (const rule of cfg.rules || []) {
      if (textMatches(rule.match, text)) {
        try {
          await ctx.client.sendMessage(msg.chatId, { message: rule.reply, replyTo: msg.id });
        } catch (e) {
          ctx.log(`autoreply failed: ${e.message}`);
        }
        return;
      }
    }
  },
  command: {
    triggers: ['autoreply'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autoreply;
      if (args[0] === 'on') { cfg.enabled = true; return 'autoreply: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autoreply: OFF'; }
      if (args[0] === 'add') {
        const match = args[1];
        const reply = args.slice(2).join(' ');
        if (!match || !reply) return 'usage: autoreply add <pattern> <reply text>';
        cfg.rules = cfg.rules || [];
        cfg.rules.push({ match, reply });
        return `autoreply rule added: /${match}/ → "${reply}"`;
      }
      if (args[0] === 'clear') { cfg.rules = []; return 'autoreply rules cleared'; }
      return `autoreply: ${cfg.enabled ? 'ON' : 'OFF'} | ${(cfg.rules || []).length} rule(s)`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autoforward — forward matching messages to a target chat
// ─────────────────────────────────────────────────────────────────────────

const autoforward = {
  name: 'autoforward',
  description: 'Forward messages matching a pattern from source chats to a target chat.',
  defaultCfg: { enabled: false, fromChats: [], toChat: 'me', match: null, onlyMedia: false },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (msg.out) return;
    if (!chatMatchesAny(cfg.fromChats, msg.chat)) return;
    if (cfg.onlyMedia && !msg.media) return;
    if (cfg.match && !textMatches(cfg.match, msg.message || '')) return;
    try {
      await ctx.client.forwardMessages(cfg.toChat, { messages: [msg] });
    } catch (e) {
      ctx.log(`autoforward failed: ${e.message}`);
    }
  },
  command: {
    triggers: ['autoforward'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autoforward;
      if (args[0] === 'on') { cfg.enabled = true; return 'autoforward: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autoforward: OFF'; }
      if (args[0] === 'target') { cfg.toChat = args[1]; return `autoforward target: ${cfg.toChat}`; }
      if (args[0] === 'match') { cfg.match = args[1] || null; return `autoforward match: ${cfg.match || '(any)'}`; }
      return `autoforward: ${cfg.enabled ? 'ON' : 'OFF'} → ${cfg.toChat}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autopurge — auto-delete your own messages after N seconds
// ─────────────────────────────────────────────────────────────────────────

const autopurge = {
  name: 'autopurge',
  description: 'Auto-delete your own messages after N seconds (in configured chats).',
  defaultCfg: { enabled: false, chats: 'all', afterSeconds: 300 },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (!msg.out) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    const delay = Math.max(1, cfg.afterSeconds || 300) * 1000;
    setTimeout(async () => {
      try {
        await ctx.client.deleteMessages(msg.chatId, [msg.id], { revoke: true });
      } catch (e) {
        ctx.log(`autopurge failed: ${e.message}`);
      }
    }, delay);
  },
  command: {
    triggers: ['autopurge'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autopurge;
      if (args[0] === 'on') { cfg.enabled = true; return `autopurge: ON (${cfg.afterSeconds}s)`; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autopurge: OFF'; }
      if (!isNaN(Number(args[0]))) { cfg.afterSeconds = Number(args[0]); return `autopurge: ${cfg.afterSeconds}s`; }
      return `autopurge: ${cfg.enabled ? 'ON' : 'OFF'} | ${cfg.afterSeconds}s`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autoread — mark all (or specific) chats as read
// ─────────────────────────────────────────────────────────────────────────

const autoread = {
  name: 'autoread',
  description: 'Mark messages as read automatically. "chats":"all" hits every chat.',
  defaultCfg: { enabled: false, chats: 'all' },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    try {
      await ctx.client.invoke(
        new ctx.Api.messages.ReadHistory({ peer: msg.chatId, maxId: msg.id })
      );
    } catch {}
  },
  command: {
    triggers: ['autoread'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autoread;
      if (args[0] === 'on') { cfg.enabled = true; return 'autoread: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autoread: OFF'; }
      return `autoread: ${cfg.enabled ? 'ON' : 'OFF'}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autotyping — show "typing…" in configured chats
// ─────────────────────────────────────────────────────────────────────────

const autotyping = {
  name: 'autotyping',
  description: 'Show "typing…" indicator in configured chats whenever a message arrives.',
  defaultCfg: { enabled: false, chats: 'all' },
  async onMessage(ctx, msg, cfg) {
    if (!cfg.enabled) return;
    if (!chatMatchesAny(cfg.chats, msg.chat)) return;
    try {
      await ctx.client.invoke(
        new ctx.Api.messages.SetTyping({ peer: msg.chatId, action: new ctx.Api.SendMessageTypingAction() })
      );
    } catch {}
  },
  command: {
    triggers: ['autotyping'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autotyping;
      if (args[0] === 'on') { cfg.enabled = true; return 'autotyping: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'autotyping: OFF'; }
      return `autotyping: ${cfg.enabled ? 'ON' : 'OFF'}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: autobio — rotate bio from a pool
// ─────────────────────────────────────────────────────────────────────────

const autobio = {
  name: 'autobio',
  description: 'Rotate your Telegram bio from a pool of strings on a timer.',
  defaultCfg: { enabled: false, intervalMinutes: 60, pool: ['building cool stuff', 'available', 'busy — DM me anyway'] },
  init(ctx) {
    const cfg = ctx.automations.autobio;
    if (!cfg.enabled) return {};
    const tick = async () => {
      if (!cfg.enabled) return;
      const text = pickRandom(cfg.pool || ['available']);
      if (!text) return;
      try {
        await ctx.client.invoke(new ctx.Api.account.UpdateProfile({ about: text }));
        ctx.log(`autobio: → "${text}"`);
      } catch (e) {
        ctx.log(`autobio failed: ${e.message}`);
      }
    };
    const ms = Math.max(1, cfg.intervalMinutes || 60) * 60_000;
    const timer = setInterval(tick, ms);
    // Fire once on startup so it takes effect immediately
    setTimeout(tick, 5000);
    return {
      stop: () => clearInterval(timer),
    };
  },
  command: {
    triggers: ['autobio'],
    async handler(ctx, args) {
      const cfg = ctx.automations.autobio;
      if (args[0] === 'on') {
        cfg.enabled = true;
        // restart timer
        if (ctx._automationTimers?.autobio) clearInterval(ctx._automationTimers.autobio);
        return 'autobio: ON';
      }
      if (args[0] === 'off') {
        cfg.enabled = false;
        if (ctx._automationTimers?.autobio) clearInterval(ctx._automationTimers.autobio);
        return 'autobio: OFF';
      }
      if (args[0] === 'add') {
        cfg.pool = cfg.pool || [];
        cfg.pool.push(args.slice(1).join(' '));
        return `autobio pool: ${cfg.pool.length} item(s)`;
      }
      if (args[0] === 'interval') {
        cfg.intervalMinutes = Number(args[1]) || 60;
        return `autobio interval: ${cfg.intervalMinutes}m`;
      }
      return `autobio: ${cfg.enabled ? 'ON' : 'OFF'} | ${(cfg.pool || []).length} item(s) | every ${cfg.intervalMinutes}m`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: antiraid — detect mass joins
// ─────────────────────────────────────────────────────────────────────────

const antiraid = {
  name: 'antiraid',
  description: 'Detect mass-join events in groups and react (log/leave).',
  defaultCfg: { enabled: false, windowSeconds: 10, joinThreshold: 5, action: 'log' },
  joinLog: new Map(), // chatId -> [timestamps]
  init(ctx) {
    return {
      onService: async (msg) => {
        const cfg = ctx.automations.antiraid;
        if (!cfg?.enabled) return;
        // Service messages about new members
        if (msg.action?.className?.startsWith('MessageActionChatAddUser') || msg.action?.className === 'MessageActionChatJoinedByLink') {
          const chatId = String(msg.chatId);
          const now = Date.now();
          const window = (cfg.windowSeconds || 10) * 1000;
          const log = this.joinLog.get(chatId) || [];
          log.push(now);
          // Trim to window
          while (log.length && now - log[0] > window) log.shift();
          this.joinLog.set(chatId, log);
          if (log.length >= (cfg.joinThreshold || 5)) {
            ctx.log(`antiraid: ${log.length} joins in ${cfg.windowSeconds}s in ${chatId}`);
            if (cfg.action === 'leave' && msg.chatId) {
              try {
                await ctx.client.invoke(new ctx.Api.messages.DeleteChat({ chatId: msg.chatId }));
                ctx.log(`antiraid: left chat ${chatId}`);
              } catch (e) {
                ctx.log(`antiraid: leave failed: ${e.message}`);
              }
            }
            this.joinLog.set(chatId, []);
          }
        }
      },
    };
  },
  command: {
    triggers: ['antiraid'],
    async handler(ctx, args) {
      const cfg = ctx.automations.antiraid;
      if (args[0] === 'on') { cfg.enabled = true; return 'antiraid: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'antiraid: OFF'; }
      if (args[0] === 'threshold') { cfg.joinThreshold = Number(args[1]) || 5; return `antiraid threshold: ${cfg.joinThreshold}`; }
      return `antiraid: ${cfg.enabled ? 'ON' : 'OFF'} | threshold: ${cfg.joinThreshold}/${cfg.windowSeconds}s`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: scheduler — cron-like recurring posts
// ─────────────────────────────────────────────────────────────────────────

const scheduler = {
  name: 'scheduler',
  description: 'Cron-like recurring posts. Format: "0 9 * * *" → 09:00 daily.',
  defaultCfg: { enabled: false, tasks: [] },
  // Tiny cron parser: minute hour day-of-month month day-of-week
  _matchCron(field, value, max) {
    if (field === '*') return true;
    const parts = field.split(',');
    return parts.some((p) => {
      if (p.includes('/')) {
        const [base, step] = p.split('/');
        const start = base === '*' ? 0 : Number(base);
        return value >= start && (value - start) % Number(step) === 0;
      }
      if (p.includes('-')) {
        const [a, b] = p.split('-').map(Number);
        return value >= a && value <= b;
      }
      return Number(p) === value;
    });
  },
  _checkCron(expr, date) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [min, hour, dom, mon, dow] = parts;
    return (
      this._matchCron(min, date.getMinutes(), 59) &&
      this._matchCron(hour, date.getHours(), 23) &&
      this._matchCron(dom, date.getDate(), 31) &&
      this._matchCron(mon, date.getMonth() + 1, 12) &&
      this._matchCron(dow, date.getDay(), 6)
    );
  },
  init(ctx) {
    const cfg = ctx.automations.scheduler;
    if (!cfg?.enabled) return {};
    let lastFired = new Map(); // taskId -> 'YYYY-MM-DD HH:MM'
    const tick = async () => {
      if (!cfg.enabled) return;
      const now = new Date();
      const stamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
      for (let i = 0; i < (cfg.tasks || []).length; i++) {
        const t = cfg.tasks[i];
        if (!t.cron) continue;
        if (lastFired.get(i) === stamp) continue;
        if (this._checkCron(t.cron, now)) {
          lastFired.set(i, stamp);
          try {
            await ctx.client.sendMessage(t.chat || 'me', { message: t.text || '' });
            ctx.log(`scheduler: fired task ${i} → ${t.chat || 'me'}`);
          } catch (e) {
            ctx.log(`scheduler: task ${i} failed: ${e.message}`);
          }
        }
      }
    };
    const timer = setInterval(tick, 30_000); // check every 30s
    return { stop: () => clearInterval(timer) };
  },
  command: {
    triggers: ['scheduler'],
    async handler(ctx, args) {
      const cfg = ctx.automations.scheduler;
      if (args[0] === 'on') { cfg.enabled = true; return 'scheduler: ON'; }
      if (args[0] === 'off') { cfg.enabled = false; return 'scheduler: OFF'; }
      if (args[0] === 'add') {
        const cron = args[1];
        const chat = args[2];
        const text = args.slice(3).join(' ');
        if (!cron || !text) return 'usage: scheduler add <cron> <chat> <text>';
        cfg.tasks = cfg.tasks || [];
        cfg.tasks.push({ cron, chat, text });
        return `scheduler task added: "${cron}" → ${chat}: "${text.slice(0, 40)}..."`;
      }
      if (args[0] === 'list') {
        return (cfg.tasks || []).map((t, i) => `${i}: ${t.cron} → ${t.chat}: ${(t.text || '').slice(0, 40)}`).join('\n') || '(no tasks)';
      }
      if (args[0] === 'remove') {
        cfg.tasks.splice(Number(args[1]) || 0, 1);
        return 'scheduler task removed';
      }
      return `scheduler: ${cfg.enabled ? 'ON' : 'OFF'} | ${(cfg.tasks || []).length} task(s)`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: zipchannel — extract all media from a channel → zip → DM you
// ─────────────────────────────────────────────────────────────────────────

const zipchannel = {
  name: 'zipchannel',
  description: 'Download all media from a channel, zip it, and send the zip to your Saved Messages.',
  defaultCfg: { enabled: true, maxItems: 50 },
  command: {
    triggers: ['zipchannel', 'extractchannel', 'dumpchannel'],
    async handler(ctx, args) {
      const source = args[0];
      const max = Number(args[1]) || ctx.automations.zipchannel?.maxItems || 50;
      if (!source) return 'usage: zipchannel <@channel|id> [max]';
      await ctx.client.sendMessage(ctx.chatId, { message: `⏳ extracting up to ${max} media from ${source}...` });
      try {
        const messages = await ctx.client.getMessages(source, { limit: max });
        const mediaMsgs = messages.filter((m) => m.media);
        if (!mediaMsgs.length) return `no media found in ${source} (last ${max} messages)`;

        const archiver = require('archiver');
        const tmpZip = path.join(ctx.downloadDir, `channel_${safeFileName(source)}_${Date.now()}.zip`);
        ensureDir(path.dirname(tmpZip));
        const output = fs.createWriteStream(tmpZip);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.pipe(output);

        let saved = 0;
        for (const m of mediaMsgs) {
          try {
            const buf = await ctx.client.downloadMedia(m, {});
            if (!buf) continue;
            const ext = m.fileName ? path.extname(m.fileName) :
              m.photo ? '.jpg' : m.video ? '.mp4' : m.voice ? '.ogg' : '.bin';
            const fname = safeFileName(`${m.id}_${m.date || ''}${ext}`);
            archive.append(buf, { name: fname });
            saved++;
            // also write metadata
            archive.append(JSON.stringify({ id: m.id, date: m.date, caption: m.message || '' }, null, 2), { name: `${fname}.meta.json` });
          } catch (e) {
            ctx.log(`zipchannel: skip ${m.id}: ${e.message}`);
          }
        }
        await archive.finalize();
        await new Promise((res) => output.on('close', res));

        // Send zip to admin's Saved Messages AND the requesting chat
        const stat = fs.statSync(tmpZip);
        const adminId = ctx.adminIds[0];
        if (adminId) {
          await ctx.client.sendMessage('me', { message: `📦 ${source}: ${saved} media (${(stat.size / 1024 / 1024).toFixed(2)} MB)` });
          await ctx.client.sendFile('me', { file: tmpZip, caption: `${source} — ${saved} items` });
        }
        await ctx.client.sendFile(ctx.chatId, { file: tmpZip, caption: `${source} — ${saved} items, ${(stat.size / 1024 / 1024).toFixed(2)} MB` });
        return `✅ zipchannel: ${saved} media → ${(stat.size / 1024 / 1024).toFixed(2)} MB`;
      } catch (e) {
        return `zipchannel failed: ${e.message}`;
      }
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Automation: all — show status of every automation
// ─────────────────────────────────────────────────────────────────────────

const allCommand = {
  name: 'all',
  description: 'Show status of every automation.',
  defaultCfg: {},
  command: {
    triggers: ['automations', 'autostatus'],
    async handler(ctx) {
      const lines = Object.entries(ctx.automations).map(([k, v]) => {
        if (k === 'allCommand' || k === 'zipchannel') return null;
        const on = v?.enabled ? 'ON ' : 'OFF';
        return `${on}  ${k}`;
      }).filter(Boolean);
      return `Automations:\n${lines.join('\n')}\n\nAI mode: ${ctx.aiMode}`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Mode control: ai on/off/hybrid
// ─────────────────────────────────────────────────────────────────────────

const modeCommand = {
  name: 'mode',
  description: 'AI mode control: on | off | hybrid',
  defaultCfg: {},
  command: {
    triggers: ['mode', 'ai'],
    async handler(ctx, args) {
      const m = String(args[0] || '').toLowerCase();
      if (['on', 'off', 'hybrid'].includes(m)) {
        ctx.aiMode = m;
        return `AI mode: ${m}\n${m === 'off' ? '(commands still work, no LLM calls)' : m === 'on' ? '(every DM goes through LLM)' : '(commands skip AI, DMs use AI)'}`;
      }
      return `AI mode: ${ctx.aiMode}\nusage: mode on | off | hybrid`;
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────

const AUTOMATIONS = [
  autolike,
  autoreact,
  autopost,
  autosave,
  antidel,
  antiedit,
  autoreply,
  autoforward,
  autopurge,
  autoread,
  autotyping,
  autobio,
  antiraid,
  scheduler,
  zipchannel,
  allCommand,
  modeCommand,
];

// Build trigger -> automation lookup
const TRIGGER_MAP = new Map();
for (const a of AUTOMATIONS) {
  if (a.command?.triggers) {
    for (const t of a.command.triggers) {
      TRIGGER_MAP.set(t.toLowerCase(), a);
    }
  }
}

function loadAutomations(userCfg) {
  const cfg = {};
  for (const a of AUTOMATIONS) {
    cfg[a.name] = { ...(a.defaultCfg || {}), ...((userCfg && userCfg[a.name]) || {}) };
  }
  return cfg;
}

function resolveCommand(text) {
  // Strip leading slash/dot if present; returns { name, args, raw } or null
  const trimmed = text.trim();
  if (!trimmed) return null;
  let body = trimmed;
  if (body.startsWith('/') || body.startsWith('.')) body = body.slice(1);
  const firstSpace = body.search(/\s/);
  const name = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? [] : body.slice(firstSpace + 1).trim().split(/\s+/);
  if (!TRIGGER_MAP.has(name)) return null;
  return { name, args, raw: body };
}

module.exports = {
  AUTOMATIONS,
  TRIGGER_MAP,
  loadAutomations,
  resolveCommand,
  // expose modules for testing
  _modules: { autolike, autoreact, autopost, autosave, antidel, antiedit, autoreply, autoforward, autopurge, autoread, autotyping, autobio, antiraid, scheduler, zipchannel, allCommand, modeCommand },
};
