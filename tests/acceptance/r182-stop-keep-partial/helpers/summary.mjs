// 读 Playwright 的 json 结果,打印「通过 / 失败 / 跳过」计数和每条用例的结果(用于运行脚本收尾)。
import fs from 'node:fs';

const file = process.argv[2];
let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`[R182] 没有读到结果文件 ${file}:${e.message}`); process.exit(0); }

const rows = [];
function walk(suite) {
  for (const s of suite.suites || []) walk(s);
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const last = (t.results || [])[t.results.length - 1] || {};
      rows.push({ project: t.projectName, title: spec.title.slice(0, 60), status: t.status, ms: last.duration });
    }
  }
}
for (const s of data.suites || []) walk(s);
let pass = 0; let fail = 0; let skip = 0;
for (const r of rows) {
  if (r.status === 'expected') pass += 1; else if (r.status === 'skipped') skip += 1; else fail += 1;
  console.log(`[R182]   ${r.status === 'expected' ? '通过' : r.status === 'skipped' ? '跳过' : '失败'}  [${r.project}] ${r.title}  (${Math.round((r.ms || 0) / 1000)}s)`);
}
console.log(`[R182] 计数:通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
