#!/usr/bin/env node
// r22-②:~/.claude-gui 下【存明文凭据的配置文件】必须全部在 files.js 的
// PROTECTED_WRITE_RELPATHS 里 —— 该集合同时门禁通用文件端点的读(:173)/写(:273)/
// 删改名(:308/:314)。漏一个 = 任何已认证客户端(公开版默认监听 0.0.0.0,手机端也算)
// 一条 GET /api/files/read?path=$HOME/.claude-gui/xxx.json 就把明文密钥读走,
// 再一条 PUT 把 baseURL 改到攻击者服务器,下次调用带着密钥打过去。
//
// 判据不写成硬编码清单的复读(那还是会漏下一个):扫 server/ 全部源码里
// `join(homedir(), '.claude-gui', '<name>.json')` 形态的路径字面量,若其附近出现
// apiKey / authToken / passwordHash / tokenSecret 字样,就必须在名单里。
// 新增一个存密钥的配置文件时,这条会自动变红。
//
// 本测试只读源码,绝不读取真实 ~/.claude-gui 下任何文件的内容。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// ── 名单本体(从源码解析,不 import 路由:files.js 顶层会建 Router)────────────
const filesSrc = readFileSync(join(ROOT, 'server/routes/files.js'), 'utf8');
const setBody = filesSrc.slice(
  filesSrc.indexOf('const PROTECTED_WRITE_RELPATHS'),
  filesSrc.indexOf(']);', filesSrc.indexOf('const PROTECTED_WRITE_RELPATHS')),
);
ok(setBody.length > 50, '解析得到 PROTECTED_WRITE_RELPATHS 的定义体');
const listed = new Set([...setBody.matchAll(/join\('([^']+)',\s*'([^']+)'\)/g)].map((m) => `${m[1]}/${m[2]}`));

// 四个消费点都还在用它(名单本身没被架空)
for (const anchor of [
  /PROTECTED_WRITE_RELPATHS\.has\(relative\(HOME, real\)\)/,
  /PROTECTED_WRITE_RELPATHS\.has\(relative\(HOME, orig\)\)/,
]) ok(anchor.test(filesSrc), `名单仍被消费:${anchor}`);
ok((filesSrc.match(/PROTECTED_WRITE_RELPATHS\.has\(/g) || []).length >= 4,
  '读/写/删/改名四处都要门禁(少一处就有一条绕行路径)');

// ── 扫 server/ 全部 .js,找出"附近提到密钥"的 .claude-gui 配置文件 ─────────────
const SECRET = /apiKey|authToken|passwordHash|tokenSecret/;
const WINDOW = 800; // 路径常量与其读写函数/说明通常在同一屏内
// 已逐个核对过【不存任何凭据】的例外,加一条要写清理由 —— 这就是"新文件默认变红"的来源。
const KEYLESS = new Map([
  ['active-provider.json', '只存 { id }(最后切换的 provider id);命中是因为 12 行外就是 CUSTOM_PROVIDERS_PATH 的注释'],
]);

const jsFiles = [];
for (const dir of ['server', 'server/routes', 'server/services', 'server/utils']) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.js')) jsFiles.push(join(dir, e.name));
  }
}
ok(jsFiles.length > 20, `扫到足够多的服务端源码(${jsFiles.length} 个)`);

const suspects = new Map(); // name -> 出处
for (const rel of jsFiles) {
  if (rel === 'server/routes/files.js') continue; // 名单本体自带注释里就有 apiKey 字样
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const re = /['"]\.claude-gui['"]\s*,\s*['"]([\w.-]+\.json)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const seg = src.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW);
    if (SECRET.test(seg)) suspects.set(m[1], rel);
  }
}
ok(suspects.size >= 2, `至少认出已知的两个存密钥文件(实际 ${suspects.size} 个:${[...suspects.keys()].join(', ')})`);

for (const [name, from] of suspects) {
  if (KEYLESS.has(name)) continue;
  ok(listed.has(`.claude-gui/${name}`),
    `${name}(在 ${from} 里与密钥字段同屏)必须进 PROTECTED_WRITE_RELPATHS,`
    + `否则 GET /api/files/read 直接吐明文。现有名单:${[...listed].join(', ')}`);
}

// 两个已知的明文密钥文件必须在名单里(哨兵:上面的启发式若被改坏,这里仍兜住)
for (const must of ['.claude-gui/custom-providers.json', '.claude-gui/image-providers.json']) {
  ok(listed.has(must), `${must} 必须受保护(明文 apiKey)`);
}

console.log(`✓ check-protected-secret-files:${n} 条断言全过(r22-②)`);
