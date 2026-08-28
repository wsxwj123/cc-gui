#!/usr/bin/env node
// r64-genui【安全 / 反向断言】§5.5 加载来源:引擎必须来自 CC-GUI 自己的服务,不得走 CDN。
// 场景:echarts / mermaid / three 加起来 5MB,最省事的做法就是挂个 CDN。但公开版用户不该
// 因为看一张图表就把自己的 IP 和"我正在看什么"送给第三方。这条是构建产物的静态回归闸。
// 前置:需要先构建过前端(client/dist 存在)。没构建过时本文件会明确报"缺少交付物"。
// Run: node tests/acceptance/r64-genui/t10-no-cdn.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, t, done } from './lib.mjs';

const DIST = path.join(ROOT, 'client/dist');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(DIST);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.webmanifest']);
const textFiles = files.filter((f) => TEXT_EXT.has(path.extname(f)));
const rel = (f) => path.relative(ROOT, f);

await t('前置:构建产物存在且含 JS 资源(否则本组扫描没有意义)', () => {
  assert.ok(fs.existsSync(DIST), '缺少交付物:构建产物 client/dist —— 先跑一次前端构建再跑本文件');
  assert.ok(textFiles.filter((f) => f.endsWith('.js')).length > 0, 'client/dist 里没有任何 .js,扫描会空过');
});

const CDN_HOSTS = ['unpkg.com', 'jsdelivr.net', 'cdnjs.cloudflare.com', 'esm.sh',
  'cdn.skypack.dev', 'bootcdn.net', 'staticfile.org', 'cdn.jsdelivr', 'ajax.googleapis.com'];
for (const host of CDN_HOSTS) {
  await t('构建产物里不出现 CDN 域名:' + host, () => {
    const hits = [];
    for (const f of textFiles) {
      const s = fs.readFileSync(f, 'utf8');
      if (s.includes(host)) hits.push(rel(f));
    }
    assert.deepEqual(hits, [], '命中文件:' + hits.join(', ') + '(引擎必须打包进本地产物)');
  });
}

await t('构建产物里没有指向 http(s) 的动态 import', () => {
  const re = /import\s*\(\s*["'`]https?:\/\//;
  const hits = textFiles.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(hits, [], '出现了远程动态 import:' + hits.join(', '));
});

await t('构建产物里没有 from "http(s)://…" 的静态 import', () => {
  const re = /from\s*["'`]https?:\/\//;
  const hits = textFiles.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(hits, [], '出现了远程静态 import:' + hits.join(', '));
});

await t('CSS 里没有远程 url() / @import(字体与图片一律本地)', () => {
  const re = /(@import[^;]*|url\(\s*["']?)https?:\/\//;
  const hits = files.filter((f) => f.endsWith('.css')).filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(hits, [], 'CSS 里出现远程资源:' + hits.join(', '));
});

await t('index.html 的外部主机只允许既有的 Google Fonts 两个域(新增任何外链都要红)', () => {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const hosts = [...html.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => m[1]);
  // www.w3.org 是 SVG 的 xmlns 命名空间字面量,不发起任何网络请求。
  const allow = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'www.w3.org']);
  const extra = [...new Set(hosts)].filter((h) => !allow.has(h));
  assert.deepEqual(extra, [], 'index.html 新增了外部主机:' + extra.join(', ')
    + '(Google Fonts 是本轮之前就有的既有行为,不在本轮范围;其余一律不允许)');
});

await t('Service Worker / manifest 里也不出现 CDN 域名', () => {
  const sw = files.filter((f) => /(sw|service-worker)\.js$|\.webmanifest$/.test(path.basename(f)));
  const hits = [];
  for (const f of sw) {
    const s = fs.readFileSync(f, 'utf8');
    for (const h of CDN_HOSTS) if (s.includes(h)) hits.push(rel(f) + ' → ' + h);
  }
  assert.deepEqual(hits, [], hits.join(', '));
});

done('t10 引擎加载来源');
