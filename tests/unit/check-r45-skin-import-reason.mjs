#!/usr/bin/env node
// r45-②【单测】:皮肤导入被拒时给出可行动原因(修前三类形态一律显示「skin.json 校验失败」,
// 用户拿 dsh 项目文件夹来导入无从下手)。校验规则本体(validateManifest)一字不动,只在
// 拒绝出口翻译。纯函数 manifestRejectMessage 直跑 + 端到端跑 installSkinDirectory
// (落盘一律注入 scratch skinsDir —— 绝不写真实 ~/.claude-gui)。
// 变异哨兵(实际验证过红):manifestRejectMessage 删掉 dsh 识别分支 → a1/a3 红。
// Run: node tests/unit/check-r45-skin-import-reason.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkinDirectory, manifestRejectMessage } from '../../server/routes/skins-packs.js';
import { validateManifest } from '../../server/utils/skin-validate.js';

const scratch = mkdtempSync(join(tmpdir(), 'cgui-r45-'));
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const reason = (manifest) => manifestRejectMessage(manifest, validateManifest(manifest, new Set()));
// 端到端:走真正的导入管线(文件夹通道),拿被拒错误的 message —— 前端 report() 只显示它
const importReason = async (manifest) => installSkinDirectory(
  [{ path: 'skin.json', dataB64: b64(manifest) }],
  { skinsDir: join(scratch, 'skins') },
).then(() => null, (e) => ({ code: e.skinCode, message: e.message }));

// ── a)dsh 皮肤库清单(缺 format,带 dsh 形字段)→ 说清「不通用」和下一步 ──
{
  const dsh = { id: 'aurora', accent: '#7aa2f7', bodyAttr: 'data-theme-aurora', order: 3, name: 'Aurora' };
  const msg = reason(dsh);
  assert.match(msg, /dsh/, 'a1: 点名 dsh 格式');
  assert.match(msg, /不通用/, 'a1: 说清与本应用不通用');
  assert.match(msg, /AI 提示词生成器|移植/, 'a2: 给出下一步(生成器 / 移植改写)');
  assert.ok(!/^skin\.json 校验失败$/.test(msg), 'a2: 不再是笼统的「skin.json 校验失败」');
  const e2e = await importReason(dsh);
  assert.equal(e2e.code, 'manifest_invalid', 'a3: 仍按原编码拒(校验规则本体未动)');
  assert.equal(e2e.message, msg, 'a3: 导入管线原样透出该原因');
  // 判别力:只命中一个 dsh 形键不算 dsh(单个 id/order 在别的清单里也常见)
  assert.match(reason({ id: 'x', name: 'x' }), /缺少 format/, 'a4: 单键不误判成 dsh');
}

// ── b)裸缺 format → 只报缺标记 ────────────────────────────────
{
  const bare = { name: '随手写的皮肤', shared: { vars: { '--color-accent': '#ff0000' } } };
  const msg = reason(bare);
  assert.match(msg, /缺少 format/, 'b1: 点名缺 format 标记');
  assert.match(msg, /cgui-skin\/1/, 'b1: 给出应有的值');
  assert.ok(!/dsh/.test(msg), 'b2: 不是 dsh 形就不提 dsh');
  const e2e = await importReason(bare);
  assert.equal(e2e.message, msg, 'b3: 导入管线原样透出');
}

// ── c)format 在位但字段错 → 报具体校验点(字段名)────────────────
{
  const badName = { format: 'cgui-skin/1', name: 'x'.repeat(41) };
  const msg = reason(badName);
  assert.match(msg, /name/, 'c1: 报出出错字段名');
  assert.match(msg, /skin\.json 校验失败/, 'c1: 保留原有归类');
  const e2e = await importReason(badName);
  assert.equal(e2e.message, msg, 'c2: 导入管线原样透出');
  // format 写了别的版本 → 原编码 unsupported_format,并回显包内实际值
  const other = { format: 'dsh-skin/2', name: 'x' };
  const otherMsg = reason(other);
  assert.match(otherMsg, /dsh-skin\/2/, 'c3: 版本不受支持时回显包内 format');
  assert.equal((await importReason(other)).code, 'unsupported_format', 'c3: 编码不变');
  // 非对象清单仍走既有归类(不误入缺 format 分支)
  assert.match(reason([1, 2]), /不是对象/, 'c4: 非对象清单报既有校验点');
}

// ── 前端透传:report() 显示服务端 message(改成显示 error 码即回到不可行动)──
{
  const src = readFileSync(new URL('../../client/src/components/SkinPanel.jsx', import.meta.url), 'utf-8');
  assert.match(src, /d\.error \? \(d\.message \|\| fallback\)/, 'f1: 失败提示取服务端 message');
}

console.log('PASS check-r45-skin-import-reason');
