// r151e:写 <数据根>/fakebin/claude 垫片(run.sh 在一期 fixtures.mjs 建好 HOME 之后调用本文件)。
// 先照 r151c 的 shim-p2.mjs 原样生成二期垫片(真 CLI 车道、本地假接口检查都不变),再只换最后一行:
// 非真 CLI 车道 exec 的从"一期假 claude"换成本套件的外壳 mute-claude.mjs(它原样跑一期假 claude,只多"指定进程吞掉切档请求")。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeShimP2 } from '../../r151c-xsession-p2/helpers/shim-p2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.resolve(here, '..', '..', 'r151b-xsession-p1', 'helpers', 'fake-claude.mjs');
const mute = path.join(here, 'mute-claude.mjs');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function writeShimE() {
  const shim = writeShimP2();
  const text = fs.readFileSync(shim, 'utf8');
  const from = `exec ${q(process.execPath)} ${q(fake)} "$@"`;
  if (!text.includes(from)) throw new Error(`二期垫片的最后一行不是预期的形状(${from}),无法换成本套件的外壳`);
  fs.writeFileSync(shim, text.replace(from, `exec ${q(process.execPath)} ${q(mute)} "$@"`));
  fs.chmodSync(shim, 0o755);
  return shim;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`[r151e] 垫片就绪:${writeShimE()}(非真 CLI 车道 → ${mute})`);
}
