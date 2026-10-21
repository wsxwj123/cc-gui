#!/usr/bin/env node
// 渲染层兜底:历史里同一句话之后已有内容 → 隐藏本地乐观气泡(防"自己发的消息反复出现在底部")。
import assert from 'node:assert/strict';
import { dropStaleUserEchoes } from '../../client/src/utils/userEcho.js';
const textOf = (m) => m?.text || '';
const u = (uuid, text, ts) => ({ uuid, type: 'user', text, timestamp: ts });
const t = (uuid, text, ts) => ({ uuid, type: 'turn', text, timestamp: ts });
const base = '2026-10-21T11:48:50.000Z';
// t1 历史已推进(句后有回复)→ 本地副本被隐藏
{
  const hist = [u('h1', '合并；主机名是什么？', base), t('r1', '回复', '2026-10-21T11:48:55.000Z')];
  const local = [u('chat-user-1', '合并；主机名是什么？', base)];
  assert.deepEqual(dropStaleUserEchoes(local, hist, textOf), [], '历史已推进 → 本地副本撤掉');
}
// t2 历史里该句还是最后一条(回合还没产出)→ 本地保留
{
  const hist = [u('h1', '合并；主机名是什么？', base)];
  const local = [u('chat-user-1', '合并；主机名是什么？', base)];
  assert.equal(dropStaleUserEchoes(local, hist, textOf).length, 1, '回合未推进 → 保留本地气泡');
}
// t3 不同文本不动
{
  const hist = [u('h1', '别的话', base), t('r1', '回复', '2026-10-21T11:48:55.000Z')];
  const local = [u('chat-user-1', '合并；主机名是什么？', base)];
  assert.equal(dropStaleUserEchoes(local, hist, textOf).length, 1, '文本不同 → 不动');
}
// t4 同一句话连发两次:后发的那条(时间戳晚)保留
{
  const hist = [u('h1', '继续', base), t('r1', '回复', '2026-10-21T11:48:55.000Z')];
  const local = [u('chat-user-1', '继续', '2026-10-21T11:49:00.000Z')];
  assert.equal(dropStaleUserEchoes(local, hist, textOf).length, 1, '后发的同文本消息保留');
}
// t5 多个重复本地副本全撤;非 user 条目不动;归一化空白
{
  const hist = [u('h1', '合并； 主机名是什么？', base), t('r1', '回复', '2026-10-21T11:48:55.000Z')];
  const local = [u('chat-user-1', '合并；主机名是什么？', base), u('chat-user-2', '合并；主机名是什么？', base), { uuid: 'btw-1', type: 'btw', text: 'x' }];
  const out = dropStaleUserEchoes(local, hist, textOf);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'btw');
}
// t6 空集/无 fetch 文本函数
{
  assert.deepEqual(dropStaleUserEchoes([], [], textOf), []);
  assert.equal(dropStaleUserEchoes([u('l', 'x', base)], [u('h', 'x', base), t('r', 'y', base)]).length, 0);
}
console.log('check-user-echo-dedupe: all passed');
