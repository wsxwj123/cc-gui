// J. 文档(行为 25):读对外发布物 CHANGELOG.md、client/src/generated/release-notes/、README.md,不碰实现代码。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p) => { try { return fs.readFileSync(path.join(ROOT, ...p), 'utf8'); } catch { return ''; } };
const sectionsOf = (md) => { const marks = [...md.matchAll(/^## v?(\d+\.\d+\.\d+)[^\n]*$/gm)]; return marks.map((m, i) => ({ version: m[1], body: md.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : md.length) })); };
const newer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const norm = (s) => String(s).replace(/\s+/g, '');
const OLD = {
  '0.2.431': ['还原后出现任何非 Latin-1 字符(中文、✻、·、全角标点等)都会还原', '正常外文/英文仍原样不动'], // 单独的"·"也还原 / 所有外文都不动
  '0.2.428': ['provider 模型列表里已有的模型、以及显式选择的名字不会被改写'],                              // 显式选择的名字一律不改写
};

test('Q25 CHANGELOG 有本轮一节;0.2.431 / 0.2.428 的过头说法已改正;应用内更新说明与 README 更新记录与 CHANGELOG 一致', () => {
  const secs = sectionsOf(read('CHANGELOG.md'));
  const readme = read('README.md');
  const top = secs[0] || { version: '0.0.0', body: '' };
  const section = (v) => (secs.find((s) => s.version === v) || { body: '' }).body;
  const releaseItems = (v) => { try { return JSON.parse(read('client', 'src', 'generated', 'release-notes', `${v}.json`)).groups.flatMap((g) => g.items); } catch { return []; } };
  const readmeBlock = (v) => { const i = readme.indexOf(`<summary><b>v${v}</b>`); if (i < 0) return ''; const j = readme.indexOf('<summary><b>v', i + 10); return readme.slice(i, j < 0 ? i + 8000 : j); };

  expect.soft(newer(top.version, '0.2.432'), `CHANGELOG 最上面一节应比 0.2.432 更新(现在最上面是 ${top.version})`).toBe(true);
  const bullets = top.body.split('\n').filter((l) => /^- /.test(l)); // 最上面一节的条数,下面与应用内更新说明的条数对账用
  // "本轮"固定指 0.2.433:按版本号找这一节,不把最上面一节当本轮(之后更新的版本加到最上面也不影响);找不到该节则失败
  const ROUND = '0.2.433';
  const roundSec = secs.find((s) => s.version === ROUND);
  expect.soft(roundSec !== undefined, `CHANGELOG 里应有 ${ROUND} 这一节(最近几节:${secs.slice(0, 5).map((s) => s.version).join('、') || '无'})`).toBe(true);
  const roundBody = roundSec ? roundSec.body : '';
  const roundBullets = roundBody.split('\n').filter((l) => /^- /.test(l));
  const topics = [/粘贴|乱码/, /费用|计价/, /模型名|映射|代理/, /跨会话|入站|等你确认|待处理/, /静默|看门狗/, /审核模型/, /电脑操控|[Nn]ode/];
  expect.soft({ bullets: roundBullets.length >= 3, topicsCovered: topics.filter((re) => re.test(roundBody)).length >= 3 }, `${ROUND} 一节应至少 3 条、且覆盖 7 类改动里的至少 3 类(现有 ${roundBullets.length} 条)`).toEqual({ bullets: true, topicsCovered: true });

  for (const [v, olds] of Object.entries(OLD)) {
    for (const [label, text] of [['CHANGELOG', section(v)], ['应用内更新说明', releaseItems(v).join('\n')], ['README 更新记录', readmeBlock(v)]]) {
      expect.soft(text.length > 0, `${label} 里应有 ${v} 这一节`).toBe(true);
      for (const old of olds) expect.soft(text.includes(old), `${label} 的 ${v} 不应再写"${old}"`).toBe(false);
    }
  }

  let index = []; try { index = JSON.parse(read('client', 'src', 'generated', 'release-notes', 'index.json')); } catch { index = []; }
  expect.soft(index[0] && index[0].version, '应用内更新说明的索引第一项应是 CHANGELOG 最上面一节').toBe(top.version);
  const items = releaseItems(top.version);
  expect.soft(items.length, `release-notes/${top.version}.json 的条数应与 CHANGELOG 最上面一节的条数一致`).toBe(bullets.length);
  expect.soft(items.filter((it) => !norm(top.body).includes(norm(it))), '应用内更新说明的每一条都应出自 CHANGELOG 最上面一节').toEqual([]);
  const rb = norm(readmeBlock(top.version));
  const missing = items.filter((it) => { const m = it.match(/^\*\*(.+?)\*\*[:：]?([\s\S]*)$/); const [t, b] = m ? [m[1], m[2]] : [it, '']; return !(rb.includes(norm(t)) && rb.includes(norm(b))); });
  expect.soft(rb.length > 0 && missing.length === 0, `README 更新记录里应有 v${top.version} 的每一条(缺:${JSON.stringify(missing).slice(0, 400)})`).toBe(true);
});
