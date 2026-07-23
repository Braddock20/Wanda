// smoke-test.js — load automation engine and exercise its pure functions
// without needing a real Telegram connection.
'use strict';

const path = require('path');
const fs = require('fs');

// Smoke test: install teleproto and dotenv into a local node_modules, then
// require the real packages. This way we exercise the same require graph
// that Render will use.
const Module = require('module');
const origResolve = Module._resolveFilename;
const { execSync } = require('child_process');
const nm = path.join(__dirname, 'node_modules');
fs.mkdirSync(nm, { recursive: true });

// Make teleproto resolvable: install on first run only
try { require.resolve('teleproto'); }
catch {
  console.log('Installing teleproto for smoke test...');
  try { execSync('npm install --no-audit --no-fund teleproto dotenv archiver', { cwd: __dirname, stdio: 'inherit' }); }
  catch (e) { console.error('install failed:', e.message); process.exit(1); }
}

// Set minimal env
process.env.API_ID = '12345';
process.env.API_HASH = 'fake';
process.env.SESSION_STRING = 'fake';
process.env.GRAMJS_BOT_EXPORT = '1';
process.env.AI_MODE = 'hybrid';

const engine = require('./automation-engine');
const extras = require('./extras');

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

async function main() {

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

console.log('\n3) TRIGGER_MAP coverage (v2 commands)');
const expectedV2 = ['autolike', 'autoreact', 'autopost', 'autosave', 'antidel', 'antiedit', 'autoreply', 'autoforward', 'autopurge', 'autoread', 'autotyping', 'autobio', 'antiraid', 'scheduler', 'zipchannel', 'mode', 'automations', 'extractchannel', 'dumpchannel'];
for (const t of expectedV2) ok(`trigger "${t}" registered`, engine.TRIGGER_MAP.has(t));

console.log('\n4) parseWhen (re-exported from main bot)');
// We'll re-test the parseWhen by reaching into the main module after requiring it
delete require.cache[require.resolve('./gramjs-bot.js')];
const main = require('./gramjs-bot.js');
ok('parseWhen: 5m', Math.abs(main.parseWhen('in 5m') - Date.now() - 300_000) < 5000);
ok('parseWhen: 1h', Math.abs(main.parseWhen('in 1h') - Date.now() - 3_600_000) < 5000);
ok('parseWhen: ISO', main.parseWhen('2099-01-01T00:00:00Z') > Date.now());
ok('parseWhen: garbage', main.parseWhen('not a time') === null);

console.log('\n4b) v3 TRIGGER_MAP coverage (extras registered via main bot)');
// After loading gramjs-bot.js, the extras are registered into main.engine.TRIGGER_MAP
const trigMap = main.engine.TRIGGER_MAP;
const expectedV3 = ['setenv', 'editenv', 'unsetenv', 'delenv', 'getenv', 'envlist', 'envs', 'envreload', 'tourl', 'upload', 'save', 'dlmedia', 'download', 'react', 'pin', 'unpin', 'copy', 'forwardto', 'ziptext', 'exporttext', 'zipall', 'ziprange', 'ping', 'uptime', 'id', 'ids', 'health', 'stats', 'hybrid', 'multi', 'chain', 'pipeline', 'help', 'commands', '?'];
for (const t of expectedV3) ok(`trigger "${t}" registered`, trigMap.has(t));

console.log('\n5) AI mode defaults (post-registration)');
eq('aiMode is hybrid', main.aiMode, 'hybrid');
ok('automations has all v2 keys', Object.keys(main.automations).length >= 15);

console.log('\n7) Engine pure helpers');
const mods = engine._modules;
ok('autolike default has emojis', mods.autolike.defaultCfg.emojis.length > 0);
ok('autoreact default has rules', mods.autoreact.defaultCfg.rules.length > 0);
ok('antidel has recentCache', mods.antidel.recentCache instanceof Map);
ok('antiedit has editHistory', mods.antiedit.editHistory instanceof Map);
ok('scheduler cron parser has 5 fields', mods.scheduler._checkCron('0 9 * * *', new Date(2025, 0, 1, 9, 0)));
ok('scheduler cron parser: wrong hour', !mods.scheduler._checkCron('0 9 * * *', new Date(2025, 0, 1, 10, 0)));
ok('scheduler cron parser: step */15', mods.scheduler._checkCron('*/15 * * * *', new Date(2025, 0, 1, 0, 15)));
ok('scheduler cron parser: step */15 wrong min', !mods.scheduler._checkCron('*/15 * * * *', new Date(2025, 0, 1, 0, 7)));

console.log('\n8) v3 extras: env parsing & editing');
eq('parseEnvText: basic', extras.parseEnvText('FOO=bar\nBAZ=qux'), { FOO: 'bar', BAZ: 'qux' });
eq('parseEnvText: quoted', extras.parseEnvText('FOO="hello world"'), { FOO: 'hello world' });
eq('parseEnvText: single quoted', extras.parseEnvText("FOO='a b'"), { FOO: 'a b' });
eq('parseEnvText: comments', extras.parseEnvText('# comment\nFOO=bar\n# another'), { FOO: 'bar' });
eq('parseEnvText: empty lines', extras.parseEnvText('\n\nFOO=bar\n\n'), { FOO: 'bar' });

// Test editEnvFile round-trip on a temp file
const tmpEnv = path.join(__dirname, '.env.smoke-test');
try { fs.unlinkSync(tmpEnv); } catch {}
fs.writeFileSync(tmpEnv, 'EXISTING=original\n');
const result = extras.editEnvFile(tmpEnv, { NEW_KEY: 'newvalue', EXISTING: 'updated' }, 'merge');
ok('editEnvFile: change detected', result.changed.includes('NEW_KEY') && result.changed.includes('EXISTING'));
const reloaded = extras.parseEnvText(fs.readFileSync(tmpEnv, 'utf8'));
eq('editEnvFile: round-trip NEW_KEY', reloaded.NEW_KEY, 'newvalue');
eq('editEnvFile: round-trip EXISTING', reloaded.EXISTING, 'updated');

// Test unset
const result2 = extras.editEnvFile(tmpEnv, { NEW_KEY: null }, 'merge');
ok('editEnvFile: remove detected', result2.removed.includes('NEW_KEY'));
const reloaded2 = extras.parseEnvText(fs.readFileSync(tmpEnv, 'utf8'));
ok('editEnvFile: removed', !('NEW_KEY' in reloaded2));
fs.unlinkSync(tmpEnv);

console.log('\n9) v3 extras: secret masking');
eq('maskSecret: api key', extras.maskSecret('GEMINI_API_KEY', 'sk-1234567890abcdef'), 'sk-***def (19 chars)');
eq('maskSecret: non-secret', extras.maskSecret('AI_MODE', 'hybrid'), 'hybrid');
eq('maskSecret: empty', extras.maskSecret('FOO', ''), '(empty)');
eq('maskSecret: short secret', extras.maskSecret('SHORT_KEY', 'abc'), '***');

console.log('\n10) v3 extras: hybrid command parser');
const h1 = extras.parseHybrid('autolike+autoreact on');
eq('hybrid: 2 names 1 arg', h1, [
  { name: 'autolike', args: ['on'] },
  { name: 'autoreact', args: ['on'] },
]);
const h2 = extras.parseHybrid('a+b+c on,off,on');
eq('hybrid: 3 names 3 args', h2, [
  { name: 'a', args: ['on'] },
  { name: 'b', args: ['off'] },
  { name: 'c', args: ['on'] },
]);
const h3 = extras.parseHybrid('autolike emojis ❤️ 🔥');
eq('hybrid: multi-word arg', h3, [
  { name: 'autolike', args: ['emojis', '❤️', '🔥'] },
]);
ok('hybrid: empty returns null', extras.parseHybrid('') === null);
ok('hybrid: no args returns null', extras.parseHybrid('autolike') === null);

console.log('\n11) v3 extras: chain parser');
eq('chain: pipe', extras.parseChain('a | b | c'), ['a', 'b', 'c']);
eq('chain: semicolon', extras.parseChain('a;b;c'), ['a', 'b', 'c']);
eq('chain: and-and', extras.parseChain('a && b && c'), ['a', 'b', 'c']);
eq('chain: mixed', extras.parseChain('a | b ; c'), ['a', 'b', 'c']);
eq('chain: empty', extras.parseChain(''), []);

console.log('\n12) v3 extras: every command has a handler');
for (const [name, mod] of Object.entries(extras.EXTRA_COMMANDS)) {
  ok(`${name}: has triggers`, Array.isArray(mod.triggers) && mod.triggers.length > 0);
  ok(`${name}: has handler`, typeof mod.handler === 'function');
}

console.log('\n13) v3 extras: dispatch round-trip (handler context)');
// We can call handlers directly with a fake context. The handler must not throw
// when given invalid args (e.g. missing reply target).
for (const [name, mod] of Object.entries(extras.EXTRA_COMMANDS)) {
  if (name === 'hybrid' || name === 'chain') continue; // these need engine
  if (name === 'ziptext' || name === 'zipall' || name === 'ziprange' || name === 'tourl' || name === 'save' || name === 'react' || name === 'pin' || name === 'unpin' || name === 'copy') continue; // need client
  try {
    const out = mod.handler({ chatId: 'me', automations: main.automations, adminIds: [], channelConfig: [], downloadDir: '/tmp', aiMode: 'hybrid', engine, msg: {} }, []);
    ok(`${name}: handler runs without crash on empty args (returned: ${String(out).slice(0, 40)})`, true);
  } catch (e) {
    ok(`${name}: handler runs without crash on empty args — ERROR: ${e.message}`, false);
  }
}

console.log('\n14) v3 extras: setenv blocks dangerous keys');
// Use the real .env.example as a read-only test target
const realEnv = path.join(__dirname, '.env.smoke-blocked');
fs.writeFileSync(realEnv, 'SAFE=ok\n');
const beforeContent = fs.readFileSync(realEnv, 'utf8');
const blocked = extras.editEnvFile(realEnv, { API_ID: '999', SESSION_STRING: 'evil' }, 'merge');
// The setenv command in extras.js blocks these keys before calling editEnvFile.
// We test editEnvFile directly here to confirm it would write them, but the
// command layer is what blocks them. So just check editEnvFile wrote them.
const after = extras.parseEnvText(fs.readFileSync(realEnv, 'utf8'));
ok('editEnvFile CAN write API_ID (layer above must block)', after.API_ID === '999');
ok('editEnvFile CAN write SESSION_STRING (layer above must block)', after.SESSION_STRING === 'evil');
// Now check the layer above (the actual setenv handler) blocks
const setenvOut = await (async () => {
  // Build a fake context and call setenv
  const ctx = { chatId: 'me', automations: main.automations, adminIds: [], channelConfig: [], downloadDir: '/tmp', aiMode: 'hybrid', engine, msg: {} };
  return await extras.EXTRA_COMMANDS.setenv.handler(ctx, ['API_ID', '999']);
})();
ok('setenv blocks API_ID', /refusing to edit/i.test(String(setenvOut)));
fs.unlinkSync(realEnv);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(2); });
