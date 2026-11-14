// r184 第一组白盒:偏好文件开头带 UTF-8 BOM 时各处读取都读得出;readStallTimeoutSync 读不出时回上一次读成功的值。
// 覆盖接口用例覆盖不到的三处:额度提醒阈值(provider-quota 的 readThresholds)、整份读取(prefs 的 loadPrefs)、
// readStallTimeoutSync 的「读失败」分支(用「prefs.json 是个目录」造读失败:stat 成功、readFileSync 报 EISDIR)。
// 模块在加载时就按家目录算好路径,所以先把 HOME 指到临时目录再 import。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'r184-prefs-bom-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const GUI_DIR = path.join(TMP_HOME, '.claude-gui');
const PREFS = path.join(GUI_DIR, 'prefs.json');
fs.mkdirSync(GUI_DIR, { recursive: true });
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const writeBom = (obj) => fs.writeFileSync(PREFS, Buffer.concat([BOM, Buffer.from(JSON.stringify(obj), 'utf-8')]));
const writePlain = (text) => fs.writeFileSync(PREFS, text);
// 让 prefs.json 变成目录 / 变回文件(不做递归删除:目录始终是空的)
const makePrefsDir = () => { try { fs.unlinkSync(PREFS); } catch {} fs.mkdirSync(PREFS); };
const makePrefsFile = (text) => { try { fs.rmdirSync(PREFS); } catch {} writePlain(text); };

const origWarn = console.warn;
console.warn = () => {}; // 坏文件 / 读不出的警告是预期的,不刷屏

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

try {
  const { parsePrefsJson } = await import('../../server/utils/prefs-json.js');
  assert.deepEqual(parsePrefsJson('\uFEFF{"a":1}'), { a: 1 });
  assert.deepEqual(parsePrefsJson(Buffer.concat([BOM, Buffer.from('{"a":2}')])), { a: 2 });
  assert.deepEqual(parsePrefsJson('{"a":3}'), { a: 3 });
  assert.throws(() => parsePrefsJson('\uFEFF{"a": tru'), SyntaxError, '坏 JSON 照旧抛错,由调用方回默认');
  ok('parsePrefsJson:剥开头 BOM(字符串 / Buffer)、无 BOM 照常、坏 JSON 抛错');

  // ── 额度提醒阈值 ──
  const { readThresholds } = await import('../../server/routes/provider-quota.js');
  const defaults = await readThresholds(); // 文件不存在 → 默认
  const key = Object.keys(defaults)[0];
  assert.ok(key, '默认阈值至少有一个键');
  const custom = defaults[key] + 7;
  writeBom({ quotaThresholds: { [key]: custom } });
  assert.equal((await readThresholds())[key], custom, '带 BOM 时额度提醒阈值读得出');
  writePlain('\uFEFF{"quotaThresholds": {');
  assert.deepEqual(await readThresholds(), defaults, '坏 JSON(带 BOM)照旧回默认');
  ok('readThresholds:带 BOM 读得出,坏 JSON 回默认');

  // ── 整份读取 ──
  const prefsMod = await import('../../server/routes/prefs.js');
  writeBom({ hiddenProjects: ['-x'], thirdPartyAuto: true, xsEnabled: true });
  assert.deepEqual(await prefsMod.loadPrefs(), { hiddenProjects: ['-x'], thirdPartyAuto: true, xsEnabled: true }, '带 BOM 时 loadPrefs 读得出');
  assert.equal(prefsMod.readThirdPartyAutoSync(), true, '带 BOM 时第三方自动档读得出');
  assert.equal(prefsMod.readXsEnabledSync(), true, '带 BOM 时跨会话总开关读得出');
  writePlain('{"xsEnabled": tru');
  assert.deepEqual(await prefsMod.loadPrefs(), {}, '坏 JSON 照旧回 {}');
  assert.equal(prefsMod.readXsEnabledSync(), false, '坏 JSON 照旧回 false');
  ok('loadPrefs / readThirdPartyAutoSync / readXsEnabledSync:带 BOM 读得出,坏 JSON 回默认');

  // ── 更新渠道 ──
  const { readUpdateChannel } = await import('../../server/routes/version-check.js');
  writeBom({ updateChannel: 'native' });
  assert.equal(readUpdateChannel(), 'native', '带 BOM 时更新渠道读得出');
  ok('readUpdateChannel:带 BOM 读得出');

  // ── 跨会话偏好的两处同步读取:带 BOM 的合法文件不算读失败,带 BOM 的坏 JSON 仍算 ──
  const SID_A = '11111111-2222-4333-8444-555555555555';
  const SID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  writeBom({ xsEnabled: true, xsProfileWriteFailed: [SID_A, SID_B] });
  {
    const pf = prefsMod.readXsProfileWriteFailedSync();
    assert.equal(pf.readFailed, false, '带 BOM 的合法文件:readXsProfileWriteFailedSync 不算读失败');
    assert.deepEqual(pf.ids, [SID_A, SID_B], '带 BOM 时读得出写进去的会话号');
    const xd = prefsMod.readXsPrefsDetailedSync();
    assert.equal(xd.readFailed, false, '带 BOM 的合法文件:readXsPrefsDetailedSync 不算读失败');
    assert.equal(xd.enabled, true, '带 BOM 时跨会话总开关读得出');
  }
  fs.writeFileSync(PREFS, Buffer.concat([BOM, Buffer.from('{"xsEnabled": tru', 'utf-8')]));
  assert.equal(prefsMod.readXsProfileWriteFailedSync().readFailed, true, '带 BOM 的坏 JSON:readXsProfileWriteFailedSync 仍是读失败');
  assert.equal(prefsMod.readXsPrefsDetailedSync().readFailed, true, '带 BOM 的坏 JSON:readXsPrefsDetailedSync 仍是读失败');
  ok('readXsProfileWriteFailedSync / readXsPrefsDetailedSync:带 BOM 读得出、readFailed 为 false;坏 JSON 仍为 true');

  // ── 看守:去 BOM 的正则必须用转义写法(字面的 U+FEFF 被编辑器吃掉后正则变 /^/,去 BOM 悄悄失效) ──
  {
    const src = fs.readFileSync(new URL('../../server/utils/prefs-json.js', import.meta.url), 'utf-8');
    assert.ok(!src.includes(String.fromCharCode(0xfeff)), 'prefs-json.js 源码里不许有字面的 U+FEFF 字符');
    assert.ok(src.includes(String.fromCharCode(92) + 'uFEFF'), 'prefs-json.js 源码里必须是转义写法');
  }
  ok('prefs-json.js 源码:BOM 用转义写法,没有字面字符');

  // ── readStallTimeoutSync:读失败时回上一次读成功的值 ──
  writeBom({ stallTimeout: '20m' });
  assert.equal(prefsMod.readStallTimeoutSync(), '20m', '带 BOM 时静默超时读得出');
  makePrefsDir();
  assert.equal(prefsMod.readStallTimeoutSync(), '20m', '读失败(EISDIR)时回上一次读成功的 20m,而不是默认 5m');
  makePrefsFile(JSON.stringify({ stallTimeout: 'never' }));
  assert.equal(prefsMod.readStallTimeoutSync(), 'never', '读失败解除后读到新值');
  writePlain('{"stallTimeout": "20m"'); // 坏 JSON:口径不变,回默认
  assert.equal(prefsMod.readStallTimeoutSync(), '5m', '坏 JSON 照旧回默认 5m');
  fs.unlinkSync(PREFS); // 文件不存在:口径不变,回默认
  assert.equal(prefsMod.readStallTimeoutSync(), '5m', '文件不存在照旧回默认 5m');
  ok('readStallTimeoutSync:读失败回上一次的值;坏 JSON / 不存在回默认');

  // 从没读成功过:新的模块实例(查询串让 ESM 重新求值),第一次读就失败 → 默认
  makePrefsDir();
  const fresh = await import('../../server/routes/prefs.js?r184-fresh');
  assert.equal(fresh.readStallTimeoutSync(), '5m', '从没读成功过时读失败回默认 5m');
  ok('readStallTimeoutSync:从没读成功过时读失败回默认');
  try { fs.rmdirSync(PREFS); } catch {}

  console.log(`check-r184-prefs-bom: ${passed} passed`);
} finally {
  console.warn = origWarn;
}
