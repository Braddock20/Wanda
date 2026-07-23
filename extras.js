// extras.js — the v3 command surface: env editing, reply-based media tools,
// channel export variants, hybrid command parsing, utility commands.
//
// Designed to slot into the existing automation-engine plugin system:
//   - Pure helpers are exported for the smoke test
//   - Automation-style commands (triggers + handler) are exported in
//     EXTRA_COMMANDS and merged by automation-engine.js
//
// All side-effecting commands are admin-gated. Pure helpers (parseEnvLine,
// maskSecret, parseHybrid, parseChain) are safe to call anywhere.

'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────
// Env parsing & safe editing
// ─────────────────────────────────────────────────────────────────────────

// Minimal .env parser. Handles KEY=VALUE, "quoted values", and # comments.
// Returns { key: rawValue, ... }.
function parseEnvText(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function serializeEnv(obj) {
  const lines = ['# ─── gramjs-bot .env (managed by setenv / unsetenv) ───'];
  const keys = Object.keys(obj);
  for (const k of keys) {
    const v = obj[k];
    // Quote if it has spaces or special chars
    if (/[\s#"']/.test(v)) {
      lines.push(`${k}="${v.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${k}=${v}`);
    }
  }
  return lines.join('\n') + '\n';
}

// Decide whether a value looks like a secret we should mask in `getenv`.
const SECRET_HINTS = /KEY|TOKEN|SECRET|PASSWORD|PASS|HASH|STRING/i;
function maskSecret(key, value) {
  if (!value) return '(empty)';
  if (!SECRET_HINTS.test(key)) return value;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)} (${value.length} chars)`;
}

// Whitelist of env keys that `setenv` will write. Block anything sensitive
// from being clobbered accidentally.
const ENV_BLOCKLIST = ['API_ID', 'API_HASH', 'SESSION_STRING'];
const ENV_REQUIRES_RESTART = ['API_ID', 'API_HASH', 'SESSION_STRING', 'AGENT_ADMIN_IDS', 'AGENT_CHANNELS', 'AGENT_PROVIDERS', 'AGENT_TOOLS', 'AUTOMATIONS'];

function editEnvFile(envPath, edits, mode /* 'merge' | 'replace' */) {
  // edits: { key: value | null }  (null means unset)
  let current = {};
  if (fs.existsSync(envPath)) {
    current = parseEnvText(fs.readFileSync(envPath, 'utf8'));
  }
  const next = mode === 'replace' ? {} : { ...current };
  const changed = [];
  const removed = [];
  for (const [k, v] of Object.entries(edits)) {
    if (v === null || v === undefined) {
      if (k in next) { delete next[k]; removed.push(k); }
    } else {
      if (next[k] !== String(v)) {
        next[k] = String(v);
        changed.push(k);
      }
    }
  }
  fs.writeFileSync(envPath, serializeEnv(next));
  return { changed, removed, allKeys: Object.keys(next).sort() };
}

// ─────────────────────────────────────────────────────────────────────────
// Hybrid command parser: "autolike+autoreact+antiread on"
// Also accepts "autolike+autoreact on,off,on"
// Returns [{name, args: ['on']}, ...] or null on parse failure.
// ─────────────────────────────────────────────────────────────────────────

function parseHybrid(text) {
  // Allowed: a+b+c on    or    a+b on,off    or    a on
  const m = String(text || '').trim().match(/^([a-zA-Z0-9_+\-]+(?:\+[a-zA-Z0-9_+\-]+)*)\s+(.+)$/);
  if (!m) return null;
  const names = m[1].toLowerCase().split('+');
  const tail = m[2].trim();
  // Tail can be a single word ("on") or a comma-list aligned to names length.
  let argsList;
  if (tail.includes(',')) {
    argsList = tail.split(',').map((s) => s.trim());
    if (argsList.length !== names.length) {
      // If it's a single comma-list shorter than names, repeat the last one
      while (argsList.length < names.length) argsList.push(argsList[argsList.length - 1]);
    }
  } else {
    argsList = names.map(() => tail);
  }
  return names.map((n, i) => ({ name: n, args: argsList[i].split(/\s+/) }));
}

// ─────────────────────────────────────────────────────────────────────────
// Chain parser: 'autolike on | autoreact on | antiread on'
// Returns ['autolike on', 'autoreact on', 'antiread on']
// ─────────────────────────────────────────────────────────────────────────

function parseChain(text) {
  // Allow | ; or && as separators
  return String(text || '')
    .split(/\s*(?:\||;|&&)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────
// Catbox.moe upload (no API key required for free tier)
// Used by the `tourl` command. Returns { url, error? }.
// ─────────────────────────────────────────────────────────────────────────

async function uploadToCatbox(buffer, filename) {
  // Node 18+ global fetch, native FormData
  if (typeof fetch !== 'function' || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    return { error: 'fetch/FormData/Blob not available — need Node 18+' };
  }
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('fileToUpload', new Blob([buffer]), filename || 'upload.bin');
  try {
    const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
    const text = (await res.text()).trim();
    if (!res.ok) return { error: `catbox ${res.status}: ${text.slice(0, 200)}` };
    if (!/^https?:\/\//.test(text)) return { error: `catbox returned non-url: ${text.slice(0, 200)}` };
    return { url: text };
  } catch (e) {
    return { error: `catbox upload failed: ${e.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Media download helper used by reply-based commands
// ─────────────────────────────────────────────────────────────────────────

async function getReplyMedia(client, msg) {
  // msg: the message containing the command. We need the message it's replying to.
  if (!msg.replyTo && !msg.replyToMessage) return { error: 'reply to a media message first' };
  const replyId = typeof msg.replyTo === 'object' ? msg.replyTo?.replyToMsgId : msg.replyTo;
  let targetId = replyId;
  if (!targetId && msg.replyToMessage) targetId = msg.replyToMessage.id;
  if (!targetId) return { error: 'no replied message found' };
  const messages = await client.getMessages(msg.chatId, { ids: [targetId] });
  const m = messages?.[0];
  if (!m) return { error: 'replied message not found' };
  if (!m.media) return { error: 'replied message has no media' };
  const buffer = await client.downloadMedia(m, {});
  if (!buffer) return { error: 'download returned empty' };
  return { buffer, message: m };
}

function extForMessage(m) {
  if (m.fileName) return path.extname(m.fileName) || '.bin';
  if (m.photo) return '.jpg';
  if (m.video) return '.mp4';
  if (m.voice) return '.ogg';
  if (m.audio) return '.mp3';
  if (m.document) return '.bin';
  return '.bin';
}

function safeName(s) {
  return String(s || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

// ─────────────────────────────────────────────────────────────────────────
// v3 commands — registered as automation-style triggers
// ─────────────────────────────────────────────────────────────────────────

const EXTRA_COMMANDS = {
  // ── Env editing ───────────────────────────────────────────────────────
  setenv: {
    triggers: ['setenv', 'editenv'],
    async handler(ctx, args) {
      const [k, ...rest] = args;
      const v = rest.join(' ').trim();
      if (!k) return 'usage: setenv KEY VALUE    (value with spaces: setenv KEY "hello world")';
      if (v === '' || v === '""' || v === "''") {
        return 'usage: setenv KEY VALUE    (use unsetenv KEY to remove)';
      }
      // Strip matching quotes
      let value = v;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (ENV_BLOCKLIST.includes(k.toUpperCase())) {
        return `refusing to edit ${k} via chat — edit .env directly to avoid lockout`;
      }
      const envPath = path.join(__dirname, '.env');
      try {
        const result = editEnvFile(envPath, { [k]: value }, 'merge');
        // Apply to live process where possible
        const prev = process.env[k];
        process.env[k] = value;
        const needsRestart = ENV_REQUIRES_RESTART.includes(k.toUpperCase());
        const lines = [];
        if (result.changed.length) lines.push(`✏️  ${k} = ${SECRET_HINTS.test(k) ? maskSecret(k, value) : value}`);
        else lines.push(`(no change) ${k}`);
        if (needsRestart) lines.push(`⚠️  ${k} takes effect on next restart.`);
        if (prev !== value && !needsRestart) lines.push(`✅ applied to live process.`);
        return lines.join('\n');
      } catch (e) {
        return `setenv failed: ${e.message}`;
      }
    },
  },

  unsetenv: {
    triggers: ['unsetenv', 'delenv'],
    async handler(ctx, args) {
      const k = args[0];
      if (!k) return 'usage: unsetenv KEY';
      if (ENV_BLOCKLIST.includes(k.toUpperCase())) return `refusing to remove ${k}`;
      const envPath = path.join(__dirname, '.env');
      try {
        const result = editEnvFile(envPath, { [k]: null }, 'merge');
        delete process.env[k];
        if (result.removed.length) return `🗑️  removed ${k}`;
        return `${k} was not set`;
      } catch (e) {
        return `unsetenv failed: ${e.message}`;
      }
    },
  },

  getenv: {
    triggers: ['getenv'],
    async handler(ctx, args) {
      const k = args[0];
      if (!k) return 'usage: getenv KEY';
      const v = process.env[k];
      if (v == null) return `${k}: (not set)`;
      return `${k} = ${maskSecret(k, v)}`;
    },
  },

  envlist: {
    triggers: ['envlist', 'envs'],
    async handler(ctx, args) {
      const envPath = path.join(__dirname, '.env');
      let parsed = {};
      if (fs.existsSync(envPath)) parsed = parseEnvText(fs.readFileSync(envPath, 'utf8'));
      // Merge with live env
      const all = { ...parsed };
      for (const k of Object.keys(process.env)) all[k] = process.env[k];
      const keys = Object.keys(all).sort();
      const filter = (args[0] || '').toLowerCase();
      const shown = filter ? keys.filter((k) => k.toLowerCase().includes(filter)) : keys;
      if (!shown.length) return filter ? `no env keys matching "${filter}"` : 'no env keys found';
      const lines = shown.map((k) => `  ${k} = ${maskSecret(k, all[k])}`);
      return `env (${shown.length}/${keys.length}):\n${lines.join('\n')}`;
    },
  },

  envreload: {
    triggers: ['envreload'],
    async handler(ctx, args) {
      const envPath = path.join(__dirname, '.env');
      if (!fs.existsSync(envPath)) return 'no .env file';
      const parsed = parseEnvText(fs.readFileSync(envPath, 'utf8'));
      let applied = 0;
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] !== v) { process.env[k] = v; applied++; }
      }
      return `envreload: applied ${applied} new/updated values (sensitive keys need a restart)`;
    },
  },

  // ── Reply-based media commands ────────────────────────────────────────
  tourl: {
    triggers: ['tourl', 'upload'],
    async handler(ctx, args) {
      let target;
      try { target = await getReplyMedia(ctx.client, ctx.msg); }
      catch (e) { return `tourl: ${e.message}`; }
      if (target.error) return `tourl: ${target.error}`;
      const ext = extForMessage(target.message);
      const filename = `${target.message.id}_${Date.now()}${ext}`;
      const res = await uploadToCatbox(target.buffer, filename);
      if (res.error) return `tourl: ${res.error}`;
      return `🔗 ${res.url}`;
    },
  },

  save: {
    triggers: ['save', 'dlmedia', 'download'],
    async handler(ctx, args) {
      let target;
      try { target = await getReplyMedia(ctx.client, ctx.msg); }
      catch (e) { return `save: ${e.message}`; }
      if (target.error) return `save: ${target.error}`;
      const ext = extForMessage(target.message);
      const filename = `${target.message.id}_${Date.now()}${ext}`;
      const localPath = path.join(ctx.downloadDir, filename);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, target.buffer);
      return `saved → ${localPath} (${(target.buffer.length / 1024).toFixed(1)} KB)`;
    },
  },

  react: {
    triggers: ['react'],
    async handler(ctx, args) {
      const emoji = args[0];
      if (!emoji) return 'usage: reply to a message, then: react <emoji>';
      if (!ctx.msg.replyTo && !ctx.msg.replyToMessage) return 'reply to a message first';
      const targetId = (typeof ctx.msg.replyTo === 'object' ? ctx.msg.replyTo?.replyToMsgId : ctx.msg.replyTo) || ctx.msg.replyToMessage?.id;
      if (!targetId) return 'no replied message id';
      try {
        await ctx.client.invoke(new ctx.Api.messages.SendReaction({
          peer: ctx.msg.chatId, msgId: targetId,
          reaction: [new ctx.Api.ReactionEmoji({ emoticon: emoji })], big: false,
        }));
        return `reacted ${emoji}`;
      } catch (e) {
        return `react failed: ${e.message}`;
      }
    },
  },

  pin: {
    triggers: ['pin'],
    async handler(ctx, args) {
      if (!ctx.msg.replyTo && !ctx.msg.replyToMessage) return 'reply to a message first';
      const targetId = (typeof ctx.msg.replyTo === 'object' ? ctx.msg.replyTo?.replyToMsgId : ctx.msg.replyTo) || ctx.msg.replyToMessage?.id;
      try {
        await ctx.client.invoke(new ctx.Api.messages.UpdatePinnedMessage({ peer: ctx.msg.chatId, id: targetId, unpin: false }));
        return 'pinned';
      } catch (e) { return `pin failed: ${e.message}`; }
    },
  },

  unpin: {
    triggers: ['unpin'],
    async handler(ctx, args) {
      if (!ctx.msg.replyTo && !ctx.msg.replyToMessage) return 'reply to a message first';
      const targetId = (typeof ctx.msg.replyTo === 'object' ? ctx.msg.replyTo?.replyToMsgId : ctx.msg.replyTo) || ctx.msg.replyToMessage?.id;
      try {
        await ctx.client.invoke(new ctx.Api.messages.UpdatePinnedMessage({ peer: ctx.msg.chatId, id: targetId, unpin: true }));
        return 'unpinned';
      } catch (e) { return `unpin failed: ${e.message}`; }
    },
  },

  copy: {
    triggers: ['copy', 'forwardto'],
    async handler(ctx, args) {
      const dest = args[0];
      if (!dest) return 'usage: reply to a media, then: copy <@chat|id|"me">';
      if (!ctx.msg.replyTo && !ctx.msg.replyToMessage) return 'reply to a message first';
      const targetId = (typeof ctx.msg.replyTo === 'object' ? ctx.msg.replyTo?.replyToMsgId : ctx.msg.replyTo) || ctx.msg.replyToMessage?.id;
      try {
        const msgs = await ctx.client.getMessages(ctx.msg.chatId, { ids: [targetId] });
        if (!msgs?.length) return 'message not found';
        await ctx.client.forwardMessages(dest, { messages: msgs });
        return `forwarded to ${dest}`;
      } catch (e) { return `copy failed: ${e.message}`; }
    },
  },

  // ── Channel export variants ───────────────────────────────────────────
  ziptext: {
    triggers: ['ziptext', 'exporttext'],
    async handler(ctx, args) {
      const source = args[0];
      const max = Number(args[1]) || 500;
      if (!source) return 'usage: ziptext <@channel|id> [max]';
      await ctx.client.sendMessage(ctx.chatId, { message: `⏳ ziptext: pulling up to ${max} text messages from ${source}...` });
      try {
        const messages = await ctx.client.getMessages(source, { limit: max });
        const items = messages.filter((m) => (m.message || '').trim()).map((m) => ({
          id: m.id,
          date: m.date,
          senderId: m.senderId,
          text: m.message,
          hasMedia: !!m.media,
        }));
        if (!items.length) return `no text messages in ${source} (last ${max})`;
        const archiver = require('archiver');
        const tmp = path.join(ctx.downloadDir, `text_${safeName(source)}_${Date.now()}.zip`);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        const out = fs.createWriteStream(tmp);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.pipe(out);
        archive.append(JSON.stringify({ source, count: items.length, exportedAt: new Date().toISOString(), messages: items }, null, 2), { name: 'messages.json' });
        // Also write NDJSON for streaming
        archive.append(items.map((i) => JSON.stringify(i)).join('\n'), { name: 'messages.ndjson' });
        await archive.finalize();
        await new Promise((res) => out.on('close', res));
        const stat = fs.statSync(tmp);
        if (ctx.adminIds[0]) await ctx.client.sendFile('me', { file: tmp, caption: `${source} text export` });
        await ctx.client.sendFile(ctx.chatId, { file: tmp, caption: `${source} — ${items.length} text msgs, ${(stat.size / 1024).toFixed(1)} KB` });
        return `✅ ziptext: ${items.length} text messages → ${(stat.size / 1024).toFixed(1)} KB`;
      } catch (e) { return `ziptext failed: ${e.message}`; }
    },
  },

  zipall: {
    triggers: ['zipall'],
    async handler(ctx, args) {
      const source = args[0];
      if (!source) return 'usage: zipall <@channel|id> [batch=100]';
      const batch = Number(args[1]) || 100;
      await ctx.client.sendMessage(ctx.chatId, { message: `⏳ zipall: iterating through ${source} in batches of ${batch}...` });
      try {
        const archiver = require('archiver');
        const tmp = path.join(ctx.downloadDir, `all_${safeName(source)}_${Date.now()}.zip`);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        const out = fs.createWriteStream(tmp);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.pipe(out);
        let totalMsgs = 0; let totalMedia = 0; let lastId = 0; let iter = 0;
        while (true) {
          iter++;
          const opts = { limit: batch };
          if (lastId) opts.offsetId = lastId;
          const messages = await ctx.client.getMessages(source, opts);
          if (!messages.length) break;
          for (const m of messages) {
            totalMsgs++;
            if (m.media) {
              try {
                const buf = await ctx.client.downloadMedia(m, {});
                if (buf) {
                  const ext = extForMessage(m);
                  const fname = safeName(`${m.id}_${m.date || ''}${ext}`);
                  archive.append(buf, { name: fname });
                  archive.append(JSON.stringify({ id: m.id, date: m.date, caption: m.message || '' }, null, 2), { name: `${fname}.meta.json` });
                  totalMedia++;
                }
              } catch (e) { /* skip */ }
            } else if ((m.message || '').trim()) {
              archive.append(m.message + '\n', { name: `text/${m.id}.txt` });
            }
            lastId = m.id;
          }
          // safety cap
          if (totalMsgs >= 5000) {
            archive.append(`(truncated at 5000 messages)\n`, { name: 'TRUNCATED.txt' });
            break;
          }
          if (messages.length < batch) break;
        }
        await archive.finalize();
        await new Promise((res) => out.on('close', res));
        const stat = fs.statSync(tmp);
        if (ctx.adminIds[0]) await ctx.client.sendFile('me', { file: tmp, caption: `${source} full export` });
        await ctx.client.sendFile(ctx.chatId, { file: tmp, caption: `${source} — ${totalMsgs} msgs, ${totalMedia} media, ${(stat.size / 1024 / 1024).toFixed(2)} MB` });
        return `✅ zipall: ${totalMsgs} messages, ${totalMedia} media → ${(stat.size / 1024 / 1024).toFixed(2)} MB`;
      } catch (e) { return `zipall failed: ${e.message}`; }
    },
  },

  ziprange: {
    triggers: ['ziprange'],
    async handler(ctx, args) {
      const [source, fromId, toId] = args;
      if (!source || !fromId || !toId) return 'usage: ziprange <@channel|id> <fromMsgId> <toMsgId>';
      const from = Number(fromId); const to = Number(toId);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return 'msg ids must be numbers';
      const min = Math.min(from, to); const max = Math.max(from, to);
      await ctx.client.sendMessage(ctx.chatId, { message: `⏳ ziprange: ${min}..${max} in ${source}...` });
      try {
        const archiver = require('archiver');
        const tmp = path.join(ctx.downloadDir, `range_${safeName(source)}_${min}_${max}.zip`);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        const out = fs.createWriteStream(tmp);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.pipe(out);
        const ids = [];
        for (let i = max; i >= min; i--) ids.push(i);
        // Telegram's getMessages with a long id list may rate-limit, chunk it
        const CHUNK = 100;
        let mediaCount = 0; let textCount = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK);
          const msgs = await ctx.client.getMessages(source, { ids: slice });
          for (const m of msgs) {
            if (!m) continue;
            if (m.media) {
              try {
                const buf = await ctx.client.downloadMedia(m, {});
                if (buf) {
                  const ext = extForMessage(m);
                  const fname = safeName(`${m.id}_${m.date || ''}${ext}`);
                  archive.append(buf, { name: fname });
                  archive.append(JSON.stringify({ id: m.id, date: m.date, caption: m.message || '' }, null, 2), { name: `${fname}.meta.json` });
                  mediaCount++;
                }
              } catch (e) { /* skip */ }
            } else if ((m.message || '').trim()) {
              archive.append(m.message + '\n', { name: `text/${m.id}.txt` });
              textCount++;
            }
          }
        }
        await archive.finalize();
        await new Promise((res) => out.on('close', res));
        const stat = fs.statSync(tmp);
        await ctx.client.sendFile(ctx.chatId, { file: tmp, caption: `${source} ${min}..${max} — ${mediaCount} media, ${textCount} text` });
        return `✅ ziprange: ${mediaCount} media + ${textCount} text → ${(stat.size / 1024).toFixed(1)} KB`;
      } catch (e) { return `ziprange failed: ${e.message}`; }
    },
  },

  // ── Utility ───────────────────────────────────────────────────────────
  ping: {
    triggers: ['ping'],
    async handler(ctx, args) {
      const t0 = Date.now();
      await new Promise((r) => setImmediate(r));
      return `pong — ${Date.now() - t0}ms loop / ${process.uptime().toFixed(0)}s uptime`;
    },
  },

  uptime: {
    triggers: ['uptime'],
    async handler(ctx, args) {
      const s = process.uptime();
      const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = Math.floor(s % 60);
      return `uptime: ${h}h ${m}m ${sec}s`;
    },
  },

  id: {
    triggers: ['id', 'ids'],
    async handler(ctx, args) {
      const m = ctx.msg;
      return [
        `chat: ${m.chatId}`,
        `msg: ${m.id}`,
        `sender: ${m.senderId || m.fromId?.userId || '?'}`,
        `isPrivate: ${!!m.isPrivate}`,
        `isChannel: ${!!m.isChannel}`,
        `isGroup: ${!!m.isGroup}`,
      ].join('\n');
    },
  },

  health: {
    triggers: ['health'],
    async handler(ctx, args) {
      const enabled = Object.entries(ctx.automations).filter(([, v]) => v?.enabled).map(([k]) => k);
      const mem = process.memoryUsage();
      const lines = [
        `mode: ${ctx.aiMode}`,
        `uptime: ${process.uptime().toFixed(0)}s`,
        `mem: rss ${(mem.rss / 1024 / 1024).toFixed(1)}MB / heap ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`,
        `automations: ${enabled.length} enabled (${enabled.join(', ') || 'none'})`,
        `node: ${process.version}`,
      ];
      return lines.join('\n');
    },
  },

  stats: {
    triggers: ['stats'],
    async handler(ctx, args) {
      const m = process.memoryUsage();
      return [
        `messages: ${(require.cache && Object.keys(require.cache).length) || 0} modules cached`,
        `heap: ${(m.heapUsed / 1024 / 1024).toFixed(2)}MB used / ${(m.heapTotal / 1024 / 1024).toFixed(2)}MB total`,
        `rss: ${(m.rss / 1024 / 1024).toFixed(2)}MB`,
        `external: ${(m.external / 1024 / 1024).toFixed(2)}MB`,
        `pid: ${process.pid}`,
        `node: ${process.version}`,
      ].join('\n');
    },
  },

  // ── Hybrid + chain commands ───────────────────────────────────────────
  hybrid: {
    triggers: ['hybrid', 'multi'],
    async handler(ctx, args) {
      const text = args.join(' ');
      if (!text) return 'usage: hybrid <name>+<name2>+... on|off|on,off\n  e.g. hybrid autolike+autoreact+antiread on';
      const parsed = parseHybrid(text);
      if (!parsed) return 'could not parse hybrid command';
      const results = [];
      for (const { name, args: a } of parsed) {
        const trigger = ctx.engine.TRIGGER_MAP.get(name);
        if (!trigger) { results.push(`${name}: ❌ unknown`); continue; }
        try {
          const reply = await trigger.command.handler(
            { client: ctx.client, chatId: ctx.chatId, automations: ctx.automations, adminIds: ctx.adminIds, channelConfig: ctx.channelConfig, downloadDir: ctx.downloadDir, aiMode: ctx.aiMode, log: ctx.log, _automationTimers: ctx._automationTimers },
            a
          );
          results.push(`${name}: ${reply || 'ok'}`);
        } catch (e) {
          results.push(`${name}: ❌ ${e.message}`);
        }
      }
      return `hybrid:\n${results.join('\n')}`;
    },
  },

  chain: {
    triggers: ['chain', 'pipeline'],
    async handler(ctx, args) {
      const text = args.join(' ');
      if (!text) return 'usage: chain "cmd1 | cmd2 | cmd3"   (| or ; or && as separators)';
      const cmds = parseChain(text);
      if (!cmds.length) return 'empty chain';
      const results = [];
      for (const c of cmds) {
        const resolved = ctx.engine.resolveCommand(c);
        if (!resolved) { results.push(`${c}: ❌ unknown`); continue; }
        const trigger = ctx.engine.TRIGGER_MAP.get(resolved.name);
        if (!trigger) { results.push(`${c}: ❌ unknown`); continue; }
        try {
          const reply = await trigger.command.handler(
            { client: ctx.client, chatId: ctx.chatId, automations: ctx.automations, adminIds: ctx.adminIds, channelConfig: ctx.channelConfig, downloadDir: ctx.downloadDir, aiMode: ctx.aiMode, log: ctx.log, _automationTimers: ctx._automationTimers },
            resolved.args
          );
          results.push(`${c}: ${reply || 'ok'}`);
        } catch (e) {
          results.push(`${c}: ❌ ${e.message}`);
        }
      }
      return `chain (${cmds.length} steps):\n${results.join('\n')}`;
    },
  },

  // ── Mode extras ──────────────────────────────────────────────────────
  help: {
    triggers: ['help', 'commands', '?'],
    async handler(ctx, args) {
      const lines = [
        '── gramjs-bot v3 commands ──',
        'Prefix-free for admins. / or . also works.',
        '',
        '── Env (edit .env from chat) ──',
        '  setenv KEY VALUE       — set a .env value, live where possible',
        '  unsetenv KEY           — remove a .env key',
        '  getenv KEY             — read (masked if secret)',
        '  envlist [filter]       — list all env keys',
        '  envreload              — re-read .env from disk',
        '',
        '── Reply-based media (reply to a message) ──',
        '  tourl                  — upload replied media to catbox.moe, get link',
        '  save                   — download replied media to disk',
        '  react <emoji>          — react to replied message',
        '  pin / unpin            — pin/unpin replied message',
        '  copy <@chat>           — forward replied media to another chat',
        '',
        '── Channel export ──',
        '  zipchannel <@chan> [n] — media only (existing)',
        '  ziptext <@chan> [n]    — text only, as JSON+NDJSON',
        '  zipall <@chan>         — every media ever (capped 5000)',
        '  ziprange <@chan> a b   — media between two msg ids',
        '',
        '── Hybrid / chain ──',
        '  hybrid a+b+c on        — toggle multiple at once',
        '  chain "a on | b on"    — run a pipeline',
        '',
        '── Utility ──',
        '  ping / uptime / id / health / stats / whoami',
        '  help / tools / automations / mode on|off|hybrid / reset',
        '',
        '── AI tools (LLM) ──',
        '  27 native tools + your custom AGENT_TOOLS',
        '  In DMs the bot auto-routes to the LLM agent',
        '  AI mode off: commands work, no LLM calls',
      ];
      return lines.join('\n');
    },
  },
};

module.exports = {
  EXTRA_COMMANDS,
  parseEnvText, serializeEnv, editEnvFile, maskSecret, parseHybrid, parseChain,
  uploadToCatbox, getReplyMedia, extForMessage, safeName,
  ENV_BLOCKLIST, ENV_REQUIRES_RESTART, SECRET_HINTS,
};
