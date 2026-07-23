// gramjs-bot.js
// Render-ready: session comes from an env var (no local file needed in production),
// and a tiny HTTP server keeps a free-tier Web Service reachable/pingable.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { NewMessage } = require('teleproto/events');

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

// On Render, set SESSION_STRING as an env var (copy it from the .session file
// gramjs-login.js produced locally). Falls back to reading .session for local runs.
const sessionString =
  process.env.SESSION_STRING ||
  (fs.existsSync('.session') ? fs.readFileSync('.session', 'utf8').trim() : '');

if (!sessionString) {
  console.log('No session found. Run gramjs-login.js locally first, then set SESSION_STRING on Render.');
  process.exit(1);
}

async function start() {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
  });

  await client.connect();
  console.log('Connected — running as your account.');

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg?.message) return;

    const sender = await msg.getSender();
    const label = sender?.username || sender?.id || 'unknown';
    console.log(`[${label}] ${msg.message}`);

    // Swap this for your Gemini call, same pattern as Aurora Elite
    if (msg.message.toLowerCase() === 'ping') {
      await client.sendMessage(msg.chatId, { message: 'pong', replyTo: msg.id });
    }
  }, new NewMessage({}));

  console.log('Listening for messages...');
}

start().catch((err) => {
  console.error('Failed to start, retrying in 5s:', err.message);
  setTimeout(start, 5000);
});

// Render's free Web Service tier needs an HTTP port bound, and this endpoint
// doubles as the target for an uptime pinger (UptimeRobot / cron-job.org)
// to stop it spinning down after 15 min idle.
http
  .createServer((req, res) => res.end('Bot is running'))
  .listen(process.env.PORT || 3000);
