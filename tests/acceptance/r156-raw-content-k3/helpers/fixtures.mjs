// r156 夹具:全部写进假家目录(Downloads/ 下),内容真实可用。
// SVG 文本逐字取自接口文件第 0 条第 9、10 项;PNG / MP4 / WebM 是 media-fixtures.mjs 里的 base64 常量;
// WAV 与 PDF 由 Node 现场生成(8000Hz 8 位单声道 800 个样本;最小合法 PDF,xref 偏移精确)。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MP4_B64, WEBM_B64, PNG_B64 } from './media-fixtures.mjs';

/** 带脚本 SVG:脚本运行 = window.__state === 'ran'(接口文件 0.10)。 */
export const SVG_SCRIPT = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c33"/><script>window.__state='ran'; window.__frames=[]; try{var ws=new WebSocket('ws://'+location.host+'/ws'); ws.onmessage=function(e){try{window.__frames.push(JSON.parse(e.data).type)}catch(x){window.__frames.push('?')}};}catch(x){}</script></svg>`;
/** 无脚本 SVG(接口文件 0.9)。 */
export const SVG_PLAIN = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>';

export const PNG = Buffer.from(PNG_B64, 'base64');
export const MP4 = Buffer.from(MP4_B64, 'base64');
export const WEBM = Buffer.from(WEBM_B64, 'base64');

/** 8000Hz、8 位无符号、单声道、800 个样本(0.1 秒)的 WAV。 */
export function makeWav() {
  const n = 800;
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) data[i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * 440 * i) / 8000));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, data]);
}

/** 最小合法 PDF(1 页 200x200,一个 Helvetica 文本),xref 偏移按实际字节算。全 ASCII,字符串长度即字节数。 */
export function makePdf() {
  const stream = 'BT /F1 24 Tf 20 100 Td (r156) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** 每个文件名对应一段确定性的"任意字节":带固定前缀 + sha256 摘要(含非 UTF-8 字节,能暴露转码/截断)。 */
export function bytesFor(name) {
  return Buffer.concat([Buffer.from(`R156:${name}:`, 'utf8'), crypto.createHash('sha256').update(`r156/${name}`).digest(), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
}

/** 写进假家目录(rel 相对假家目录),返回绝对路径。 */
export function writeFixture(home, rel, buf) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}
export const dl = (name) => path.join('Downloads', name);

/** 读文件接口的 raw 地址;extra 例如 '&probe=x'。 */
export const rawPath = (absPath, extra = '') => `/api/files/read?raw=1&path=${encodeURIComponent(absPath)}${extra}`;
export const rawUrl = (base, absPath, extra = '') => `${base}${rawPath(absPath, extra)}`;
