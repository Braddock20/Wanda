# gramjs-bot v3 — automation-first Telegram userbot

A Termux-friendly Telegram userbot with:
- **Multi-provider LLM agent loop** (Gemini, Groq, OpenRouter, Cerebras, OpenAI, GitHub Models, or any OpenAI-compatible endpoint) with automatic 429/5xx failover.
- **No-prefix automation engine** — 14 automations that run without AI, on every chat you configure.
- **v3 command surface** — edit `.env` from chat, reply to media to get a Catbox link, hybrid+chain command composition, full channel export, and 22 more commands.
- **AI mode toggle** (`on | off | hybrid`) — keep your admin commands alive even with the LLM off.
- **Plugin-style modules** — drop a new file in to add an automation.

This is the v2 rewrite of `gramjs-bot-2.js`. Your original AI loop, tool schemas, and provider failover are preserved verbatim. The new automation engine sits as a thin layer on top.

---

## Setup

```bash
cp .env.example .env
# edit .env: API_ID, API_HASH, SESSION_STRING (or run gramjs-login.js),
# AGENT_ADMIN_IDS, AUTOMATIONS, AI_MODE
npm install
npm start
```

`teleproto` is a TypeScript fork of `gramjs`, available on the public npm registry as `teleproto@1.228.x` — no private registry or vendored copy required.

`SESSION_STRING` is loaded from `.env` or from a `.session` file. If neither exists, run `gramjs-login.js` locally first to generate one.

---

## AI mode

`AI_MODE` in `.env` (or set live with `mode on|off|hybrid`):

| Mode     | Slash / no-prefix commands | DMs (LLM agent) | Automations |
|----------|----------------------------|------------------|-------------|
| `on`     | ✅                         | ✅               | ✅          |
| `off`    | ✅                         | ❌ (auto-reply: "AI off, use a command") | ✅ |
| `hybrid` *(default)* | ✅           | ✅               | ✅          |

When AI is off, automations and commands still work — you just don't burn tokens on free-form DMs.

---

## Automation commands

**Admins can use them WITHOUT a prefix.** Slash and dot also work. Examples:

```
autolike on
autolike emojis ❤️ 🔥 💯
autoreact on
autoreact add "deploy|ship" 🚀 🎉
autopost on
autopost target me
autopost add @somechannel
autopost run
autosave on
antidel on
antiedit on
autoreply on
autoreply add "ping" "pong"
autopurge on
autopurge 60
autoread on
autobio on
autobio add "chilling"
antiraid on
antiraid threshold 5
scheduler on
scheduler add "0 9 * * *" me "good morning"
zipchannel @mychannel 50
mode off
```

Get the full list any time with `automations` (or `/automations`).

---

## What each automation does

| Automation   | Default | What it does |
|--------------|---------|--------------|
| `autolike`   | off     | React to every message in configured chats with a random emoji from your emoji list. |
| `autoreact`  | off     | Keyword/regex-driven reactions. Multiple emojis per rule → picks one at random. Default rules for greetings, love, fire, lol. |
| `autopost`   | off     | Mirror posts from source channels to a target chat (Saved Messages, group, anywhere). Works live (new posts auto-forwarded) and on-demand (`autopost run`). |
| `autosave`   | off     | Auto-download all media from configured chats to `./downloads/autosave/<chat>/`. |
| `antidel`    | off     | Cache the last 1000 messages (text + media). On delete, recover the body and forward it to your Saved Messages. |
| `antiedit`   | off     | Log every edited message with the previous version. |
| `autoreply`  | off     | Canned keyword replies. No AI. |
| `autoforward`| off     | Forward matching messages from source chats to a target chat. |
| `autopurge`  | off     | Auto-delete your own messages after N seconds. |
| `autoread`   | off     | Mark messages as read automatically. |
| `autotyping` | off     | Show "typing…" in configured chats whenever a message arrives. |
| `autobio`    | off     | Rotate your bio from a pool of strings on a timer. |
| `antiraid`   | off     | Detect mass joins in groups. Log or auto-leave. |
| `scheduler`  | off     | Cron-like recurring posts. Format: `min hour dom mon dow`. |
| `zipchannel`| on      | `zipchannel @channel 50` → download 50 media, zip them, send the zip to your Saved Messages. |

---

## Configuration

`AUTOMATIONS` in `.env` is a JSON object. Anything you omit uses the default. Example:

```json
{
  "autolike":  { "enabled": true, "emojis": ["❤️","🔥","👍"] },
  "autoreact": { "enabled": true, "rules": [{"match":"deploy","emojis":["🚀","💯"]}] },
  "antidel":   { "enabled": true, "saveMedia": true },
  "scheduler": { "enabled": true, "tasks": [{"cron":"0 9 * * *","chat":"me","text":"gm"}] }
}
```

Per-automation config keys are listed under each module in `automation-engine.js`.

---

## Differences from `gramjs-bot-2.js`

- **Event coverage**: now listens in **all chats** (DMs, groups, channels) for automations. AI agent still only runs in DMs (original behavior).
- **New event types**: `MessageDeleted` (antidel), `MessageEdited` (antiedit), `MessageService` (antiraid).
- **No-prefix admin commands**: type `autolike on` without a slash — it just works.
- **`mode` command**: live AI toggle. Persists in memory; set `AI_MODE` in `.env` to persist across restarts.
- **`zipchannel`**: drop-in extractor for channel media.
- **Same LLM logic**: same failover, same 27 native Telegram tools, same tool schemas.

---

## v3 additions (`extras.js`)

22 new commands, all no-prefix for admins. The original 17 v2 commands and 14 automations are unchanged.

### Env editing from chat

```
setenv KEY VALUE       — write a .env value, live-apply where possible
unsetenv KEY           — remove a .env key
getenv KEY             — read a value (masked if it looks like a secret)
envlist [filter]       — list all env keys (filtered)
envreload              — re-read .env from disk
```

`setenv` blocks editing `API_ID`, `API_HASH`, `SESSION_STRING` to prevent lockout. Keys like `AI_MODE` and `AUTOMATIONS` apply live; channel-config changes note that a restart is required.

### Reply-based media

Reply to a message, then:

```
tourl                  — upload replied media to catbox.moe, return the link
save                   — download replied media to disk, print path
react <emoji>          — react to the replied message
pin / unpin            — pin/unpin the replied message
copy <@chat>           — forward replied media to another chat
```

### Channel export variants

```
zipchannel <@chan> [n] — media only (v2)
ziptext   <@chan> [n]  — text only, as JSON + NDJSON
zipall    <@chan>      — every media ever (capped at 5000 messages for safety)
ziprange  <@chan> a b  — media between two message ids
```

All zip commands write to `./downloads/` and also send a copy to your Saved Messages.

### Hybrid + chain

```
hybrid autolike+autoreact+antiread on      — toggle many at once
hybrid a+b+c on,off,on                     — different args per automation
chain "autolike on | autoreact on | antiread on"   — pipeline
```

Chain supports `|`, `;`, or `&&` as separators. Hybrid parses `a+b+c arg` and `a+b+c arg1,arg2,arg3`.

### Utility

```
ping / uptime / id / health / stats / whoami
help                                      — full v3 reference
```

### What "no AI needed" really means

In v2, `AI_MODE=off` already disabled the LLM while keeping every command and automation working. v3 makes this more discoverable: `health` shows the current mode, `mode off|on|hybrid` toggles it live, and every command handler in `extras.js` runs without touching the LLM agent. If you never set an `AGENT_PROVIDERS` key, the bot runs in commands-only mode from boot.

---

## Tests

`node smoke-test.js` runs 161 unit tests covering:
- v2 automation engine (44 tests) — config merging, command resolution, trigger map, scheduler cron parser
- v3 extras (117 tests) — env parse/serialize/edit, secret masking, hybrid/chain parsers, every command has triggers+handler, every handler runs without crash on empty args, `setenv` blocks dangerous keys

Tests run without a real Telegram connection. The module exports pure helpers under `GRAMJS_BOT_EXPORT=1` for this purpose.

---

## Files

```
gramjs-bot.js          — main bot (LLM + automation dispatcher + v3 wiring)
automation-engine.js   — 14 v2 automation modules, plugin registry
extras.js              — 22 v3 commands (env, reply-media, export, hybrid, utility)
.env.example           — config template
smoke-test.js          — 161 unit tests
package.json
```

---

## Notes

- Telegram doesn't have a public "story" API for non-Premium users, so `autopost` mirrors to Saved Messages or any chat you choose — the closest non-Premium equivalent.
- Telegram doesn't have user "statuses" you can react to, so "autolike statuses" maps to `autoread` (marks all dialogs as read) which is the equivalent social signal.
- `antidel` and `antiedit` keep a small in-memory cache. For long-term recovery, the deleted-message bodies get written to `antidel-cache/`.
- All admin-only write actions (sending, reacting, posting, pinning, forwarding) are still gated by `AGENT_ADMIN_IDS` for the LLM tools. Automation commands that trigger writes (`autopost`, `autoforward`, `autopurge`, `scheduler`) require the sender to be in `AGENT_ADMIN_IDS` too.
- v3 `tourl` uses catbox.moe's free endpoint. No API key required. Files up to 200MB. If catbox is down, the command replies with the error and doesn't crash.
- v3 `setenv`/`unsetenv` only block the three highest-risk keys (`API_ID`, `API_HASH`, `SESSION_STRING`). All other keys are writable. Sensitive-key changes are flagged with "takes effect on next restart".
