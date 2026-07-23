// gramjs-login.js
// Run ONCE to log into your real Telegram account and generate a session string.

require('dotenv').config();
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const input = require('input');
const fs = require('fs');

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

(async () => {
  if (!apiId || !apiHash) {
    console.log('Missing API_ID / API_HASH. Set them in .env (see my.telegram.org).');
    process.exit(1);
  }

  console.log('Logging in to Telegram...');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Phone number (+2547...): '),
    password: async () => await input.text('2FA password (leave blank if none): '),
    phoneCode: async () => await input.text('Code sent to your Telegram app: '),
    onError: (err) => console.log(err),
  });

  console.log('Logged in successfully.');

  const sessionString = client.session.save();
  fs.writeFileSync('.session', sessionString);
  console.log('Session saved to .session — keep this file as secret as a password.');

  await client.sendMessage('me', { message: 'Session is live ✅' });
  await client.disconnect();
  process.exit(0);
})();
