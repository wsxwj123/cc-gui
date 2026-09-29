// 修前在当前代码上生成 D 组基线:node --input-type=module 不便传 TZ,统一走 run.sh 的环境:
//   TZ=Asia/Shanghai R130_DATA_ROOT=<任意 .artifacts 下目录> node tests/acceptance/r130-home-usage/helpers/snapshot.mjs
// 输出 helpers/d-baseline.json(提交进仓库)。基线 = 当前代码对 d-fixture 的 total/byModel/byProject/byDay(既有六键)。
import fs from 'node:fs';
import path from 'node:path';
import { caseRoot, suitePath } from './fixtures.mjs';
import { startInstance, getUsage, stopAll } from './instance.mjs';
import { dFixture, legacyView } from './d-fixture.mjs';

const { root, home } = caseRoot('d', 'snapshot');
dFixture(home);
const inst = await startInstance({ root, home }, {}, { label: 'snapshot' });
const r = await getUsage(inst.base);
await stopAll();
if (r.status !== 200 || !r.json?.total) throw new Error(`基线生成失败:HTTP ${r.status} ${r.text.slice(0, 200)}`);
const out = suitePath('helpers', 'd-baseline.json');
fs.writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), note: '修前(HEAD 782bb0ae)在当前代码上生成;byDay 只含既有六键', legacy: legacyView(r.json) }, null, 2)}\n`);
console.log(`[r130] 基线已写:${path.relative(process.cwd(), out)}(byModel ${r.json.byModel.length} 行 / byDay ${r.json.byDay.length} 行)`);
