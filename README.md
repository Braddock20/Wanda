# Telegram bot (teleproto) — setup & deploy

A GramJS-style bot that logs in as a real Telegram account (not the official Bot API),
built on `teleproto`, the actively maintained fork of the now-archived GramJS.

## 1. Local setup (Termux or any machine)

```bash
cd gramjs-bot
npm install --omit=optional
```

`--omit=optional` skips native performance modules (utf-8-validate/bufferutil) that
fail to compile on Termux — everything still works, just pure-JS websocket parsing.

## 2. Get API credentials

Go to https://my.telegram.org → log in → "API development tools" → create an app.
You'll get an `API_ID` and `API_HASH`.

```bash
cp .env.example .env
# then edit .env and paste in your real API_ID and API_HASH
```

## 3. Generate a session (one-time, interactive)

```bash
node gramjs-login.js
```

Prompts:
- Phone number (with country code, e.g. `+2547...`)
- 2FA password (press enter to skip if you don't have one)
- Code — sent as a message inside Telegram itself (check Saved Messages), not SMS

This writes a `.session` file. Treat it like a password — never commit or share it.

## 4. Test locally

```bash
npm start
```

DM your account "ping" from another account/device — it should reply "pong".
Ctrl+C to stop.

## 5. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `.env`, and `.session`.

## 6. Get your session string for Render

```bash
cat .session
```

Copy the full output — this is `SESSION_STRING`.

## 7. Deploy on Render

- render.com → New → **Web Service** → connect your GitHub repo
- Build command: `npm install --omit=optional`
- Start command: `npm start`
- Environment variables:
  - `API_ID`
  - `API_HASH`
  - `SESSION_STRING` (paste the string from step 6)
- Deploy

## 8. Keep it alive on the free tier (optional)

Free Web Services spin down after 15 min idle. Add your Render URL to
UptimeRobot or cron-job.org, pinging every ~10 min, to keep the connection alive.
Or upgrade to Starter (~$7/mo) to remove spin-down entirely — no code changes needed.

## Notes

- `.session` and `.env` are full account credentials — anyone with the session
  string has complete access to the Telegram account, no password or 2FA needed.
  Never commit them, paste them into a website, or share them.
- The `ping` → `pong` block in `gramjs-bot.js` is a placeholder — swap it for a
  Gemini call to make it a real auto-reply bot.
