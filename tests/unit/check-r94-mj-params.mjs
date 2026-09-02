#!/usr/bin/env node
// r94-A:Midjourney 参数编译层 server/utils/mj-params.js(§1)+ 能力表分隔符容忍(§3)。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r94.md 的对外契约写,不看实现。
// 断言名里带 INTERFACE 编号(§1.x / §3 / R* / M*),红了能直接对回契约表。
//
// 设计要点:被测模块 mj-params.js 现在【还不存在】,所以用【动态 import + 逐条 check()】——
// 静态 import 一个不存在的模块会在 ESM 链接阶段直接抛错、后面一条都跑不到;
// 改前必须"每条各自红",才看得出到底缺哪几件。
//
// 零网络、零真实配置:纯函数直接 import,不碰 HOME、不碰 ~/.claude-gui。
// Run: node tests/unit/check-r94-mj-params.mjs
import assert from 'node:assert/strict';

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// A. §1 参数编译层 server/utils/mj-params.js
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §1 server/utils/mj-params.js');

let MP = null;
let MPERR = '';
try {
  MP = await import('../../server/utils/mj-params.js');
} catch (e) {
  MPERR = String((e && e.message) || e);
}
check('A0 mj-params.js 可被 node 直接 import(零依赖纯函数模块)', () => {
  assert.ok(MP, `import 失败:${MPERR}`);
});

const compileMjFlags = MP?.compileMjFlags;
const mjCapsFor = MP?.mjCapsFor;
const mjEffectiveSpeed = MP?.mjEffectiveSpeed;
const mjRefModeFor = MP?.mjRefModeFor;

// 缺省 opts:proxy 载体(flags 里能看见全部字段),prompt 恒 'cat'。
const P = (params, over = {}) => compileMjFlags(params, { version: '7', carrier: 'mj-proxy', prompt: 'cat', ...over });
const flagsOf = (params, over) => P(params, over).flags;
const reasonOf = (params, field, over) => (P(params, over).dropped || []).find((d) => d.field === field)?.reason;

// ── §1.1 存在性与空形态 ────────────────────────────────────────────────
check('R1 compileMjFlags 已导出且是函数', () => {
  assert.equal(typeof compileMjFlags, 'function');
});
check('§1.1 空 params:五个返回值均空,prompt 原样', () => {
  const r = compileMjFlags({}, { version: '7', carrier: 'mj-proxy', prompt: 'cat' });
  assert.strictEqual(r.flags, '', 'flags 无字段时是空串');
  assert.deepEqual(r.parts, []);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.viaBody, []);
  assert.strictEqual(r.prompt, 'cat');
});
check('§1.1 入参非法(null/undefined/字符串)不抛错,五个返回值均空', () => {
  for (const [a, b] of [[null, null], [undefined, {}], ['x', { version: '7' }]]) {
    const r = compileMjFlags(a, b);
    assert.strictEqual(r.flags, '', `flags 应空(${String(a)})`);
    assert.deepEqual(r.parts, [], `parts 应空(${String(a)})`);
    assert.deepEqual(r.dropped, [], `dropped 应空(${String(a)})`);
    assert.deepEqual(r.viaBody, [], `viaBody 应空(${String(a)})`);
    assert.strictEqual(r.prompt, '', `prompt 应空(${String(a)})`);
  }
});

// ── §1.1 正例与顺序 ───────────────────────────────────────────────────
check('§1.1 {stylize:250} 产出 --s 250,prompt 追加在末尾', () => {
  const r = P({ stylize: 250 });
  assert.strictEqual(r.flags, '--s 250');
  assert.strictEqual(r.prompt, 'cat --s 250');
});
check('G3/§1.1 parts 每项恰为 [flagString, valueString],两元素都是字符串', () => {
  const parts = P({ stylize: 250 }).parts;
  assert.deepEqual(parts, [['--s', '250']]);
  for (const [f, v] of parts) {
    assert.equal(typeof f, 'string', 'flag 必须是字符串');
    assert.equal(typeof v, 'string', '值必须是字符串(数值一律 String(v))');
  }
});
check('G3/§1.1 无值 flag 的第二元是空串;extraFlags 段是 [空串, 原文]', () => {
  assert.deepEqual(P({ tile: true }).parts, [['--tile', '']]);
  assert.deepEqual(P({ styleRaw: true }).parts, [['--style raw', '']]);
  assert.deepEqual(P({ extraFlags: '--sv 4 --exp 20' }).parts, [['', '--sv 4 --exp 20']]);
});
check('G1/§1.1 不变式:parts 拼回来必须逐字等于 flags', () => {
  const probes = [
    { stylize: 250 }, { stylize: 250, chaos: 20, seed: 1 }, { tile: true },
    { tile: true, styleRaw: true, negative: 'ugly, blurry' },
    { stylize: 250, extraFlags: '--sv 4' }, { extraFlags: '--exp 20' }, {},
  ];
  for (const params of probes) {
    const r = P(params);
    const joined = r.parts.map(([f, v]) => (v ? `${f} ${v}` : f)).join(' ');
    assert.strictEqual(joined, r.flags, `parts 拼接与 flags 不一致(${JSON.stringify(params)})`);
  }
});
check('§1.1 parts 顺序恒为声明序(--s / --c / --seed),与传入键序无关', () => {
  const a = P({ stylize: 250, chaos: 20, seed: 1 }).parts;
  assert.deepEqual(a, [['--s', '250'], ['--c', '20'], ['--seed', '1']]);
  const b = P({ seed: 1, chaos: 20, stylize: 250 }).parts;
  assert.deepEqual(b, a, '传入键序不同,输出顺序必须相同(声明序)');
});
check('§1.1 数字字符串与数字等价', () => {
  assert.strictEqual(flagsOf({ stylize: '250' }), flagsOf({ stylize: 250 }));
});
check('§1.1 布尔开关 tile / styleRaw / draft / hd 的 flag 字面', () => {
  assert.strictEqual(flagsOf({ tile: true }), '--tile');
  assert.strictEqual(flagsOf({ styleRaw: true }), '--style raw');
  assert.strictEqual(flagsOf({ draft: true }), '--draft');
  assert.strictEqual(flagsOf({ hd: true }, { version: '8.2' }), '--hd');
});
check('§1.1 假值开关(false / 字符串 false / 0)不产出、不进 dropped', () => {
  for (const v of [false, 'false', 0]) {
    const r = P({ tile: v });
    assert.strictEqual(r.flags, '', `tile=${JSON.stringify(v)} 不该产出 flag`);
    assert.deepEqual(r.dropped, [], `tile=${JSON.stringify(v)} 不该进 dropped(没填不算错)`);
  }
});
check('§1.1 负向词产出 --no ugly, blurry(逗号是 --no 唯一允许的标点)', () => {
  assert.strictEqual(flagsOf({ negative: 'ugly, blurry' }), '--no ugly, blurry');
});
check('§1.1 未填(空串 / null / undefined)不产出且不进 dropped', () => {
  for (const v of ['', null, undefined]) {
    const r = P({ stylize: v });
    assert.strictEqual(r.flags, '', `stylize=${String(v)} 不产出`);
    assert.deepEqual(r.dropped, [], `stylize=${String(v)} 是"未填",不是"丢弃"`);
  }
});
check('§1.1 非数值(abc / NaN / 空对象)进 dropped 且 reason 为 out-of-range', () => {
  for (const v of ['abc', NaN, {}]) {
    assert.strictEqual(reasonOf({ stylize: v }, 'stylize'), 'out-of-range', `stylize=${String(v)}`);
    assert.strictEqual(flagsOf({ stylize: v }), '', `stylize=${String(v)} 不许进 flags`);
  }
});

// ── §1.1 范围钳制(M1:越界必须丢弃,不许钳位) ──────────────────────────
check('M1/§1.1 越界一律 out-of-range 且不进 flags(不许改成钳位)', () => {
  const cases = [
    [{ stylize: 1001 }, 'stylize'], [{ stylize: -1 }, 'stylize'], [{ chaos: 101 }, 'chaos'],
    [{ weird: 3001 }, 'weird'], [{ seed: 4294967296 }, 'seed'], [{ stop: 9 }, 'stop'], [{ stop: 101 }, 'stop'],
  ];
  for (const [params, field] of cases) {
    const over = field === 'stop' ? { version: '6.1' } : {};
    assert.strictEqual(reasonOf(params, field, over), 'out-of-range', `${JSON.stringify(params)} 应 out-of-range`);
    assert.strictEqual(flagsOf(params, over), '', `${JSON.stringify(params)} 不许被钳位后发出去`);
  }
});
check('§1.1 边界内合法值照常产出(stylize/chaos/weird/seed 的上下界)', () => {
  assert.strictEqual(flagsOf({ stylize: 0 }), '--s 0');
  assert.strictEqual(flagsOf({ stylize: 1000 }), '--s 1000');
  assert.strictEqual(flagsOf({ chaos: 0 }), '--c 0');
  assert.strictEqual(flagsOf({ chaos: 100 }), '--c 100');
  assert.strictEqual(flagsOf({ weird: 3000 }), '--weird 3000');
  assert.strictEqual(flagsOf({ seed: 0 }), '--seed 0');
  assert.strictEqual(flagsOf({ seed: 4294967295 }), '--seed 4294967295');
});
check('§1.1 stop 边界 10 与 100 在 6.1 上合法', () => {
  assert.strictEqual(flagsOf({ stop: 10 }, { version: '6.1' }), '--stop 10');
  assert.strictEqual(flagsOf({ stop: 100 }, { version: '6.1' }), '--stop 100');
});

// ── §1.1 非法字符 / 已在 prompt 里 ────────────────────────────────────
check('§1.1 字符串字段含两个连字符 / 换行 / 回车 / 制表符 → illegal-chars', () => {
  const bads = ['ugly --s 100', 'a\nb', 'a\rb', 'a\tb', 'a' + String.fromCharCode(7) + 'b'];
  for (const bad of bads) {
    assert.strictEqual(reasonOf({ negative: bad }, 'negative'), 'illegal-chars', `negative=${JSON.stringify(bad)}`);
    assert.strictEqual(flagsOf({ negative: bad }), '', `negative=${JSON.stringify(bad)} 不许进 flags`);
  }
});
check('M2/§1.1 prompt 里已手写同名 flag → already-in-prompt 且不重复产出', () => {
  const r = compileMjFlags({ seed: 12345 }, { version: '7', carrier: 'mj-proxy', prompt: 'cat --seed 7' });
  assert.strictEqual((r.dropped || []).find((d) => d.field === 'seed')?.reason, 'already-in-prompt');
  assert.strictEqual(r.flags, '', '手写过就不再产出');
  assert.strictEqual(r.prompt, 'cat --seed 7', 'prompt 原样,不追加');
});
check('M2/§1.1 前缀不算命中:prompt 为 a --seedling 时 --seed 照常产出', () => {
  const r = compileMjFlags({ seed: 12345 }, { version: '7', carrier: 'mj-proxy', prompt: 'a --seedling' });
  assert.strictEqual(r.flags, '--seed 12345');
  assert.deepEqual(r.dropped, []);
});

// ── §1.1 profile / --p ───────────────────────────────────────────────
check('§1.1 profile 在 6.1/7/8.2/niji6/niji7 上产出 --p', () => {
  for (const v of ['6.1', '7', '8.2', 'niji6', 'niji7']) {
    assert.strictEqual(flagsOf({ profile: 'abc123' }, { version: v }), '--p abc123', `version=${v}`);
  }
});
check('§1.1 profile 在 5.1 / 5.2 上 unsupported-version', () => {
  for (const v of ['5.1', '5.2']) {
    assert.strictEqual(reasonOf({ profile: 'abc123' }, 'profile', { version: v }), 'unsupported-version', `version=${v}`);
  }
});
check('M7/§1.1 profile 为空串:任意版本都不产出裸 --p,且不进 dropped', () => {
  for (const v of ['5.1', '6.1', '7', '8.2', 'niji6', 'niji7']) {
    const r = P({ profile: '' }, { version: v });
    assert.ok(!r.flags.includes('--p'), `version=${v} 不许出现裸 --p(实得 ${JSON.stringify(r.flags)})`);
    assert.deepEqual(r.dropped, [], `version=${v} 空串是"未填"`);
  }
});

// ── §1.1 版本冲突规则 ────────────────────────────────────────────────
check('§1.1 --q:8.2 上 unsupported-version;6.1 上 4 越界;7 上产出 --q 4', () => {
  assert.strictEqual(reasonOf({ quality: 2 }, 'quality', { version: '8.2' }), 'unsupported-version');
  assert.strictEqual(reasonOf({ quality: 4 }, 'quality', { version: '6.1' }), 'out-of-range');
  assert.strictEqual(flagsOf({ quality: 4 }, { version: '7' }), '--q 4');
});
check('§1.1 --stop:7 / 8.1 / niji7 上 unsupported-version', () => {
  for (const v of ['7', '8.1', 'niji7']) {
    assert.strictEqual(reasonOf({ stop: 50 }, 'stop', { version: v }), 'unsupported-version', `version=${v}`);
  }
});
check('§1.1 --draft:8.2 与 6.1 上 unsupported-version;7 上产出', () => {
  assert.strictEqual(reasonOf({ draft: true }, 'draft', { version: '8.2' }), 'unsupported-version');
  assert.strictEqual(reasonOf({ draft: true }, 'draft', { version: '6.1' }), 'unsupported-version');
  assert.strictEqual(flagsOf({ draft: true }, { version: '7' }), '--draft');
});
check('§1.1 --hd:7 上 unsupported-version;8.1/8.2 上产出', () => {
  assert.strictEqual(reasonOf({ hd: true }, 'hd', { version: '7' }), 'unsupported-version');
  assert.strictEqual(flagsOf({ hd: true }, { version: '8.1' }), '--hd');
  assert.strictEqual(flagsOf({ hd: true }, { version: '8.2' }), '--hd');
});
check('M5/§1.1 --repeat 需要 fast/turbo:speed 空串时 needs-fast-speed', () => {
  assert.strictEqual(reasonOf({ repeat: 4 }, 'repeat', { speed: '' }), 'needs-fast-speed');
  assert.strictEqual(flagsOf({ repeat: 4 }, { speed: '' }), '', 'relax(默认空)档不许发 --r');
});
check('M5/§1.1 --repeat 在 speed 为 fast / turbo 时产出 --r 4', () => {
  assert.strictEqual(flagsOf({ repeat: 4 }, { speed: 'fast' }), '--r 4');
  assert.strictEqual(flagsOf({ repeat: 4 }, { speed: 'turbo' }), '--r 4');
});
check('§1.1 --repeat 范围 [2,40]:1 与 41 都 out-of-range', () => {
  assert.strictEqual(reasonOf({ repeat: 1 }, 'repeat', { speed: 'fast' }), 'out-of-range');
  assert.strictEqual(reasonOf({ repeat: 41 }, 'repeat', { speed: 'fast' }), 'out-of-range');
});

// ── §1.1 参考图类 flag ────────────────────────────────────────────────
check('§1.1 --cref/--cw 只在 6.1(与 niji6)可用,7 上两者 unsupported-version', () => {
  assert.strictEqual(flagsOf({ cref: 'https://x/a.png', cw: 50 }, { version: '6.1' }), '--cref https://x/a.png --cw 50');
  assert.strictEqual(reasonOf({ cref: 'https://x/a.png', cw: 50 }, 'cref', { version: '7' }), 'unsupported-version');
  assert.strictEqual(reasonOf({ cref: 'https://x/a.png', cw: 50 }, 'cw', { version: '7' }), 'unsupported-version');
});
check('§1.1 --oref/--ow 只在 7 可用(6.1 / 8.2 / niji7 上 unsupported-version)', () => {
  assert.ok(flagsOf({ oref: 'https://x/a.png', ow: 100 }, { version: '7' }).includes('--oref https://x/a.png'));
  assert.ok(flagsOf({ oref: 'https://x/a.png', ow: 100 }, { version: '7' }).includes('--ow 100'));
  for (const v of ['6.1', '8.2', 'niji7']) {
    assert.strictEqual(reasonOf({ oref: 'https://x/a.png' }, 'oref', { version: v }), 'unsupported-version', `version=${v}`);
  }
});
check('§1.1 --sref/--sw 在 6.1/7/8.x/niji 上产出,5.2 上 unsupported-version', () => {
  for (const v of ['6.1', '7', '8.1', '8.2', 'niji6', 'niji7']) {
    assert.strictEqual(flagsOf({ sref: 'https://x/a.png', sw: 200 }, { version: v }),
      '--sref https://x/a.png --sw 200', `version=${v}`);
  }
  assert.strictEqual(reasonOf({ sref: 'https://x/a.png' }, 'sref', { version: '5.2' }), 'unsupported-version');
});
check('§1.1 --sref 的特殊取值 random / 数字串原样产出', () => {
  assert.strictEqual(flagsOf({ sref: 'random' }), '--sref random');
  assert.strictEqual(flagsOf({ sref: '12345' }), '--sref 12345');
});
check('§1.1 参考图 URL 非法(非 URL / ftp / 含空格)→ illegal-chars', () => {
  for (const bad of ['not a url', 'ftp://x', 'http://x/a.png b']) {
    assert.strictEqual(reasonOf({ cref: bad }, 'cref', { version: '6.1' }), 'illegal-chars', `cref=${JSON.stringify(bad)}`);
    assert.strictEqual(flagsOf({ cref: bad }, { version: '6.1' }), '', `cref=${JSON.stringify(bad)} 不许进 flags`);
  }
});
check('§1.1 --iw 范围随版本:niji7 上 2 合法、2.5 越界;7 与 niji6 上限 3', () => {
  assert.strictEqual(flagsOf({ iw: 2 }, { version: 'niji7' }), '--iw 2');
  assert.strictEqual(reasonOf({ iw: 2.5 }, 'iw', { version: 'niji7' }), 'out-of-range');
  assert.strictEqual(flagsOf({ iw: 3 }, { version: '7' }), '--iw 3');
  assert.strictEqual(flagsOf({ iw: 3 }, { version: 'niji6' }), '--iw 3');
});
check('§1.1 --ow 范围 [1,1000]:0 与 1001 越界(在 7 上)', () => {
  assert.strictEqual(reasonOf({ ow: 0 }, 'ow', { version: '7' }), 'out-of-range');
  assert.strictEqual(reasonOf({ ow: 1001 }, 'ow', { version: '7' }), 'out-of-range');
});
check('§1.1 --cw 范围 [0,100]:0 与 100 合法、101 越界(在 6.1 上)', () => {
  assert.strictEqual(flagsOf({ cw: 0 }, { version: '6.1' }), '--cw 0');
  assert.strictEqual(flagsOf({ cw: 100 }, { version: '6.1' }), '--cw 100');
  assert.strictEqual(reasonOf({ cw: 101 }, 'cw', { version: '6.1' }), 'out-of-range');
});

// ── §1.1 carrier 差异(viaBody vs flags) ────────────────────────────
check('M3/§1.1 carrier mj:ar/version 不进 flags 而进 viaBody,且不进 dropped', () => {
  const r = compileMjFlags({ ar: '16:9' }, { version: '7', carrier: 'mj', prompt: 'cat' });
  assert.ok(!r.flags.includes('--ar'), `flags 不许有 --ar(实得 ${JSON.stringify(r.flags)})`);
  assert.ok(!r.flags.includes('--v'), 'flags 不许有 --v');
  assert.ok(!r.flags.includes('--niji'), 'flags 不许有 --niji');
  const via = (r.viaBody || []).map((v) => `${v.field}:${v.bodyKey}`);
  assert.ok(via.includes('ar:size'), `viaBody 应含 ar→size(实得 ${JSON.stringify(via)})`);
  assert.ok(via.includes('version:version'), `viaBody 应含 version→version(实得 ${JSON.stringify(via)})`);
  assert.deepEqual(r.dropped, [], 'viaBody 的字段不许同时进 dropped');
});
check('§1.1 carrier mj + niji 档:viaBody 另有 niji 键', () => {
  const r = compileMjFlags({ ar: '16:9' }, { version: 'niji7', carrier: 'mj', prompt: 'cat' });
  const via = (r.viaBody || []).map((v) => v.field);
  assert.ok(via.includes('niji'), `niji 档 viaBody 应含 niji(实得 ${JSON.stringify(r.viaBody)})`);
});
check('§1.1 carrier mj + speed 非空:viaBody 含 speed→speed', () => {
  const r = compileMjFlags({}, { version: '7', carrier: 'mj', prompt: 'cat', speed: 'fast' });
  assert.deepEqual((r.viaBody || []).filter((v) => v.field === 'speed'), [{ field: 'speed', bodyKey: 'speed' }]);
});
check('§1.1 carrier mj-proxy + speed 非空:viaBody 走 accountFilter.modes,flags 无速度', () => {
  const r = compileMjFlags({}, { version: '7', carrier: 'mj-proxy', prompt: 'cat', speed: 'fast' });
  assert.deepEqual((r.viaBody || []).filter((v) => v.field === 'speed'),
    [{ field: 'speed', bodyKey: 'accountFilter.modes' }]);
  assert.ok(!/--(turbo|fast|relax)/.test(r.flags), `flags 不许出现速度 flag(实得 ${JSON.stringify(r.flags)})`);
});
check('M4/§1.1 carrier mj 且 prompt 已手写 --ar:ar 进 dropped(already-in-prompt)且不进 viaBody', () => {
  const r = compileMjFlags({ ar: '16:9' }, { version: '7', carrier: 'mj', prompt: 'a cat --ar 1:1' });
  assert.strictEqual((r.dropped || []).find((d) => d.field === 'ar')?.reason, 'already-in-prompt');
  assert.ok(!(r.viaBody || []).some((v) => v.field === 'ar'), 'ar 不许再进 viaBody(会与手写的打架)');
});
check('§1.1 carrier mj-proxy:version 走 --v / --niji,ar 走 --ar', () => {
  assert.ok(flagsOf({}, { version: '7' }).includes('--v 7'), '7 应产出 --v 7');
  const niji = flagsOf({}, { version: 'niji7' });
  assert.ok(niji.includes('--niji 7'), 'niji7 应产出 --niji 7');
  assert.ok(!niji.includes('--v'), 'niji 档不许同时发 --v');
  assert.ok(flagsOf({ ar: '16:9' }).includes('--ar 16:9'), 'ar 应产出 --ar 16:9');
});
check('§1.1 carrier mj-proxy + version 空串:不产出 --v 与 --niji', () => {
  const f = flagsOf({}, { version: '' });
  assert.ok(!f.includes('--v'), `不许有 --v(实得 ${JSON.stringify(f)})`);
  assert.ok(!f.includes('--niji'), `不许有 --niji(实得 ${JSON.stringify(f)})`);
});
check('§1.1 任意 carrier 的 flags 永不含 --turbo / --fast / --relax', () => {
  for (const carrier of ['mj', 'mj-proxy']) {
    for (const speed of ['relax', 'fast', 'turbo', '']) {
      const r = compileMjFlags({ stylize: 250 }, { version: '7', carrier, prompt: 'cat', speed });
      assert.ok(!/--turbo|--fast|--relax/.test(r.flags),
        `carrier=${carrier} speed=${speed} 的 flags 不许含速度 flag(实得 ${JSON.stringify(r.flags)})`);
    }
  }
});

// ── §1.1 extraFlags / 长度闸 / 不变式 ────────────────────────────────
check('§1.1 extraFlags 原样追加且恒在 flags 末尾', () => {
  const r = P({ stylize: 250, extraFlags: '--sv 4 --exp 20' });
  assert.ok(r.flags.endsWith('--sv 4 --exp 20'), `extraFlags 必须在末尾(实得 ${JSON.stringify(r.flags)})`);
  assert.ok(r.flags.includes('--s 250'), '其余字段照常在前');
});
check('§1.1 extraFlags 含换行 / 控制字符 → illegal-chars', () => {
  for (const bad of ['--sv 4\n--exp 20', '--sv' + String.fromCharCode(7) + '4']) {
    assert.strictEqual(reasonOf({ extraFlags: bad }, 'extraFlags'), 'illegal-chars', `extraFlags=${JSON.stringify(bad)}`);
  }
});
check('M6/§1.1 长度闸只数 flags 段:超 512 从末尾丢字段并记 too-long', () => {
  const r = P({ negative: 'x'.repeat(600) });
  assert.ok(r.flags.length <= 512, `flags 段必须 <= 512(实得 ${r.flags.length})`);
  assert.ok((r.dropped || []).some((d) => d.reason === 'too-long'), 'dropped 里要有 too-long');
});
check('M6/§1.1 长度闸不把 prompt 本体算进 512:超长 prompt + 一个短 flag 仍照发', () => {
  const r = compileMjFlags({ stylize: 250 }, { version: '7', carrier: 'mj-proxy', prompt: 'c'.repeat(4000) });
  assert.strictEqual(r.flags, '--s 250', 'prompt 再长也不该挤掉 flag');
  assert.deepEqual(r.dropped, [], '不该因 prompt 长而记 too-long');
});
check('§1.1 不变式:每个双连字符前恰一个空格且不在串首;无连续空格与换行', () => {
  const r = P({ stylize: 250, chaos: 20, seed: 7, tile: true, negative: 'ugly, blurry', sref: 'random', sw: 100 });
  const f = r.flags;
  assert.ok(f.length > 0, 'fixture 应产出非空 flags');
  assert.ok(!f.startsWith(' '), 'flags 不许以空格开头');
  assert.ok(!/\s\s/.test(f), `不许有连续空白(实得 ${JSON.stringify(f)})`);
  assert.ok(!/[\n\r\t]/.test(f), '不许有换行/制表符');
  assert.ok(!f.endsWith(' '), 'flags 不许以空格结尾');
  // 「每个双连字符前恰一个空格」按可判定形态落:串首那个 -- 除外(flags 本身以 --x 开头),
  // 其余每个 -- 的前一个字符必须是空格,且再前一个不是空格。
  for (let i = f.indexOf('--', 1); i > 0; i = f.indexOf('--', i + 2)) {
    assert.strictEqual(f[i - 1], ' ', `第 ${i} 位的 -- 前必须恰一个空格(实得 ${JSON.stringify(f)})`);
    assert.notStrictEqual(f[i - 2], ' ', `第 ${i} 位的 -- 前有两个空格(实得 ${JSON.stringify(f)})`);
  }
});
check('§1.1 不变式:同一 field 不得同时出现在 dropped 与 viaBody', () => {
  const r = compileMjFlags({ ar: '16:9', quality: 2, stylize: 9999 },
    { version: '8.2', carrier: 'mj', prompt: 'cat', speed: 'fast' });
  const dropped = new Set((r.dropped || []).map((d) => d.field));
  for (const v of r.viaBody || []) {
    assert.ok(!dropped.has(v.field), `字段 ${v.field} 同时出现在 dropped 与 viaBody`);
  }
});
check('§1.1 dropped 的 reason 取值域只有六个合法值', () => {
  const OK = new Set(['unsupported-version', 'out-of-range', 'already-in-prompt', 'illegal-chars', 'needs-fast-speed', 'too-long']);
  const probes = [
    [{ stylize: 9999 }, { version: '7' }], [{ quality: 2 }, { version: '8.2' }],
    [{ repeat: 4 }, { version: '7', speed: '' }], [{ negative: 'a\nb' }, { version: '7' }],
    [{ seed: 5 }, { version: '7', prompt: 'cat --seed 1' }], [{ negative: 'y'.repeat(900) }, { version: '7' }],
  ];
  for (const [params, over] of probes) {
    for (const d of P(params, over).dropped || []) {
      assert.ok(OK.has(d.reason), `非法 reason ${JSON.stringify(d.reason)}(来自 ${JSON.stringify(params)})`);
      assert.equal(typeof d.field, 'string', 'dropped 项必须带 field 字符串');
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §1.2 mjCapsFor
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §1.2 mjCapsFor');

check('§1.2 mjCapsFor 已导出且是函数', () => {
  assert.equal(typeof mjCapsFor, 'function');
});
const CAPS_TABLE = [
  ['5.1', ['stylize', 'chaos', 'weird', 'seed', 'stop', 'tile', 'styleRaw', 'negative', 'repeat', 'iw'],
    ['quality', 'draft', 'hd', 'cref', 'oref', 'sref', 'profile'], []],
  ['5.2', ['stylize', 'chaos', 'weird', 'seed', 'stop', 'tile', 'styleRaw', 'negative', 'repeat', 'iw'],
    ['quality', 'draft', 'hd', 'cref', 'oref', 'sref', 'profile'], []],
  ['6.1', ['quality', 'stop', 'cref', 'cw', 'sref', 'sw', 'profile'], ['oref', 'ow', 'draft', 'hd'], []],
  ['7', ['quality', 'draft', 'oref', 'ow', 'sref', 'sw', 'profile'], ['stop', 'cref', 'cw', 'hd'], []],
  ['8.1', ['hd', 'sref', 'sw', 'profile'], ['stop', 'cref', 'cw', 'oref', 'ow'], ['quality', 'draft', 'speedTurbo']],
  ['8.2', ['hd', 'sref', 'sw', 'profile'], ['stop', 'cref', 'cw', 'oref', 'ow'], ['quality', 'draft', 'speedTurbo']],
  ['niji6', ['quality', 'stop', 'cref', 'cw', 'sref', 'sw', 'profile'], ['oref', 'draft', 'hd'], []],
  ['niji7', ['quality', 'sref', 'sw', 'profile'], ['stop', 'cref', 'oref', 'draft', 'hd'], []],
];
for (const [v, must, mustNot, disabled] of CAPS_TABLE) {
  check(`M8/M9/§1.2 mjCapsFor('${v}') 的 fields 必含 ${must.join('/')}`, () => {
    const c = mjCapsFor(v);
    assert.ok(c && Array.isArray(c.fields), `fields 必须是数组(实得 ${JSON.stringify(c)})`);
    for (const f of must) assert.ok(c.fields.includes(f), `version ${v} 的 fields 缺 ${f}`);
  });
  check(`M8/§1.2 mjCapsFor('${v}') 的 fields 必不含 ${mustNot.join('/')}`, () => {
    const c = mjCapsFor(v);
    for (const f of mustNot) assert.ok(!c.fields.includes(f), `version ${v} 的 fields 不该有 ${f}`);
  });
  if (disabled.length) {
    check(`M8/§1.2 mjCapsFor('${v}').disabled 必含 ${disabled.join('/')}`, () => {
      const c = mjCapsFor(v);
      assert.ok(c && c.disabled && typeof c.disabled === 'object', 'disabled 必须是对象');
      for (const k of disabled) {
        assert.ok(k in c.disabled, `version ${v} 的 disabled 缺键 ${k}`);
        assert.equal(typeof c.disabled[k], 'string', `disabled.${k} 必须是字符串`);
        assert.ok(c.disabled[k].length > 0, `disabled.${k} 必须非空(要给用户一句说明)`);
      }
    });
  }
}
check('§1.2 ranges.quality:6.1 与 niji6 三档;7 与 niji7 三档', () => {
  assert.deepEqual(mjCapsFor('6.1').ranges.quality, ['0.5', '1', '2']);
  assert.deepEqual(mjCapsFor('niji6').ranges.quality, ['0.5', '1', '2']);
  assert.deepEqual(mjCapsFor('7').ranges.quality, ['1', '2', '4']);
  assert.deepEqual(mjCapsFor('niji7').ranges.quality, ['1', '2', '4']);
});
check('§1.2 ranges.iw 按版本:niji7 [0,2] / niji6 [0,3] / 5.x [0.5,2] / 6.1 与 7 与 8.x [0,3]', () => {
  assert.deepEqual(mjCapsFor('niji7').ranges.iw, [0, 2]);
  assert.deepEqual(mjCapsFor('niji6').ranges.iw, [0, 3]);
  assert.deepEqual(mjCapsFor('5.1').ranges.iw, [0.5, 2]);
  assert.deepEqual(mjCapsFor('5.2').ranges.iw, [0.5, 2]);
  for (const v of ['6.1', '7', '8.1', '8.2']) assert.deepEqual(mjCapsFor(v).ranges.iw, [0, 3], `version=${v}`);
});
check('§1.2 恒定区间(stylize/chaos/weird/seed/stop/repeat/cw/ow/sw)与版本无关', () => {
  const FIXED = {
    stylize: [0, 1000], chaos: [0, 100], weird: [0, 3000], seed: [0, 4294967295],
    stop: [10, 100], repeat: [2, 40], cw: [0, 100], ow: [1, 1000], sw: [0, 1000],
  };
  for (const v of ['5.1', '6.1', '7', '8.2', 'niji6', 'niji7']) {
    for (const [k, want] of Object.entries(FIXED)) {
      assert.deepEqual(mjCapsFor(v).ranges[k], want, `version ${v} 的 ranges.${k}`);
    }
  }
});
check('§1.2 未知/非法版本一律与 8.2 同档且 family 为 v8', () => {
  const base = mjCapsFor('8.2');
  for (const v of ['', null, '9', 7, {}]) {
    const c = mjCapsFor(v);
    assert.ok(c, `mjCapsFor(${String(v)}) 不该返回空`);
    assert.strictEqual(c.family, 'v8', `mjCapsFor(${String(v)}).family 应为 v8`);
    assert.deepEqual(c.fields, base.fields, `mjCapsFor(${String(v)}).fields 应与 8.2 相同`);
    assert.deepEqual(Object.keys(c.disabled || {}).sort(), Object.keys(base.disabled || {}).sort(),
      `mjCapsFor(${String(v)}).disabled 键应与 8.2 相同`);
  }
});
check('§1.2 不变式:disabled 的每个值都是非空字符串', () => {
  for (const v of ['5.1', '5.2', '6.1', '7', '8.1', '8.2', 'niji6', 'niji7']) {
    for (const [k, msg] of Object.entries(mjCapsFor(v).disabled || {})) {
      assert.equal(typeof msg, 'string', `${v}.disabled.${k} 不是字符串`);
      assert.ok(msg.length > 0, `${v}.disabled.${k} 是空串`);
    }
  }
});
check('G2/§1.2 base 是不带前缀的主版本数字串;niji 档剥掉 niji 前缀', () => {
  for (const v of ['5.1', '5.2', '6.1', '7', '8.1', '8.2']) {
    assert.strictEqual(mjCapsFor(v).base, v, `mjCapsFor('${v}').base`);
  }
  assert.strictEqual(mjCapsFor('niji7').base, '7');
  assert.strictEqual(mjCapsFor('niji6').base, '6');
});
check('G2/§1.2 niji 是布尔:niji 两档 true,其余 false', () => {
  assert.strictEqual(mjCapsFor('niji7').niji, true);
  assert.strictEqual(mjCapsFor('niji6').niji, true);
  for (const v of ['5.1', '5.2', '6.1', '7', '8.1', '8.2']) {
    assert.strictEqual(mjCapsFor(v).niji, false, `mjCapsFor('${v}').niji 必须是 false 而不是 undefined`);
  }
});
check('G2/§1.2 未知/空输入回落 8.2 档:base 为 8.2、niji 为 false', () => {
  for (const v of ['', null, '9', 7, {}]) {
    assert.strictEqual(mjCapsFor(v).base, '8.2', `mjCapsFor(${String(v)}).base`);
    assert.strictEqual(mjCapsFor(v).niji, false, `mjCapsFor(${String(v)}).niji`);
  }
});
check('G2/§1.2 family 取值恰在 [v5,v6,v7,v8,niji6,niji7] 内且逐档对应', () => {
  const want = { '5.1': 'v5', '5.2': 'v5', '6.1': 'v6', 7: 'v7', '8.1': 'v8', '8.2': 'v8', niji6: 'niji6', niji7: 'niji7' };
  for (const [v, f] of Object.entries(want)) {
    assert.strictEqual(mjCapsFor(v).family, f, `mjCapsFor('${v}').family`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §1.3 常量 + mjRefModeFor
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §1.3 常量与垫图传法');

check('§1.3 MJ_PARAM_FIELDS 恰为 14 项声明序清单(不含 cref/sref/oref/iw/cw/sw/ow)', () => {
  assert.deepEqual(MP?.MJ_PARAM_FIELDS,
    ['stylize', 'chaos', 'weird', 'seed', 'quality', 'stop', 'tile', 'styleRaw', 'draft', 'hd', 'negative', 'repeat', 'profile', 'extraFlags']);
});
check('R11/§1.3 MJ_REF_MODES 恰为 [upload, inline, url](顺序固定)', () => {
  assert.deepEqual(MP?.MJ_REF_MODES, ['upload', 'inline', 'url']);
});
check('§1.3 MJ_REF_MODE_DEFAULT 深等于 { mj: upload, mj-proxy: 空串 }', () => {
  assert.deepEqual(MP?.MJ_REF_MODE_DEFAULT, { mj: 'upload', 'mj-proxy': '' });
});
check('R11/§1.3 mjRefModeFor({protocol:mj}) 回落 upload', () => {
  assert.strictEqual(mjRefModeFor({ protocol: 'mj' }), 'upload');
});
check('§1.3 mjRefModeFor 认 provider 上合法的 mjRefMode(mj 协议下三值原样返回)', () => {
  for (const m of ['upload', 'inline', 'url']) {
    assert.strictEqual(mjRefModeFor({ protocol: 'mj', mjRefMode: m }), m, `mjRefMode=${m}`);
  }
});
check('§1.3 mjRefModeFor 对白名单外的值回落协议默认(mj → upload)', () => {
  for (const bad of ['UPLOAD', 'base64', '', 42, {}, null, undefined]) {
    assert.strictEqual(mjRefModeFor({ protocol: 'mj', mjRefMode: bad }), 'upload', `mjRefMode=${String(bad)}`);
  }
});
check('M34b/R11/§1.3 mjRefModeFor 对 mj-proxy 恒返回空串(忽略用户填的任何值)', () => {
  for (const m of ['upload', 'inline', 'url', 'x', undefined]) {
    assert.strictEqual(mjRefModeFor({ protocol: 'mj-proxy', mjRefMode: m }), '', `mjRefMode=${String(m)}`);
  }
});
check('§1.3 mjRefModeFor 对 openai/gemini/chat 与非法入参返回空串', () => {
  for (const p of ['openai', 'gemini', 'chat', 'x']) {
    assert.strictEqual(mjRefModeFor({ protocol: p }), '', `protocol=${p}`);
  }
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.strictEqual(mjRefModeFor(bad), '', `provider=${String(bad)}`);
  }
});
check('§1.3 本模块不导出任何「版本 → 真放大命令」映射表', () => {
  assert.ok(MP, `模块未加载,这条无从判定:${MPERR}`);
  const names = Object.keys(MP);
  for (const n of names) {
    assert.ok(!/UPSCALE_COMMAND|UPSCALE_CMD|MJ_UPSCALE/i.test(n), `不该导出 ${n}(真放大命令只能来自 buttons)`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §1.4 mjEffectiveSpeed
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §1.4 mjEffectiveSpeed');

check('§1.4 mjEffectiveSpeed 已导出且是函数', () => {
  assert.equal(typeof mjEffectiveSpeed, 'function');
});
check('§1.4 7 + turbo 原样返回,note 空串', () => {
  assert.deepEqual(mjEffectiveSpeed('7', 'turbo'), { speed: 'turbo', note: '' });
});
check('R3/M10/§1.4 8.1 与 8.2 的 turbo 降级为 fast,note 非空中文且含 fast', () => {
  for (const v of ['8.1', '8.2']) {
    const r = mjEffectiveSpeed(v, 'turbo');
    assert.strictEqual(r.speed, 'fast', `version=${v} 应降级为 fast`);
    assert.ok(typeof r.note === 'string' && r.note.length > 0, `version=${v} 必须给一句说明`);
    assert.ok(r.note.includes('fast'), `version=${v} 的说明要写明按 fast 下发(实得 ${JSON.stringify(r.note)})`);
    assert.ok(/[一-龥]/.test(r.note), `version=${v} 的说明必须是中文`);
  }
});
check('§1.4 不该降级的组合原样返回且 note 空串', () => {
  for (const [v, s] of [['8.2', 'fast'], ['8.2', ''], ['6.1', 'turbo'], ['niji7', 'turbo']]) {
    assert.deepEqual(mjEffectiveSpeed(v, s), { speed: s, note: '' }, `(${v}, ${JSON.stringify(s)})`);
  }
});
check('§1.4 速度大小写不敏感:8.2 + TURBO 也降级为 fast', () => {
  assert.strictEqual(mjEffectiveSpeed('8.2', 'TURBO').speed, 'fast');
});
check('§1.4 版本未指定(null / 空串 / undefined)= 上游默认 8.x → turbo 降级 fast', () => {
  for (const v of [null, '', undefined]) {
    const r = mjEffectiveSpeed(v, 'turbo');
    assert.strictEqual(r.speed, 'fast', `version=${String(v)} 应按 8.x 处理`);
    assert.ok(r.note.length > 0, `version=${String(v)} 必须给说明`);
  }
});
check('§1.4 非白名单速度不抛错、原样返回、note 空串', () => {
  for (const [v, s] of [['8.2', 'x'], ['8.2', null], [null, null]]) {
    const r = mjEffectiveSpeed(v, s);
    assert.strictEqual(r.speed, s, `(${String(v)}, ${String(s)}) 应原样返回`);
    assert.strictEqual(r.note, '', `(${String(v)}, ${String(s)}) 的 note 应为空串`);
  }
});
check('§1.4 不变式:白名单速度下返回值恒在 [空串, relax, fast, turbo] 内;note 非空当且仅当被改写', () => {
  const OK = new Set(['', 'relax', 'fast', 'turbo']);
  for (const v of ['5.1', '6.1', '7', '8.1', '8.2', 'niji6', 'niji7', '']) {
    for (const s of ['', 'relax', 'fast', 'turbo']) {
      const r = mjEffectiveSpeed(v, s);
      assert.ok(OK.has(r.speed), `(${v}, ${s}) 返回了域外速度 ${JSON.stringify(r.speed)}`);
      assert.strictEqual(r.note.length > 0, r.speed !== s, `(${v}, ${s}) note 与是否改写必须一致`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// B. §3 能力表 server/utils/image-caps.js:分隔符容忍 + 未登记模型条目
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] §3 image-caps 分隔符容忍与未登记模型');

let CAPS = null;
let CAPSERR = '';
try {
  CAPS = await import('../../server/utils/image-caps.js');
} catch (e) {
  CAPSERR = String((e && e.message) || e);
}
check('B0 image-caps.js 可 import', () => assert.ok(CAPS, `import 失败:${CAPSERR}`));
const sizeCapFor = CAPS?.sizeCapFor;
const sizeOptionsFor = CAPS?.sizeOptionsFor;
// imageParams 的导出落在 image-protocols.js(能力表由它消费),两处都取一遍以免 import 失败拖垮整段。
let PROTO = null;
try { PROTO = await import('../../server/utils/image-protocols.js'); } catch { PROTO = null; }
const imageParams = PROTO?.imageParams;

check('§3 正向:gpt-image-2 与 gpt-image-2-mini 仍是 gpt-image-2 家族(本轮之前相同)', () => {
  assert.strictEqual(sizeCapFor('openai', 'gpt-image-2').family, 'gpt-image-2');
  assert.strictEqual(sizeCapFor('openai', 'gpt-image-2-mini').family, 'gpt-image-2');
});
check('§3 正向:带斜杠前缀 openai/gpt-image-2 命中 gpt-image-2', () => {
  assert.strictEqual(sizeCapFor('openai', 'openai/gpt-image-2').family, 'gpt-image-2');
});
check('R6/M43/§3 正向:带连字符前后缀 xxx-gpt-image-2-vip 命中 gpt-image-2', () => {
  assert.strictEqual(sizeCapFor('openai', 'xxx-gpt-image-2-vip').family, 'gpt-image-2');
});
check('§3 正向:apimart 的 relay/gpt-image-2-official 仍先命中 official 条目', () => {
  assert.strictEqual(sizeCapFor('apimart', 'relay/gpt-image-2-official').family, 'gpt-image-2 官方渠道');
});
check('§3 正向(写死为预期行为):my-dall-e-2-clone 命中 DALL·E 2 且候选是封闭 3 项', () => {
  const c = sizeCapFor('openai', 'my-dall-e-2-clone');
  assert.strictEqual(c.family, 'DALL·E 2');
  assert.deepEqual(sizeOptionsFor('openai', 'my-dall-e-2-clone'), ['256x256', '512x512', '1024x1024']);
});
check('M44/§3 反向:openai/gpt-5.4-image-2 不命中(串里没有 gpt-image-2)→ unknown 为 true', () => {
  assert.strictEqual(sizeCapFor('openai', 'openai/gpt-5.4-image-2').unknown, true);
});
check('M44/§3 反向:gpt5image2 与 imagegpt-image 不命中(去掉分隔符要求就会红)', () => {
  assert.strictEqual(sizeCapFor('openai', 'gpt5image2').unknown, true);
  assert.strictEqual(sizeCapFor('openai', 'imagegpt-image').unknown, true);
});
check('§3 反向:flux-pro-1.1 与 nano-banana 不命中', () => {
  assert.strictEqual(sizeCapFor('openai', 'flux-pro-1.1').unknown, true);
  assert.strictEqual(sizeCapFor('openai', 'nano-banana').unknown, true);
});
check('R5/M45/§3 未登记模型有固定条目:非 null、unknown 为 true、family 为「未登记模型」', () => {
  const c = sizeCapFor('openai', 'my-relay-custom-model');
  assert.notStrictEqual(c, null, '不许回落 null');
  assert.strictEqual(c.unknown, true);
  assert.strictEqual(c.family, '未登记模型');
  assert.strictEqual(c.sizeMode, 'pixel');
});
check('§3 未登记模型条目的 fields / qualities / formats / resolutions 形态', () => {
  const c = sizeCapFor('openai', 'my-relay-custom-model');
  assert.deepEqual(c.fields, ['size', 'n', 'quality', 'outputFormat', 'background', 'moderation']);
  assert.deepEqual(c.qualities, CAPS.IMAGE_QUALITIES);
  assert.deepEqual(c.formats, CAPS.IMAGE_OUTPUT_FORMATS);
  assert.strictEqual(c.resolutions, null);
});
check('§3 未登记模型的尺寸候选是全量 SIZE_OPTIONS', () => {
  assert.deepEqual(sizeOptionsFor('openai', 'my-relay-custom-model'), CAPS.SIZE_OPTIONS);
});
check('§3 空 / null / undefined / 数字模型名同样落未登记形态', () => {
  for (const m of ['', null, undefined, 123]) {
    const c = sizeCapFor('openai', m);
    assert.notStrictEqual(c, null, `model=${String(m)} 不许 null`);
    assert.strictEqual(c.unknown, true, `model=${String(m)} 应 unknown`);
    assert.strictEqual(c.family, '未登记模型', `model=${String(m)} 的 family`);
  }
});
check('M46/§3 回归:已登记家族的 unknown 为假值,候选逐字不变', () => {
  assert.ok(!sizeCapFor('openai', 'gpt-image-2').unknown, 'gpt-image-2 不该 unknown');
  assert.ok(!sizeCapFor('openai', 'dall-e-3').unknown, 'dall-e-3 不该 unknown');
  assert.deepEqual(sizeOptionsFor('openai', 'dall-e-3'), ['1024x1024', '1792x1024', '1024x1792']);
  assert.deepEqual(sizeOptionsFor('openai', 'gpt-image-1'), ['auto', '1024x1024', '1536x1024', '1024x1536']);
});
check('M46/§3 回归:dall-e-3 的结构化参数门一字不变(n 归 1、quality 归空)', () => {
  const b = imageParams({ dialect: 'openai', model: 'dall-e-3', n: 3, quality: 'high' });
  assert.strictEqual(b.n, 1);
  assert.strictEqual(b.quality, '');
});
check('§3 未登记模型放开五键,但 apimart 专属两键仍不发', () => {
  const b = imageParams({
    dialect: 'openai', model: 'my-relay-custom-model', n: 3, quality: 'high',
    outputFormat: 'webp', background: 'transparent', moderation: 'low', resolution: '2k', nsfwCheck: true,
  });
  assert.strictEqual(b.n, 3);
  assert.strictEqual(b.quality, 'high');
  assert.strictEqual(b.outputFormat, 'webp');
  assert.strictEqual(b.background, 'transparent');
  assert.strictEqual(b.moderation, 'low');
  assert.strictEqual(b.resolution, '', 'resolution 只在 apimart 方言下出');
  assert.strictEqual(b.nsfwCheck, false, 'nsfwCheck 只在 apimart 方言下出');
});
check('§3 回归:apimart 未登记条目的 fields 仍逐字 [size, n, nsfwCheck]', () => {
  assert.deepEqual(sizeCapFor('apimart', 'zzz').fields, ['size', 'n', 'nsfwCheck']);
});
check('§3 不变式:放开 quality / outputFormat 的条目必须给得出候选', () => {
  for (const [d, m] of [['openai', 'my-relay-custom-model'], ['openai', 'gpt-image-2'], ['apimart', 'zzz']]) {
    const c = sizeCapFor(d, m);
    if (c.fields.includes('quality')) assert.ok(Array.isArray(c.qualities) && c.qualities.length, `${d}/${m} 放开 quality 却没有候选`);
    if (c.fields.includes('outputFormat')) assert.ok(Array.isArray(c.formats) && c.formats.length, `${d}/${m} 放开 outputFormat 却没有候选`);
    if (c.fields.includes('resolution')) assert.ok(Array.isArray(c.resolutions) && c.resolutions.length, `${d}/${m} 放开 resolution 却没有候选`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r94-mj-params: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r94-mj-params: 参数编译层 + 版本能力表 + 速度降级 + 垫图传法常量 + 能力表分隔符容忍 全绿');
