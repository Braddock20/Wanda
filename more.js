// more.js — chat management + media commands from the menu reference.
// All admin-only, all peer-safe (uses peer.resolveInputPeer), all
// error-handled.

'use strict';

const fs = require('fs');
const path = require('path');
const { Api } = require('teleproto');
const { resolveInputPeer } = require('./peer');
const { put } = require('./storage');

const EXTRA_COMMANDS = {
  // ── Chat management ──────────────────────────────────────────────────
  join: {
    triggers: ['join'],
    async handler(ctx, args) {
      const target = args[0];
      if (!target) return 'usage: join <@channel|invite.link|+phone>';
      try {
        if (/^https?:\/\//.test(target)) {
          const r = await ctx.client.invoke(new Api.messages.ImportChatInvite({ hash: target.split('/').pop().replace(/^\+/, '') }));
          return `joined: ${r.chats?.[0]?.title || 'ok'}`;
        }
        if (target.startsWith('+')) {
          // Phone: try to add as contact / open DM
          return `phone imports not supported — use a username or invite link`;
        }
        const r = await ctx.client.invoke(new Api.channels.JoinChannel({ channel: target }));
        return `joined: ${r.chats?.[0]?.title || target}`;
      } catch (e) { return `join failed: ${e.message}`; }
    },
  },

  leave: {
    triggers: ['leave'],
    async handler(ctx, args) {
      const target = args[0] || ctx.msg.chatId;
      try {
        const peer = await resolveInputPeer(ctx.client, target);
        await ctx.client.invoke(new Api.channels.LeaveChannel({ channel: peer }));
        return 'left';
      } catch (e) { return `leave failed: ${e.message}`; }
    },
  },

  members: {
    triggers: ['members', 'participants'],
    async handler(ctx, args) {
      const target = args[0] || ctx.msg.chatId;
      const limit = Number(args[1]) || 50;
      try {
        const peer = await resolveInputPeer(ctx.client, target);
        const r = await ctx.client.invoke(new Api.channels.GetParticipants({
          channel: peer,
          filter: new Api.ChannelParticipantsRecent(),
          offset: 0, limit,
        }));
        const list = (r.participants || []).map((p) => {
          const u = r.users.find((x) => x.id === p.userId);
          return u ? `  • ${u.firstName || ''} ${u.lastName || ''} (@${u.username || u.id})` : `  • ${p.userId}`;
        });
        return `members of ${target} (${r.participants.length}):\n${list.join('\n')}`;
      } catch (e) { return `members failed: ${e.message}`; }
    },
  },

  admins: {
    triggers: ['admins'],
    async handler(ctx, args) {
      const target = args[0] || ctx.msg.chatId;
      try {
        const peer = await resolveInputPeer(ctx.client, target);
        const r = await ctx.client.invoke(new Api.channels.GetParticipants({
          channel: peer,
          filter: new Api.ChannelParticipantsAdmins(),
          offset: 0, limit: 100,
        }));
        const list = (r.participants || []).map((p) => {
          const u = r.users.find((x) => x.id === p.userId);
          const role = p.className === 'ChannelParticipantCreator' ? '👑 creator' : '⭐ admin';
          return `  ${role} ${u?.firstName || ''} ${u?.lastName || ''} (@${u?.username || u?.id})`;
        });
        return `admins of ${target} (${r.participants.length}):\n${list.join('\n')}`;
      } catch (e) { return `admins failed: ${e.message}`; }
    },
  },

  info: {
    triggers: ['info', 'chatinfo'],
    async handler(ctx, args) {
      const target = args[0] || ctx.msg.chatId;
      try {
        const peer = await resolveInputPeer(ctx.client, target);
        const r = await ctx.client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
        const c = r.chats?.[0] || r.fullChat;
        return [
          `📋 ${c?.title || target}`,
          `  id: ${c?.id}`,
          `  type: ${c?.className || '?'}`,
          `  members: ${r.fullChat?.participantsCount || '?'}`,
          `  about: ${(r.fullChat?.about || '').slice(0, 200) || '(none)'}`,
          `  linked: ${r.fullChat?.linkedChatId || 'no'}`,
        ].join('\n');
      } catch (e) {
        // Fallback to basic entity info
        try {
          const e2 = await ctx.client.getEntity(target);
          return `📋 ${e2?.firstName || e2?.title || target}\n  id: ${e2?.id}\n  type: ${e2?.className}`;
        } catch (e3) { return `info failed: ${e.message}`; }
      }
    },
  },

  dialogs: {
    triggers: ['dialogs', 'chats'],
    async handler(ctx, args) {
      const limit = Number(args[0]) || 30;
      try {
        const list = await ctx.client.getDialogs({ limit });
        const lines = list.map((d) => {
          const icon = d.isChannel ? '📢' : d.isGroup ? '👥' : '💬';
          return `  ${icon} ${d.name} (${d.id}) ${d.unreadCount ? `[${d.unreadCount} unread]` : ''}`;
        });
        return `dialogs (${list.length}):\n${lines.join('\n')}`;
      } catch (e) { return `dialogs failed: ${e.message}`; }
    },
  },

  // ── Media commands ────────────────────────────────────────────────────
  dl: {
    triggers: ['dl', 'downloadmedia'],
    async handler(ctx, args) {
      let target;
      try { target = await require('./extras').getReplyMedia(ctx.client, ctx.msg); }
      catch (e) { return `dl: ${e.message}`; }
      if (target.error) return `dl: ${target.error}`;
      const ext = require('./extras').extForMessage(target.message);
      const filename = `${target.message.id}_${Date.now()}${ext}`;
      const stored = await put({
        client: ctx.client, buffer: target.buffer, filename,
        downloadDir: ctx.downloadDir, caption: `dl: ${filename}`,
      });
      if (!stored.ok) return `dl: storage failed (${stored.backend}): ${stored.error}`;
      return `✅ saved to ${stored.backend}: ${stored.location || '(no public URL)'} (${(target.buffer.length / 1024).toFixed(1)} KB)`;
    },
  },

  bulkdl: {
    triggers: ['bulkdl', 'dlall', 'dln'],
    async handler(ctx, args) {
      const target = args[0] || ctx.msg.chatId;
      const limit = Number(args[1]) || 20;
      try {
        const peer = await resolveInputPeer(ctx.client, target);
        const messages = await ctx.client.getMessages(peer, { limit });
        const mediaMsgs = messages.filter((m) => m.media);
        if (!mediaMsgs.length) return `no media in last ${limit} messages of ${target}`;
        const results = [];
        for (const m of mediaMsgs) {
          try {
            const buf = await ctx.client.downloadMedia(m, {});
            if (!buf) continue;
            const ext = require('./extras').extForMessage(m);
            const filename = `${m.id}_${Date.now()}${ext}`;
            const stored = await put({
              client: ctx.client, buffer: buf, filename,
              downloadDir: ctx.downloadDir, key: `bulkdl/${target}/${filename}`,
              caption: `bulkdl from ${target}`,
            });
            results.push(stored.ok ? `  ✓ ${filename} → ${stored.backend}` : `  ✗ ${m.id}: ${stored.error}`);
          } catch (e) { results.push(`  ✗ ${m.id}: ${e.message}`); }
        }
        return `bulkdl ${target}: ${results.filter((r) => r.startsWith('  ✓')).length}/${mediaMsgs.length} ok\n${results.join('\n')}`;
      } catch (e) { return `bulkdl failed: ${e.message}`; }
    },
  },

  rehost: {
    // Re-download replied media and push to active storage backend.
    // The most useful when STORAGE_TELEGRAM=true (sends to Saved Messages).
    triggers: ['rehost'],
    async handler(ctx, args) {
      let target;
      try { target = await require('./extras').getReplyMedia(ctx.client, ctx.msg); }
      catch (e) { return `rehost: ${e.message}`; }
      if (target.error) return `rehost: ${target.error}`;
      const ext = require('./extras').extForMessage(target.message);
      const filename = `${target.message.id}_${Date.now()}${ext}`;
      const stored = await put({
        client: ctx.client, buffer: target.buffer, filename,
        downloadDir: ctx.downloadDir, key: `rehost/${Date.now()}_${filename}`,
        caption: `rehost: ${filename}`,
      });
      if (!stored.ok) return `rehost: ${stored.backend} failed: ${stored.error}`;
      return `🔁 rehosted to ${stored.backend}: ${stored.location || '(private)'}`;
    },
  },

  album: {
    // Create a Catbox album from the last N media messages in a chat.
    // Requires CATBOX_USERHASH to be set for album creation.
    triggers: ['album'],
    async handler(ctx, args) {
      const target = args[0] || ctx.msg.chatId;
      const limit = Number(args[1]) || 10;
      const title = args.slice(2).join(' ') || `Album from ${target}`;
      const userhash = process.env.CATBOX_USERHASH;
      if (!userhash) {
        return 'album: CATBOX_USERHASH env var is required for album creation. Get one at https://catbox.moe/user/manage.php';
      }
      try {
        const peer = await resolveInputPeer(ctx.client, target);
        const messages = await ctx.client.getMessages(peer, { limit });
        const mediaMsgs = messages.filter((m) => m.media);
        if (!mediaMsgs.length) return `no media in last ${limit} messages of ${target}`;
        const fileNames = [];
        for (const m of mediaMsgs) {
          try {
            const buf = await ctx.client.downloadMedia(m, {});
            if (!buf) continue;
            const ext = require('./extras').extForMessage(m);
            const filename = `${m.id}_${Date.now()}${ext}`;
            const tmp = path.join(require('os').tmpdir(), filename);
            fs.writeFileSync(tmp, buf);
            // upload to catbox first, get URL
            const r = await require('./extras').uploadToCatbox(buf, filename);
            if (r.url) {
              fileNames.push(r.url.replace('https://files.catbox.moe/', ''));
            }
            try { fs.unlinkSync(tmp); } catch {}
          } catch (e) { /* skip */ }
        }
        if (!fileNames.length) return 'album: no media uploaded successfully';
        // create album
        const fd = new FormData();
        fd.append('reqtype', 'createalbum');
        fd.append('userhash', userhash);
        fd.append('title', title);
        fd.append('desc', `Album from ${target} (${fileNames.length} items)`);
        fd.append('files', fileNames.join(' '));
        const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
        const text = (await res.text()).trim();
        if (!res.ok) return `album: catbox ${res.status}: ${text.slice(0, 200)}`;
        return `📁 album "${title}": ${text} (${fileNames.length} items)`;
      } catch (e) { return `album failed: ${e.message}`; }
    },
  },

  // ── History / search ──────────────────────────────────────────────────
  search: {
    triggers: ['search'],
    async handler(ctx, args) {
      const query = args.join(' ').trim();
      const limit = 20;
      if (!query) return 'usage: search <text>';
      try {
        // Local search in the current chat
        const messages = await ctx.client.getMessages(ctx.msg.chatId, { limit: 200 });
        const matches = messages.filter((m) => (m.message || '').toLowerCase().includes(query.toLowerCase())).slice(0, limit);
        if (!matches.length) return `no matches for "${query}" in last 200 messages here`;
        return `🔍 ${matches.length} matches for "${query}":\n` +
          matches.map((m) => `  #${m.id} [${new Date(m.date * 1000).toISOString().slice(0, 16)}] ${(m.message || '').slice(0, 80)}`).join('\n');
      } catch (e) { return `search failed: ${e.message}`; }
    },
  },

  history: {
    triggers: ['history', 'msgs'],
    async handler(ctx, args) {
      const target = args[0] || ctx.msg.chatId;
      const limit = Number(args[1]) || 20;
      try {
        const messages = await ctx.client.getMessages(target, { limit });
        const lines = messages.map((m) => {
          const d = new Date(m.date * 1000).toISOString().slice(0, 16);
          const text = (m.message || '').slice(0, 100);
          const media = m.media ? ` [${m.media.className}]` : '';
          return `  #${m.id} ${d}${media} ${text}`;
        });
        return `history of ${target} (${messages.length}):\n${lines.join('\n')}`;
      } catch (e) { return `history failed: ${e.message}`; }
    },
  },

  // ── Admin / owner commands ────────────────────────────────────────────
  broadcast: {
    // Send the same message to every dialog. Admin-only.
    triggers: ['broadcast', 'bc'],
    async handler(ctx, args) {
      const text = args.join(' ').trim();
      if (!text) return 'usage: broadcast <message>';
      try {
        const dialogs = await ctx.client.getDialogs({ limit: 100 });
        let sent = 0; let failed = 0;
        for (const d of dialogs) {
          try {
            await ctx.client.sendMessage(d.id, { message: text });
            sent++;
            // small delay to avoid flood
            await new Promise((r) => setTimeout(r, 500));
          } catch (e) { failed++; }
        }
        return `📢 broadcast: ${sent} sent, ${failed} failed`;
      } catch (e) { return `broadcast failed: ${e.message}`; }
    },
  },

  eval: {
    // Owner-only JS evaluation. The expression receives ctx and is run in
    // the current process — there is NO sandbox. Use with care.
    triggers: ['eval', 'js'],
    async handler(ctx, args) {
      const code = args.join(' ');
      if (!code) return 'usage: eval <js-expression>';
      // Only the first admin in the list (or all? config) can use it.
      // For safety, only enable if the sender is the FIRST admin in .env.
      const owner = (process.env.AGENT_ADMIN_IDS || '').split(',')[0].trim();
      if (owner && String(ctx.msg.senderId) !== owner) return 'eval: owner-only (first admin in AGENT_ADMIN_IDS)';
      try {
        // Async eval so await is supported
        const fn = new Function('ctx', 'args', `return (async () => { ${code} })();`);
        const result = await fn(ctx, args);
        if (result === undefined) return '✓ (undefined)';
        const s = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return s.length > 3500 ? s.slice(0, 3500) + '\n... (truncated)' : s;
      } catch (e) { return `eval error: ${e.message}`; }
    },
  },

  // ── Misc ──────────────────────────────────────────────────────────────
  delete: {
    // Delete the replied message (admin-only). Use carefully.
    triggers: ['del', 'delete'],
    async handler(ctx, args) {
      if (!ctx.msg.replyTo && !ctx.msg.replyToMessage) return 'reply to a message first';
      const targetId = (typeof ctx.msg.replyTo === 'object' ? ctx.msg.replyTo?.replyToMsgId : ctx.msg.replyTo) || ctx.msg.replyToMessage?.id;
      try {
        await ctx.client.deleteMessages(ctx.msg.chatId, [targetId], { revoke: true });
        return 'deleted';
      } catch (e) { return `delete failed: ${e.message}`; }
    },
  },

  edit: {
    // Edit the replied bot message. Use with /reply from the bot.
    triggers: ['edit'],
    async handler(ctx, args) {
      if (!ctx.msg.replyTo && !ctx.msg.replyToMessage) return 'reply to a bot message first';
      const newText = args.join(' ').trim();
      if (!newText) return 'usage: reply to a bot message, then: edit <new text>';
      const targetId = (typeof ctx.msg.replyTo === 'object' ? ctx.msg.replyTo?.replyToMsgId : ctx.msg.replyTo) || ctx.msg.replyToMessage?.id;
      try {
        await ctx.client.editMessage(ctx.msg.chatId, targetId, { text: newText });
        return 'edited';
      } catch (e) { return `edit failed: ${e.message}`; }
    },
  },

  purge: {
    // Delete the last N messages in the current chat (admin-only).
    triggers: ['purge'],
    async handler(ctx, args) {
      const n = Number(args[0]) || 10;
      try {
        const messages = await ctx.client.getMessages(ctx.msg.chatId, { limit: n });
        const ids = messages.filter((m) => m.id < ctx.msg.id).map((m) => m.id);
        if (!ids.length) return 'no messages to purge';
        await ctx.client.deleteMessages(ctx.msg.chatId, ids, { revoke: true });
        return `purged ${ids.length} messages`;
      } catch (e) { return `purge failed: ${e.message}`; }
    },
  },
};

module.exports = { EXTRA_COMMANDS };
