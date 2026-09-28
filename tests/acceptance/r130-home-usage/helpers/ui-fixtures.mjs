// r130 · 界面组共用的隔离 HOME:一个真实存在的项目目录 + 两条"今天"的会话(user+assistant 各一条)+ PATH 上的假 claude(复用 r122 的桩)。
// run.sh 起实例前先跑本文件(node helpers/ui-fixtures.mjs)。夹具几十字节;界面用例大多用 page.route 打桩 /api/usage,
// 只有"真数据端到端"与用量面板不变项用到这份真数据。期望值一起落成 ui-expected.json 给用例读。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKTREE, dataRoot, suitePath, buildHome, writeJsonl, assistant, user, sid, tsAgo, today, sum4, assertIsolated } from './fixtures.mjs';

export const uiHome = () => path.join(dataRoot(), 'ui', 'home');
export const uiExpectedPath = () => path.join(dataRoot(), 'ui', 'ui-expected.json');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
/** 与真 CLI 同口径:cwd 里非字母数字一律换成 '-'。 */
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const U1 = [1200, 300, 5000, 400];      // 会话 1 的助手回复 token(合计 6900)
const U2 = [800, 200, 3000, 100];       // 会话 2(合计 4100)

export function buildUiFixtures() {
  const home = buildHome(uiHome());
  const workspace = path.join(dataRoot(), 'ui', 'fixture-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'r130 ui fixture\n');
  const cwd = fs.realpathSync(workspace);
  const proj = encodeProjectDir(cwd);
  const T = today();
  const recs = (n, u) => [
    { type: 'summary', summary: `R130UI${n} 首页用量夹具会话`, leafUuid: `r130-ui-leaf-${n}` },
    { ...user({ ts: tsAgo(0, 9, n), text: `R130UI${n} 看一下这个仓库。` }), cwd, sessionId: sid(n) },
    { ...assistant({ ts: tsAgo(0, 9, n + 1), model: 'claude-sonnet-4-6', u }), cwd, sessionId: sid(n) },
  ];
  writeJsonl(path.join(home, '.claude', 'projects', proj, `${sid(1)}.jsonl`), recs(1, U1));
  writeJsonl(path.join(home, '.claude', 'projects', proj, `${sid(2)}.jsonl`), recs(2, U2));
  fs.mkdirSync(path.join(home, 'fake-claude'), { recursive: true });
  const bin = fakebinDir();
  assertIsolated(bin);
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(WORKTREE, 'tests', 'acceptance', 'r122-ui-batch', 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const expected = { day: T, sessions: 2, calls: 2, messages: 4, tokens: sum4(U1) + sum4(U2), model: 'claude-sonnet-4-6', hour: 9, cwd, proj };
  fs.writeFileSync(uiExpectedPath(), JSON.stringify(expected, null, 2));
  return { home, cwd, proj, expected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildUiFixtures();
  console.log(`[r130] 界面夹具就绪:HOME=${r.home} 项目=${r.cwd} 今天=${r.expected.day} tokens=${r.expected.tokens}`);
}
