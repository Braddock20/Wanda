# gramjs-bot v2 — automation-first Telegram userbot

A Termux-friendly Telegram userbot with:
- **Multi-provider LLM agent loop** (Gemini, Groq, OpenRouter, Cerebras, OpenAI, GitHub Models, or any OpenAI-compatible endpoint) with automatic 429/5xx failover.
- **No-prefix automation engine** — 14 automations that run without AI, on every chat you configure.
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

## Notes

- Telegram doesn't have a public "story" API for non-Premium users, so `autopost` mirrors to Saved Messages or any chat you choose — the closest non-Premium equivalent.
- Telegram doesn't have user "statuses" you can react to, so "autolike statuses" maps to `autoread` (marks all dialogs as read) which is the equivalent social signal.
- `antidel` and `antiedit` keep a small in-memory cache. For long-term recovery, the deleted-message bodies get written to `antidel-cache/`.
- All admin-only write actions (sending, reacting, posting, pinning, forwarding) are still gated by `AGENT_ADMIN_IDS` for the LLM tools. Automation commands that trigger writes (`autopost`, `autoforward`, `autopurge`, `scheduler`) require the sender to be in `AGENT_ADMIN_IDS` too.

---

## Files

```
gramjs-bot.js          — main bot (LLM + automation dispatcher)
automation-engine.js   — 14 automation modules, no AI required
.env.example           — config template
smoke-test.js          — unit tests (run: node smoke-test.js)
package.json
```
