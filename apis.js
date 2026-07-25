// apis.js — external API integrations. All OPTIONAL — only the ones whose
// commands are used will hit the network. No API keys required by default
// (we use free public endpoints: wttr.in, coingecko, is.gd, qrserver,
// ip-api, cloudflare-dns, wikipedia). Catbox is for tourl.
//
// Each command returns a chat-friendly string. Errors are graceful.

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { uploadToCatbox } = require('./extras');

// Small fetch wrapper with timeout that works on Node 18+ (uses global fetch)
// and falls back to a minimal https.get implementation on older Nodes.
async function _fetchWithTimeout(targetUrl, opts = {}) {
  const timeoutMs = opts.timeout || 15000;
  if (typeof fetch === 'function' && opts.useGlobal !== false) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(targetUrl, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } finally {
      clearTimeout(tid);
    }
  }
  // Fallback for older Node: use https.get
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`request timed out after ${timeoutMs}ms`)); });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// External API commands
// ─────────────────────────────────────────────────────────────────────────

const EXTRA_COMMANDS = {
  weather: {
    triggers: ['weather', 'wttr'],
    async handler(ctx, args) {
      const city = args.join(' ').trim() || 'auto';
      try {
        const r = await _fetchWithTimeout(`https://wttr.in/${encodeURIComponent(city)}?format=3`, { timeout: 10000 });
        if (!r.ok) return `weather: upstream error ${r.status}`;
        return `🌤️ ${r.text.trim()}`;
      } catch (e) { return `weather failed: ${e.message}`; }
    },
  },

  crypto: {
    triggers: ['crypto', 'price', 'cg'],
    async handler(ctx, args) {
      const coin = (args[0] || 'bitcoin').toLowerCase();
      try {
        const r = await _fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd,eur,btc&include_24hr_change=true`, { timeout: 10000 });
        if (!r.ok) return `crypto: upstream error ${r.status}`;
        const data = JSON.parse(r.text);
        const entry = data[coin];
        if (!entry) return `crypto: "${coin}" not found (try "bitcoin", "ethereum", "solana")`;
        const change = entry.usd_24h_change;
        const arrow = change >= 0 ? '📈' : '📉';
        return `💰 ${coin}\n  $${entry.usd} USD${entry.eur ? ` / €${entry.eur}` : ''}\n  24h: ${arrow} ${change?.toFixed(2)}%`;
      } catch (e) { return `crypto failed: ${e.message}`; }
    },
  },

  shorten: {
    triggers: ['shorten', 'short'],
    async handler(ctx, args) {
      const url = args[0];
      if (!url) return 'usage: shorten <url>';
      try {
        const r = await _fetchWithTimeout(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { timeout: 10000 });
        if (!r.ok) return `shorten: upstream error ${r.status}`;
        return `🔗 ${r.text.trim()}`;
      } catch (e) { return `shorten failed: ${e.message}`; }
    },
  },

  qr: {
    triggers: ['qr'],
    async handler(ctx, args) {
      const text = args.join(' ').trim();
      if (!text) return 'usage: qr <text or url>';
      // Return a URL the user can click; we don't generate the image because
      // most chats will render the link inline. If we have a chat context,
      // we could download the PNG and send it — kept simple for now.
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
      return `📱 ${url}`;
    },
  },

  ip: {
    triggers: ['ip', 'ipinfo', 'geoip'],
    async handler(ctx, args) {
      const ip = args[0];
      if (!ip) return 'usage: ip <ip-address>';
      try {
        const r = await _fetchWithTimeout(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,city,isp,org,as,lat,lon,timezone`, { timeout: 10000 });
        if (!r.ok) return `ip: upstream error ${r.status}`;
        const d = JSON.parse(r.text);
        if (d.status !== 'success') return `ip: ${d.message || 'lookup failed'}`;
        return `🌐 ${ip}\n  ${d.city}, ${d.country}\n  ISP: ${d.isp} (${d.org})\n  AS: ${d.as}\n  Lat/Lon: ${d.lat}, ${d.lon}\n  TZ: ${d.timezone}`;
      } catch (e) { return `ip failed: ${e.message}`; }
    },
  },

  dns: {
    triggers: ['dns'],
    async handler(ctx, args) {
      const domain = args[0];
      const type = (args[1] || 'A').toUpperCase();
      if (!domain) return 'usage: dns <domain> [A|AAAA|MX|TXT|CNAME]';
      try {
        const r = await _fetchWithTimeout(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
          timeout: 10000,
          headers: { Accept: 'application/dns-json' },
          useGlobal: true,
        });
        if (!r.ok) return `dns: upstream error ${r.status}`;
        const d = JSON.parse(r.text);
        if (!d.Answer || !d.Answer.length) return `dns: no ${type} records for ${domain}`;
        const lines = d.Answer.map((a) => `  ${a.name} ${a.type} ${a.data} (TTL ${a.TTL})`);
        return `🔍 ${domain} (${type}):\n${lines.join('\n')}`;
      } catch (e) { return `dns failed: ${e.message}`; }
    },
  },

  wiki: {
    triggers: ['wiki', 'wikipedia'],
    async handler(ctx, args) {
      const q = args.join(' ').trim();
      if (!q) return 'usage: wiki <query>';
      try {
        const r = await _fetchWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`, { timeout: 10000 });
        if (r.status === 404) return `wiki: no article for "${q}"`;
        if (!r.ok) return `wiki: upstream error ${r.status}`;
        const d = JSON.parse(r.text);
        if (d.type === 'disambiguation') {
          return `🔎 "${q}" is a disambiguation page. Try one of: ${(d.extract || '').slice(0, 200)}`;
        }
        const text = (d.extract || 'No summary').slice(0, 600);
        const url = d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(q)}`;
        return `📚 ${d.title}\n${text}\n\n${url}`;
      } catch (e) { return `wiki failed: ${e.message}`; }
    },
  },

  trans: {
    triggers: ['trans', 'translate', 'tr'],
    async handler(ctx, args) {
      // usage: trans <lang> <text...>   e.g. trans es hello world
      const lang = args[0];
      const text = args.slice(1).join(' ');
      if (!lang || !text) return 'usage: trans <lang-code> <text...>   e.g. trans es hello world';
      try {
        const r = await _fetchWithTimeout('https://libretranslate.de/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: text, source: 'auto', target: lang, format: 'text' }),
          timeout: 15000,
        });
        if (!r.ok) return `trans: upstream error ${r.status} (libretranslate.de is rate-limited; try again or self-host)`;
        const d = JSON.parse(r.text);
        return `🌐 ${d.translatedText || '(empty translation)'}`;
      } catch (e) { return `trans failed: ${e.message}`; }
    },
  },

  catbox: {
    // Upload a URL to catbox (no download needed). Useful for rehosting
    // external images.
    triggers: ['catbox', 'upcat'],
    async handler(ctx, args) {
      const url = args[0];
      if (!url) return 'usage: catbox <url>';
      try {
        // Rehost via the urlupload endpoint
        if (typeof fetch !== 'function' || typeof FormData === 'undefined') {
          return 'catbox: requires Node 18+ for fetch/FormData';
        }
        const fd = new FormData();
        fd.append('reqtype', 'urlupload');
        fd.append('url', url);
        const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
        const text = (await r.text()).trim();
        if (!r.ok) return `catbox: upstream error ${r.status}: ${text.slice(0, 200)}`;
        if (!/^https?:\/\//.test(text)) return `catbox: bad response: ${text.slice(0, 200)}`;
        return `🐱 ${text}`;
      } catch (e) { return `catbox failed: ${e.message}`; }
    },
  },
};

module.exports = { EXTRA_COMMANDS, _fetchWithTimeout };
