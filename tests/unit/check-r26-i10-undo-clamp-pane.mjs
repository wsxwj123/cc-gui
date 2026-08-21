#!/usr/bin/env node
// r26-I10 单测:撤销删除恢复窗格夹紧 paneCount。
// 哨兵:clampPaneIndex 摘掉 Math.min(max,...) → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampPaneIndex } from '../../client/src/utils/projectPanel.js';

// t1 夹紧矩阵:paneCount=1 时目标 index=2 → 落 0(夹紧哨兵)
{
  assert.equal(clampPaneIndex(2, 1), 0, 't1: paneCount=1 夹到 0');
  assert.equal(clampPaneIndex(0, 1), 0, 't1: 0 保持');
  assert.equal(clampPaneIndex(1, 3), 1, 't1: 合法下标不动');
  assert.equal(clampPaneIndex(5, 3), 2, 't1: 越界夹到 paneCount-1');
  assert.equal(clampPaneIndex(-1, 3), 0, 't1: 负下标夹 0');
  assert.equal(clampPaneIndex(2, 0), 0, 't1: paneCount=0 非法态兜底 0');
  assert.equal(clampPaneIndex(2, undefined), 0, 't1: paneCount 缺省按 1');
}

// t2 行为哨兵:真实 store —— paneCount=1 时经 clampPaneIndex 恢复,落 pane 0
{
  const lsMap = new Map();
  globalThis.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(k, String(v)),
    removeItem: (k) => lsMap.delete(k),
  };
  globalThis.window = globalThis;
  if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
  if (!globalThis.matchMedia) globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { useStore } = await import('../../client/src/stores/sessionStore.js');
  useStore.getState().setPaneCount(1);
  const st = useStore.getState();
  const restored = { sessionId: 'undo-me', projectHash: 'h' };
  const idx = clampPaneIndex(2, st.paneCount); // 撤销时记下的旧下标 2,当前只剩 1 窗格
  st.setPaneSession(idx, restored);
  assert.equal(useStore.getState().paneSessions[0]?.sessionId, 'undo-me', 't2: 夹紧后落 pane 0(可见)');
}

// t3 源码钉:undoDelete 过 clampPaneIndex
{
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  const undo = sb.match(/const undoDelete = \(sid\) => \{[\s\S]*?\n  \};/);
  assert.ok(undo, 't3: undoDelete 应存在');
  assert.match(undo[0], /clampPaneIndex\(i, st\.paneCount\)/, 't3: 恢复下标夹 paneCount');
  assert.match(undo[0], /\{ tab: idx, silent: true \}/, 't3: fetchMessages 用夹后下标');
}

console.log('check-r26-i10-undo-clamp-pane: all passed');
