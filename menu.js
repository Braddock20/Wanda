// menu.js — inline keyboard menus. Single source of truth for the menu
// layout. Renders the SETTINGS MENU style with ◈ borders.
//
// Each menu is { text, rows } where rows is an array of button-rows.
// Buttons are { text, callback } for navigation/actions.

'use strict';

const { Api } = require('teleproto');

// ─────────────────────────────────────────────────────────────────────────
// Menu definitions
// ─────────────────────────────────────────────────────────────────────────

const MENUS = {
  main: {
    text: (ctx) => `┏▣ ◈ *gramjs-bot v4* ◈
│ Welcome — type or tap a category.
│
│ ▸ Media:  /dl, /rehost, /tourl, /album
│ ▸ Send:   /send, /fwd, /edit, /del, /purge
│ ▸ Chats:  /join, /leave, /members, /info
│ ▸ Tools:  /search, /history, /zipchannel
│ ▸ APIs:   /weather, /crypto, /wiki, /qr, /dns
│ ▸ Auto:   /autolike, /autoreact, /mode
│ ▸ Env:    /setenv, /getenv, /envlist
│ ▸ Help:   /help
┗▣
Pick a category:`,
    rows: [
      [
        { text: '📁 Media', callback: 'menu:media' },
        { text: '📨 Send', callback: 'menu:send' },
      ],
      [
        { text: '👥 Chats', callback: 'menu:chats' },
        { text: '🔍 Search', callback: 'menu:search' },
      ],
      [
        { text: '🌐 APIs', callback: 'menu:apis' },
        { text: '🤖 Auto', callback: 'menu:auto' },
      ],
      [
        { text: '⚙️ Env', callback: 'menu:env' },
        { text: '📊 Stats', callback: 'cmd:stats' },
      ],
      [
        { text: '❓ Help', callback: 'cmd:help' },
        { text: '🩺 Health', callback: 'cmd:health' },
      ],
    ],
  },

  media: {
    text: `┏▣ ◈ *MEDIA* ◈
│ Reply to a media message first, then tap.
│
│ /dl       — download replied media
│ /rehost   — push replied media to active storage
│ /tourl    — upload replied media to Catbox, get link
│ /album    — create Catbox album from last N media
│ /bulkdl   — download last N media from a chat
┗▣`,
    rows: [
      [
        { text: '⬇️ Download', callback: 'cmd:dl' },
        { text: '🔁 Rehost', callback: 'cmd:rehost' },
      ],
      [
        { text: '🔗 To URL', callback: 'cmd:tourl' },
        { text: '📁 Album', callback: 'cmd:album' },
      ],
      [{ text: '⬅️ Back', callback: 'menu:main' }],
    ],
  },

  send: {
    text: `┏▣ ◈ *SEND* ◈
│ /send <chat> <text>   — send to any chat
│ /fwd <from> <to>      — forward N messages
│ /edit <text>          — edit a bot message (reply first)
│ /del                  — delete a message (reply first)
│ /purge [N]            — delete last N messages
│ /copy <target>        — forward replied media
┗▣`,
    rows: [
      [
        { text: '🗑️ Delete', callback: 'cmd:del' },
        { text: '✏️ Edit', callback: 'cmd:edit' },
      ],
      [
        { text: '💣 Purge 10', callback: 'cmd:purge:10' },
        { text: '💣 Purge 50', callback: 'cmd:purge:50' },
      ],
      [{ text: '⬅️ Back', callback: 'menu:main' }],
    ],
  },

  chats: {
    text: `┏▣ ◈ *CHATS* ◈
│ /join <link>      — join a channel/group
│ /leave [chat]     — leave a chat
│ /members [chat]   — list members
│ /admins [chat]    — list admins
│ /info [chat]      — chat info
│ /dialogs          — list recent chats
┗▣`,
    rows: [
      [
        { text: '📋 Dialogs', callback: 'cmd:dialogs' },
        { text: 'ℹ️ Info', callback: 'cmd:info' },
      ],
      [
        { text: '👥 Members', callback: 'cmd:members' },
        { text: '⭐ Admins', callback: 'cmd:admins' },
      ],
      [{ text: '⬅️ Back', callback: 'menu:main' }],
    ],
  },

  search: {
    text: `┏▣ ◈ *SEARCH & ARCHIVE* ◈
│ /search <text>        — search in current chat
│ /history [chat] [N]   — show recent messages
│ /zipchannel @chan [N] — zip media from a channel
│ /ziptext @chan [N]    — export text as JSON
│ /zipall @chan         — every media ever
│ /ziprange @chan a b   — media between msg ids
┗▣`,
    rows: [
      [
        { text: '🔍 Search', callback: 'cmd:search' },
        { text: '📜 History', callback: 'cmd:history' },
      ],
      [
        { text: '📦 Zip Channel', callback: 'cmd:zipchannel' },
        { text: '📝 Zip Text', callback: 'cmd:ziptext' },
      ],
      [{ text: '⬅️ Back', callback: 'menu:main' }],
    ],
  },

  apis: {
    text: `┏▣ ◈ *EXTERNAL APIs* ◈
│ /weather <city>   — wttr.in
│ /crypto <coin>    — CoinGecko
│ /wiki <query>     — Wikipedia summary
│ /qr <text>        — QR code link
│ /shorten <url>    — is.gd
│ /dns <domain>     — Cloudflare DNS
│ /ip <addr>        — IP geolocation
│ /trans <lang> <t> — LibreTranslate
┗▣`,
    rows: [
      [
        { text: '🌤️ Weather', callback: 'cmd:weather' },
        { text: '💰 Crypto', callback: 'cmd:crypto' },
      ],
      [
        { text: '📚 Wiki', callback: 'cmd:wiki' },
        { text: '📱 QR', callback: 'cmd:qr' },
      ],
      [
        { text: '🔗 Shorten', callback: 'cmd:shorten' },
        { text: '🔍 DNS', callback: 'cmd:dns' },
      ],
      [{ text: '⬅️ Back', callback: 'menu:main' }],
    ],
  },

  auto: {
    text: (ctx) => {
      const enabled = Object.entries(ctx.automations || {}).filter(([, v]) => v?.enabled).map(([k]) => k);
      return `┏▣ ◈ *AUTOMATIONS* ◈
│ AI mode: ${ctx.aiMode}
│ Enabled (${enabled.length}): ${enabled.join(', ') || 'none'}
│
│ Use commands:
│   /automations   — full status
│   /mode on|off|hybrid
│   /autolike on|off
│   /autoreact on|off
│   /antiread on|off
│   /antidel on|off
│   /autopost target me   then on
│
│ Hybrid:
│   /hybrid autolike+autoreact+antiread on
│   /chain "autolike on | autoreact on"
┗▣`;
    },
    rows: [
      [
        { text: '📋 Status', callback: 'cmd:automations' },
        { text: '🩺 Health', callback: 'cmd:health' },
      ],
      [
        { text: '🟢 Mode ON', callback: 'cmd:mode:on' },
        { text: '🔴 Mode OFF', callback: 'cmd:mode:off' },
      ],
      [
        { text: '🟡 Mode Hybrid', callback: 'cmd:mode:hybrid' },
        { text: '🔀 Hybrid toggle', callback: 'cmd:hybrid' },
      ],
      [{ text: '⬅️ Back', callback: 'menu:main' }],
    ],
  },

  env: {
    text: (ctx) => {
      const sample = (k) => process.env[k] ? '✓' : '✗';
      return `┏▣ ◈ *ENV* ◈
│ Active storage: ${require('./storage').detectBackend()}
│ AI mode: ${ctx.aiMode}
│
│ API_ID ${sample('API_ID')}    API_HASH ${sample('API_HASH')}
│ SESSION ${sample('SESSION_STRING')}
│ S3_BUCKET ${sample('S3_BUCKET')}    B2_BUCKET ${sample('B2_BUCKET')}
│ TELEGRAM-STORE ${sample('STORAGE_TELEGRAM')}
│ CATBOX_USERHASH ${sample('CATBOX_USERHASH')}
│
│ /setenv KEY VALUE   — write
│ /getenv KEY         — read (masked)
│ /unsetenv KEY       — remove
│ /envlist [filter]   — list
│ /envreload          — re-read from disk
┗▣`;
    },
    rows: [
      [
        { text: '📋 List', callback: 'cmd:envlist' },
        { text: '🔄 Reload', callback: 'cmd:envreload' },
      ],
      [{ text: '⬅️ Back', callback: 'menu:main' }],
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Render helpers
// ─────────────────────────────────────────────────────────────────────────

function getMenu(id) {
  return MENUS[id];
}

// Build the Api.ReplyInlineMarkup for a menu
function buildMarkup(menu) {
  const rows = (menu.rows || []).map((row) =>
    row.map((btn) => new Api.KeyboardButtonCallback({
      text: btn.text,
      data: Buffer.from(btn.callback || ''),
    }))
  );
  return new Api.ReplyInlineMarkup({ rows });
}

// Resolve a callback string to either a menu id or a command invocation
function resolveCallback(data) {
  if (!data) return null;
  if (data.startsWith('menu:')) return { type: 'menu', id: data.slice(5) };
  if (data.startsWith('cmd:')) {
    const rest = data.slice(4);
    const parts = rest.split(':');
    return { type: 'cmd', name: parts[0], arg: parts.slice(1).join(':') || undefined };
  }
  return null;
}

module.exports = { MENUS, getMenu, buildMarkup, resolveCallback };
