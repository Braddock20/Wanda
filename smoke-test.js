// smoke-test.js — exercises pure helpers + registration. No Telegram
// connection required. Set GRAMJS_BOT_EXPORT=1 to load gramjs-bot.js.
'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const nm = path.join(__dirname, 'node_modules');
fs.mkdirSync(nm, { recursive: true });

try { require.resolve('teleproto'); }
catch {
  console.log('Installing teleproto for smoke test...');
  try { execSync('npm install --no-audit --no-fund teleproto dotenv archiver', { cwd: __dirname, stdio: 'inherit' }); }
  catch (e) { console.error('install failed:', e.message); process.exit(1); }
}

process.env.API_ID = '12345';
process.env.API_HASH = 'fake';
process.env.SESSION_STRING = 'fake';
process.env.GRAMJS_BOT_EXPORT = '1';
process.env.AI_MODE = 'hybrid';

const engine = require('./automation-engine');
const extras = require('./extras');
const apis = require('./apis');
const more = require('./more');
const peer = require('./peer');
const storage = require('./storage');
const menu = require('./menu');

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
  ok('autoreact has default rules', cfg.autoreact.rules.length > 0);
  ok('antidel defaults', cfg.antidel.maxCache > 0);

  console.log('\n2) resolveCommand');
  const r1 = engine.resolveCommand('autolike on');
  eq('no-prefix resolve', r1?.name, 'autolike');
  const r2 = engine.resolveCommand('/autolike off');
  eq('slash resolve', r2?.name, 'autolike');
  const r3 = engine.resolveCommand('.autolike emojis ❤️ 🔥');
  eq('dot resolve', r3?.name, 'autolike');
  ok('unknown command returns null', engine.resolveCommand('foobar') === null);

  console.log('\n3) load main bot (registers v4 extras into TRIGGER_MAP)');
  delete require.cache[require.resolve('./gramjs-bot.js')];
  const main = require('./gramjs-bot.js');
  const trigMap = main.engine.TRIGGER_MAP;

  console.log('\n4) v3 TRIGGER_MAP coverage');
  const expectedV3 = ['autolike', 'autoreact', 'autopost', 'autosave', 'antidel', 'antiedit', 'autoreply', 'autoforward', 'autopurge', 'autoread', 'autotyping', 'autobio', 'antiraid', 'scheduler', 'zipchannel', 'mode', 'automations', 'setenv', 'getenv', 'envlist', 'tourl', 'save', 'react', 'pin', 'unpin', 'copy', 'ziptext', 'zipall', 'ziprange', 'ping', 'uptime', 'id', 'health', 'stats', 'hybrid', 'chain', 'help'];
  for (const t of expectedV3) ok(`trigger "${t}" registered`, trigMap.has(t));

  console.log('\n5) v4 NEW TRIGGER_MAP coverage (apis + more + menu cmds)');
  const expectedV4 = ['weather', 'wttr', 'crypto', 'price', 'cg', 'shorten', 'short', 'qr', 'ip', 'ipinfo', 'geoip', 'dns', 'wiki', 'wikipedia', 'trans', 'translate', 'tr', 'catbox', 'upcat', 'join', 'leave', 'members', 'participants', 'admins', 'info', 'chatinfo', 'dialogs', 'chats', 'dl', 'downloadmedia', 'bulkdl', 'dlall', 'dln', 'rehost', 'album', 'search', 'history', 'msgs', 'broadcast', 'bc', 'eval', 'js', 'del', 'delete', 'edit', 'purge'];
  for (const t of expectedV4) ok(`trigger "${t}" registered`, trigMap.has(t));
  ok('total triggers >= 80', trigMap.size >= 80);

  console.log('\n6) parseWhen');
  ok('parseWhen: 5m', Math.abs(main.parseWhen('in 5m') - Date.now() - 300_000) < 5000);
  ok('parseWhen: 1h', Math.abs(main.parseWhen('in 1h') - Date.now() - 3_600_000) < 5000);
  ok('parseWhen: ISO', main.parseWhen('2099-01-01T00:00:00Z') > Date.now());
  ok('parseWhen: garbage', main.parseWhen('not a time') === null);

  console.log('\n7) AI mode + automations');
  eq('aiMode is hybrid', main.aiMode, 'hybrid');
  ok('automations has all keys', Object.keys(main.automations).length >= 15);

  console.log('\n8) Engine pure helpers');
  const mods = engine._modules;
  ok('autolike default has emojis', mods.autolike.defaultCfg.emojis.length > 0);
  ok('autoreact default has rules', mods.autoreact.defaultCfg.rules.length > 0);
  ok('antidel has recentCache', mods.antidel.recentCache instanceof Map);
  ok('antiedit has editHistory', mods.antiedit.editHistory instanceof Map);
  ok('scheduler cron parser has 5 fields', mods.scheduler._checkCron('0 9 * * *', new Date(2025, 0, 1, 9, 0)));
  ok('scheduler cron parser: wrong hour', !mods.scheduler._checkCron('0 9 * * *', new Date(2025, 0, 1, 10, 0)));
  ok('scheduler cron parser: step */15', mods.scheduler._checkCron('*/15 * * * *', new Date(2025, 0, 1, 0, 15)));

  console.log('\n9) v3 extras: env parsing & editing');
  eq('parseEnvText: basic', extras.parseEnvText('FOO=bar\nBAZ=qux'), { FOO: 'bar', BAZ: 'qux' });
  eq('parseEnvText: quoted', extras.parseEnvText('FOO="hello world"'), { FOO: 'hello world' });
  eq('parseEnvText: comments', extras.parseEnvText('# c\nFOO=bar\n# another'), { FOO: 'bar' });

  const tmpEnv = path.join(__dirname, '.env.smoke-test');
  try { fs.unlinkSync(tmpEnv); } catch {}
  fs.writeFileSync(tmpEnv, 'EXISTING=original\n');
  const result = extras.editEnvFile(tmpEnv, { NEW_KEY: 'newvalue', EXISTING: 'updated' }, 'merge');
  ok('editEnvFile: change detected', result.changed.includes('NEW_KEY') && result.changed.includes('EXISTING'));
  const reloaded = extras.parseEnvText(fs.readFileSync(tmpEnv, 'utf8'));
  eq('editEnvFile: round-trip', reloaded, { EXISTING: 'updated', NEW_KEY: 'newvalue' });
  const result2 = extras.editEnvFile(tmpEnv, { NEW_KEY: null }, 'merge');
  ok('editEnvFile: remove detected', result2.removed.includes('NEW_KEY'));
  fs.unlinkSync(tmpEnv);

  console.log('\n10) v3 extras: secret masking');
  eq('maskSecret: api key (19 chars)', extras.maskSecret('GEMINI_API_KEY', 'sk-1234567890abcdef'), 'sk-***def (19 chars)');
  eq('maskSecret: non-secret', extras.maskSecret('AI_MODE', 'hybrid'), 'hybrid');

  console.log('\n11) v3 extras: hybrid command parser');
  eq('hybrid: 2 names 1 arg', extras.parseHybrid('autolike+autoreact on'),
     [{ name: 'autolike', args: ['on'] }, { name: 'autoreact', args: ['on'] }]);
  eq('hybrid: 3 names 3 args', extras.parseHybrid('a+b+c on,off,on'),
     [{ name: 'a', args: ['on'] }, { name: 'b', args: ['off'] }, { name: 'c', args: ['on'] }]);
  ok('hybrid: empty returns null', extras.parseHybrid('') === null);

  console.log('\n12) v3 extras: chain parser');
  eq('chain: pipe', extras.parseChain('a | b | c'), ['a', 'b', 'c']);
  eq('chain: semicolon', extras.parseChain('a;b;c'), ['a', 'b', 'c']);
  eq('chain: and-and', extras.parseChain('a && b && c'), ['a', 'b', 'c']);

  console.log('\n13) every v4 command has triggers + handler');
  const allCmds = { ...extras.EXTRA_COMMANDS, ...apis.EXTRA_COMMANDS, ...more.EXTRA_COMMANDS };
  for (const [name, mod] of Object.entries(allCmds)) {
    ok(`${name}: triggers`, Array.isArray(mod.triggers) && mod.triggers.length > 0);
    ok(`${name}: handler`, typeof mod.handler === 'function');
  }

  console.log('\n14) handler unit-runs (no client needed)');
  const noClientCmds = ['ping', 'uptime', 'id', 'health', 'stats', 'help', 'envlist', 'envreload'];
  for (const n of noClientCmds) {
    try {
      const out = await allCmds[n].handler({ chatId: 'me', automations: main.automations, adminIds: [], channelConfig: [], downloadDir: '/tmp', aiMode: 'hybrid', engine, msg: {} }, []);
      ok(`${n}: runs without crash`, typeof out === 'string');
    } catch (e) { ok(`${n}: runs without crash — ERROR: ${e.message}`, false); }
  }

  console.log('\n15) setenv blocks dangerous keys');
  const realEnv = path.join(__dirname, '.env.smoke-blocked');
  fs.writeFileSync(realEnv, 'SAFE=ok\n');
  const setenvOut = await extras.EXTRA_COMMANDS.setenv.handler({ chatId: 'me', automations: main.automations, adminIds: [], channelConfig: [], downloadDir: '/tmp', aiMode: 'hybrid', engine, msg: {} }, ['API_ID', '999']);
  ok('setenv blocks API_ID', /refusing/i.test(String(setenvOut)));
  fs.unlinkSync(realEnv);

  console.log('\n16) peer resolver helpers');
  ok('peer._isAlreadyInputPeer: true for InputPeerUser', peer._isAlreadyInputPeer({ className: 'InputPeerUser', userId: 1 }));
  ok('peer._isAlreadyInputPeer: false for string', !peer._isAlreadyInputPeer('123'));
  ok('peer._isAlreadyInputPeer: false for null', !peer._isAlreadyInputPeer(null));
  ok('peer._isAlreadyEntity: true for User', peer._isAlreadyEntity({ className: 'User', id: 1 }));
  ok('peer._isAlreadyEntity: true for Channel', peer._isAlreadyEntity({ className: 'Channel', id: 1 }));
  ok('peer.peerFromMessage: PeerUser', JSON.stringify(peer.peerFromMessage({ peerId: { className: 'PeerUser', userId: 5 } })) === JSON.stringify({ type: 'user', id: 5 }));
  ok('peer.peerFromMessage: PeerChannel', JSON.stringify(peer.peerFromMessage({ peerId: { className: 'PeerChannel', channelId: -1001 } })) === JSON.stringify({ type: 'channel', id: -1001 }));
  ok('peer.peerFromMessage: null for no peerId', peer.peerFromMessage({}) === null);
  // Test that resolveInputPeer fails clearly for garbage input
  try {
    await peer.resolveInputPeer({ getInputPeer: async () => { throw new Error('not found'); } }, 'definitely_not_a_real_chat_xyz');
    ok('peer.resolveInputPeer throws on bad input', false);
  } catch (e) {
    ok('peer.resolveInputPeer throws on bad input', /could not resolve peer/.test(e.message));
  }

  console.log('\n17) storage: backend detection + putLocal');
  // Force local by clearing any S3/B2/telegram env
  delete process.env.S3_BUCKET; delete process.env.S3_ACCESS_KEY;
  delete process.env.B2_BUCKET; delete process.env.B2_KEY_ID;
  delete process.env.STORAGE_TELEGRAM;
  eq('storage.detectBackend: local (default)', storage.detectBackend(), 'local');

  const localResult = await storage.putLocal('/tmp/gramjs-smoke', Buffer.from('hello world'), 'test.txt');
  ok('storage.putLocal: ok', localResult.ok && localResult.location && localResult.location.endsWith('test.txt'));
  eq('storage.putLocal: content matches', fs.readFileSync(localResult.location, 'utf8'), 'hello world');
  try { fs.unlinkSync(localResult.location); } catch {}

  console.log('\n18) storage: backend selection from env');
  const origEnv = { ...process.env };
  process.env.S3_BUCKET = 'fake-bucket';
  process.env.S3_ACCESS_KEY = 'fake';
  eq('storage.detectBackend: s3 when S3_BUCKET set', storage.detectBackend(), 's3');
  delete process.env.S3_BUCKET;
  process.env.B2_BUCKET = 'fake-b2';
  process.env.B2_KEY_ID = 'fake';
  eq('storage.detectBackend: b2 when B2_BUCKET set', storage.detectBackend(), 'b2');
  delete process.env.B2_BUCKET; delete process.env.B2_KEY_ID;
  process.env.STORAGE_TELEGRAM = 'true';
  eq('storage.detectBackend: telegram when STORAGE_TELEGRAM=true', storage.detectBackend(), 'telegram');
  delete process.env.STORAGE_TELEGRAM;
  Object.assign(process.env, origEnv);

  console.log('\n19) storage: B2 falls back gracefully when S3 mode not configured');
  process.env.B2_BUCKET = 'fake-b2';
  process.env.B2_KEY_ID = 'fake';
  delete process.env.B2_S3_ENDPOINT;
  const b2Res = await storage.putB2(Buffer.from('x'), 'k');
  ok('storage.putB2: fails gracefully without B2_S3_ENDPOINT', !b2Res.ok && /B2_S3_ENDPOINT/.test(b2Res.error));
  delete process.env.B2_BUCKET; delete process.env.B2_KEY_ID;

  console.log('\n20) menu system');
  ok('menu.MENUS has main', !!menu.MENUS.main);
  ok('menu.MENUS has media', !!menu.MENUS.media);
  ok('menu.MENUS has send', !!menu.MENUS.send);
  ok('menu.MENUS has chats', !!menu.MENUS.chats);
  ok('menu.MENUS has search', !!menu.MENUS.search);
  ok('menu.MENUS has apis', !!menu.MENUS.apis);
  ok('menu.MENUS has auto', !!menu.MENUS.auto);
  ok('menu.MENUS has env', !!menu.MENUS.env);
  ok('menu.getMenu main', !!menu.getMenu('main'));
  ok('menu.getMenu unknown returns undefined', !menu.getMenu('nope'));
  const resolve = menu.resolveCallback('menu:main');
  eq('menu.resolveCallback: menu:', resolve, { type: 'menu', id: 'main' });
  const resolve2 = menu.resolveCallback('cmd:purge:50');
  eq('menu.resolveCallback: cmd with arg', resolve2, { type: 'cmd', name: 'purge', arg: '50' });
  const resolve3 = menu.resolveCallback('cmd:help');
  eq('menu.resolveCallback: cmd no arg', resolve3, { type: 'cmd', name: 'help', arg: undefined });
  ok('menu.buildMarkup returns inline markup', menu.buildMarkup(menu.MENUS.main).className === 'ReplyInlineMarkup');

  console.log('\n21) apis: every command has a handler that can be unit-invoked');
  for (const [name, mod] of Object.entries(apis.EXTRA_COMMANDS)) {
    ok(`apis.${name}: has triggers`, Array.isArray(mod.triggers) && mod.triggers.length > 0);
    ok(`apis.${name}: has handler`, typeof mod.handler === 'function');
  }

  console.log('\n22) more: every command has a handler that can be unit-invoked');
  for (const [name, mod] of Object.entries(more.EXTRA_COMMANDS)) {
    ok(`more.${name}: has triggers`, Array.isArray(mod.triggers) && mod.triggers.length > 0);
    ok(`more.${name}: has handler`, typeof mod.handler === 'function');
  }

  console.log('\n23) module dependency sanity (no circular requires)');
  ok('extras loaded', typeof extras.EXTRA_COMMANDS === 'object');
  ok('apis loaded', typeof apis.EXTRA_COMMANDS === 'object');
  ok('more loaded', typeof more.EXTRA_COMMANDS === 'object');
  ok('peer loaded', typeof peer.resolveInputPeer === 'function');
  ok('storage loaded', typeof storage.put === 'function');
  ok('menu loaded', typeof menu.MENUS === 'object');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(2); });
