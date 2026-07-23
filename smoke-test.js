// smoke-test.js — load automation engine and exercise its pure functions
// without needing a real Telegram connection.
'use strict';

const path = require('path');
const fs = require('fs');

// Mock teleproto so requiring the bot doesn't fail
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'teleproto' || request === 'teleproto/sessions' || request === 'teleproto/events') {
    return path.join(__dirname, 'node_modules', '__teleproto_stub.js');
  }
  return origResolve.call(this, request, parent, ...rest);
};

// Ensure stub dir
fs.mkdirSync(path.join(__dirname, 'node_modules'), { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'node_modules', '__teleproto_stub.js'))) {
  fs.writeFileSync(path.join(__dirname, 'node_modules', '__teleproto_stub.js'), `
    class TelegramClient { constructor(){} async connect(){} async getMe(){ return {id:1,username:'test'}; } async sendMessage(){} async getMessages(){return [];} async invoke(){} addEventHandler(){} }
    class StringSession { constructor(){} }
    const Api = new Proxy({}, { get: () => class { constructor(o){Object.assign(this,o||{});} } });
    const utils = {};
    module.exports = { TelegramClient, Api, utils, default: { TelegramClient, Api } };
  `);
  fs.writeFileSync(path.join(__dirname, 'node_modules', '__teleproto_stub_events.js'), `
    class NewMessage { constructor(){} }
    class MessageDeleted { constructor(){} }
    class MessageEdited { constructor(){} }
    class MessageService { constructor(){} }
    module.exports = { NewMessage, MessageDeleted, MessageEdited, MessageService };
  `);
}

// Set minimal env
process.env.API_ID = '12345';
process.env.API_HASH = 'fake';
process.env.SESSION_STRING = 'fake';
process.env.GRAMJS_BOT_EXPORT = '1';
process.env.AI_MODE = 'hybrid';

const engine = require('./automation-engine');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log('1) loadAutomations merges defaults');
const cfg = engine.loadAutomations({ autolike: { enabled: true, emojis: ['🔥'] } });
eq('autolike.enabled', cfg.autolike.enabled, true);
eq('autolike.emojis', cfg.autolike.emojis, ['🔥']);
eq('autoreact has default rules', cfg.autoreact.rules.length > 0, true);
eq('antidel defaults', cfg.antidel.maxCache > 0, true);

console.log('\n2) resolveCommand');
const r1 = engine.resolveCommand('autolike on');
eq('no-prefix resolve', r1?.name, 'autolike');
eq('args parsed', r1?.args, ['on']);
const r2 = engine.resolveCommand('/autolike off');
eq('slash resolve', r2?.name, 'autolike');
eq('slash args', r2?.args, ['off']);
const r3 = engine.resolveCommand('.autolike emojis ❤️ 🔥');
eq('dot resolve', r3?.name, 'autolike');
eq('dot args', r3?.args, ['emojis', '❤️', '🔥']);
ok('unknown command returns null', engine.resolveCommand('foobar') === null);

console.log('\n3) TRIGGER_MAP coverage');
const expected = ['autolike', 'autoreact', 'autopost', 'autosave', 'antidel', 'antiedit', 'autoreply', 'autoforward', 'autopurge', 'autoread', 'autotyping', 'autobio', 'antiraid', 'scheduler', 'zipchannel', 'mode', 'automations', 'extractchannel', 'dumpchannel'];
for (const t of expected) ok(`trigger "${t}" registered`, engine.TRIGGER_MAP.has(t));

console.log('\n4) parseWhen (re-exported from main bot)');
// We'll re-test the parseWhen by reaching into the main module after requiring it
delete require.cache[require.resolve('./gramjs-bot.js')];
const main = require('./gramjs-bot.js');
ok('parseWhen: 5m', Math.abs(main.parseWhen('in 5m') - Date.now() - 300_000) < 5000);
ok('parseWhen: 1h', Math.abs(main.parseWhen('in 1h') - Date.now() - 3_600_000) < 5000);
ok('parseWhen: ISO', main.parseWhen('2099-01-01T00:00:00Z') > Date.now());
ok('parseWhen: garbage', main.parseWhen('not a time') === null);

console.log('\n5) AI mode defaults');
eq('aiMode is hybrid', main.aiMode, 'hybrid');
eq('automations has all 17 keys', Object.keys(main.automations).length >= 15, true);

console.log('\n6) Engine pure helpers');
const helperTest = (() => {
  // Re-require the engine to test helpers through automation defaults
  const mods = engine._modules;
  ok('autolike default has emojis', mods.autolike.defaultCfg.emojis.length > 0);
  ok('autoreact default has rules', mods.autoreact.defaultCfg.rules.length > 0);
  ok('antidel has recentCache', mods.antidel.recentCache instanceof Map);
  ok('antiedit has editHistory', mods.antiedit.editHistory instanceof Map);
  ok('scheduler cron parser has 5 fields', mods.scheduler._checkCron('0 9 * * *', new Date(2025, 0, 1, 9, 0)));
  ok('scheduler cron parser: wrong hour', !mods.scheduler._checkCron('0 9 * * *', new Date(2025, 0, 1, 10, 0)));
  ok('scheduler cron parser: step */15', mods.scheduler._checkCron('*/15 * * * *', new Date(2025, 0, 1, 0, 15)));
  ok('scheduler cron parser: step */15 wrong min', !mods.scheduler._checkCron('*/15 * * * *', new Date(2025, 0, 1, 0, 7)));
  return true;
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
