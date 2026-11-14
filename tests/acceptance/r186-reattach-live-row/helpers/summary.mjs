// 读 .artifacts/results.json,打印 通过 / 失败 / 跳过 的计数,并逐条列出失败用例(项目 + 标题)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.artifacts', 'results.json');
let report;
try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  console.log(`[R186] 没有读到 ${file}(用例可能根本没跑起来):${e.message}`);
  process.exit(0);
}
let passed = 0; let failed = 0; let skipped = 0;
const failures = [];
const walk = (suite) => {
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const last = (t.results || [])[(t.results || []).length - 1];
      const status = last ? last.status : t.status;
      if (t.status === 'skipped' || status === 'skipped') skipped += 1;
      else if (status === 'passed') passed += 1;
      else { failed += 1; failures.push(`${t.projectName} › ${spec.title}`); }
    }
  }
  for (const s of suite.suites || []) walk(s);
};
for (const s of report.suites || []) walk(s);
console.log(`[R186] 通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}`);
for (const f of failures) console.log(`[R186] 失败:${f}`);
