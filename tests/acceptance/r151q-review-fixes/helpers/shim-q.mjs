// r151q:写 <数据根>/fakebin/claude 垫片 —— 照 r151k 的 shim-k.mjs:二期垫片(真 CLI 车道不变),非真 CLI 车道换成本套件的 fx-claude.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeShimP2 } from '../../r151c-xsession-p2/helpers/shim-p2.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.resolve(here, '..', '..', 'r151b-xsession-p1', 'helpers', 'fake-claude.mjs');
const fx = path.join(here, 'fx-claude.mjs');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function writeShimQ() {
  const shim = writeShimP2();
  const text = fs.readFileSync(shim, 'utf8');
  const from = `exec ${q(process.execPath)} ${q(fake)} "$@"`;
  if (!text.includes(from)) throw new Error(`二期垫片的最后一行不是预期的形状(${from})`);
  fs.writeFileSync(shim, text.replace(from, `exec ${q(process.execPath)} ${q(fx)} "$@"`));
  fs.chmodSync(shim, 0o755);
  return shim;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`[r151q] 垫片就绪:${writeShimQ()}`);
