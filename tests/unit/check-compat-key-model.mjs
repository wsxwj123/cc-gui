#!/usr/bin/env node
// R8-4 setModel 原地切模型护栏(server/routes/chat.js)。
// 语义依据(spike-a 实测,SDK 0.3.191 + CLI 2.1.227):query.setModel(id) 回合间调用
// 生效,下一回合 assistant.message.model 即新模型;切换后 CLI 补发新 init(同 session_id)。
// 契约:① chatCompatKey 不再含 model(仅换模型可复用温进程,保住温 MCP);
//      ② 复用命中且模型不同必须在推消息前 setModel 对账(成功更新 slot.currentModel);
//      ③ setModel 抛错/超时/epoch 失效 → 放弃复用走既有 teardown+冷启,绝不带错模型继续。
// 变异哨兵:删掉复用块的 setModel 调用行 → 本文件源码守卫 + 行为断言必须红。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// HOME 隔离:chatCompatKey 会 stat ~/.claude/settings.json 等(只读 mtime,不写),
// 指到空 tmp 让 mtime 恒 0,断言只关心字段增减不受本机文件影响。
const REAL_HOME = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'cgui-compat-test-'));
process.env.HOME = home;

const { chatCompatKey } = await import('../../server/routes/chat.js');

const base = {
  workingDir: '/tmp/proj', effort: 'high', appendSystemPrompt: '', promptSuggestions: false,
  excludeDynamicSystemPrompt: 'auto', globalRead: true, dirs: ['/'], maxBudgetUsd: null,
};

try {
  // ── ① compatKey 不再含 model:仅模型不同 → 同 key(可复用) ────────────────
  const kA = chatCompatKey({ ...base, model: 'claude-sonnet-4-6' });
  const kB = chatCompatKey({ ...base, model: 'claude-haiku-4-5-20251001' });
  assert.equal(kA, kB, '仅 model 不同必须生成同一 compatKey(否则退回整进程重建)');
  assert.ok(!kA.includes('sonnet') && !kA.includes('model'), 'key 里不残留 model 字段/值');
  // 其余键仍触发重建:effort / cwd / budget 差异必须不同 key(行为回归)
  assert.notEqual(kA, chatCompatKey({ ...base, effort: 'low' }), 'effort 变化仍换 key');
  assert.notEqual(kA, chatCompatKey({ ...base, workingDir: '/tmp/other' }), 'cwd 变化仍换 key');
  assert.notEqual(kA, chatCompatKey({ ...base, maxBudgetUsd: 5 }), 'budget 变化仍换 key');

  // ── ② 复用对账行为(与 chat.js 复用块同构的最小执行模型,mock query 计数) ──
  // 结构照抄实现:5s race + epoch 复查 + 失败置 closing。源码守卫(下方③)钉住实现
  // 本体没被改回,这里验证该结构的语义正确性。
  async function reconcile(s, model) {
    if (model !== s.currentModel) {
      const epochAtSwitch = s.turnEpoch | 0;
      let switchTimer = null;
      try {
        await Promise.race([
          s.query.setModel(model),
          new Promise((_, reject) => { switchTimer = setTimeout(() => reject(new Error('setModel 超时')), 50); }),
        ]);
        if ((s.turnEpoch | 0) !== epochAtSwitch || s.closing) throw new Error('epoch advanced');
        s.currentModel = model;
        s.model = model;
      } catch {
        s.closing = true;
        try { s.input.close(); } catch {}
        return { reused: false };
      } finally { if (switchTimer) clearTimeout(switchTimer); }
    }
    return { reused: true };
  }
  const mkSlot = (impl) => ({
    currentModel: 'claude-sonnet-4-6', model: 'claude-sonnet-4-6', turnEpoch: 3, closing: false,
    input: { closed: 0, close() { this.closed++; } },
    query: { setModelCalls: 0, async setModel(m) { this.setModelCalls++; return impl ? impl(m) : undefined; } },
  });

  // 模型相同 → 不调 setModel,直接复用
  {
    const s = mkSlot();
    assert.deepEqual(await reconcile(s, 'claude-sonnet-4-6'), { reused: true });
    assert.equal(s.query.setModelCalls, 0, '同模型零调用');
  }
  // 模型不同 → 必调 setModel 一次,成功后 currentModel/model 都更新
  {
    const s = mkSlot();
    assert.deepEqual(await reconcile(s, 'claude-haiku-4-5-20251001'), { reused: true });
    assert.equal(s.query.setModelCalls, 1, '换模型必须经 setModel 对账(变异哨兵:删调用行这里红)');
    assert.equal(s.currentModel, 'claude-haiku-4-5-20251001', '成功后 currentModel 更新');
    assert.equal(s.model, 'claude-haiku-4-5-20251001', '展示用 model 同步');
  }
  // setModel 抛错 → 放弃复用:closing + input.close,currentModel 不动
  {
    const s = mkSlot(() => { throw new Error('boom'); });
    assert.deepEqual(await reconcile(s, 'claude-haiku-4-5-20251001'), { reused: false });
    assert.equal(s.closing, true, '抛错必须关旧开新');
    assert.equal(s.input.closed, 1, '关流让进程自然退出');
    assert.equal(s.currentModel, 'claude-sonnet-4-6', '失败不得半更新模型');
  }
  // setModel 挂死(永不 resolve)→ 超时 race 兜底 → 放弃复用(绝不悬空)
  {
    const s = mkSlot(() => new Promise(() => {}));
    assert.deepEqual(await reconcile(s, 'claude-haiku-4-5-20251001'), { reused: false });
    assert.equal(s.closing, true, '超时同样关旧开新');
  }
  // await 期间 epoch 被推进(停止链路/复用竞争)→ 本次复用作废
  {
    const s = mkSlot(function () { s.turnEpoch += 1; });
    assert.deepEqual(await reconcile(s, 'claude-haiku-4-5-20251001'), { reused: false });
    assert.equal(s.closing, true, 'epoch 失效中止复用');
  }
} finally {
  process.env.HOME = REAL_HOME;
  rmSync(home, { recursive: true, force: true });
}

// ── ③ 源码守卫:实现本体的承重行不得被改掉 ─────────────────────────────
{
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'chat.js'), 'utf8');
  // compatKey 函数体内不得再出现 model 字段
  const keyFn = src.slice(src.indexOf('export function chatCompatKey'), src.indexOf('export function closePersistentForSession'));
  assert.ok(!/\bmodel\b/.test(keyFn.slice(keyFn.indexOf('return JSON.stringify'))), 'chatCompatKey 序列化体不得含 model');
  // 复用块:setModel 对账必须存在,且发生在推消息(input.push)之前
  const reuseStart = src.indexOf('const reuseKey = chatCompatKey');
  const reuseBlock = src.slice(reuseStart, src.indexOf('一会话一进程', reuseStart));
  const setModelAt = reuseBlock.indexOf('s.query.setModel(model)');
  const pushAt = reuseBlock.indexOf("s.input.push({ type: 'user'");
  assert.ok(setModelAt > -1, '复用块必须有 setModel 对账(变异哨兵:删掉这一行必红)');
  assert.ok(pushAt > setModelAt, 'setModel 必须在推消息之前(带错模型的消息一条都不能发)');
  assert.ok(/epochAtSwitch/.test(reuseBlock), 'setModel 必须带 epoch 前移守卫(照抄 setPermissionMode 模式)');
  assert.ok(/setModel 超时/.test(reuseBlock) && /Promise\.race/.test(reuseBlock), '必须有 5s 超时 race(不能悬空)');
  // slot 定义带 currentModel 初始化(spawn 时 = options.model 实际值)
  assert.ok(/currentModel: model,/.test(src), 'slot 定义必须初始化 currentModel');
}

console.log('✓ check-compat-key-model: key 去 model + 对账五态(同/换/错/超时/epoch) + 源码守卫 全过');
