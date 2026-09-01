#!/usr/bin/env node
// r78:每个 provider 可设置独特头像。
// 三部分:①形态判定纯函数(真 import);②「存→下发→预填→保存」四处齐动链(源码锁);
// ③上传/抓取的三道校验(SSRF / 类型 / 大小,真 import 真调)。
//
// 四处齐动是本轮的头号地雷:漏掉任一处 = 用户"改个名字"就把头像静默清掉
// (contextWindow / modelPrices / modelMeta 在本仓栽过同一个坑)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAvatar, sanitizeAvatar, AVATAR_MARKS } from '../../server/utils/avatar.js';
import { resolveAssistantProvider, resolveAssistantName, mergeProviderLists } from '../../client/src/utils/providerList.js';
import { assertFetchableImageUrl, pickImageExt } from '../../server/routes/avatars.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
let n = 0;
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };
const ok = (v, m) => { n++; assert.ok(v, m); };

// ── ① 三形态 + 回落 ─────────────────────────────────────────────
eq(parseAvatar(''), null, '空 = 未设置');
eq(parseAvatar(null), null, 'null = 未设置');
eq(parseAvatar('   '), null, '纯空白 = 未设置');
eq(parseAvatar('🐋'), { kind: 'text', value: '🐋' }, 'emoji = text 形态');
eq(parseAvatar('  🐋 '), { kind: 'text', value: '🐋' }, '前后空白剪掉');
eq(parseAvatar('🧑‍🔬'), { kind: 'text', value: '🧑‍🔬' }, 'ZWJ 组合 emoji 整条留着(按码点截断会切出半个字素)');
eq(parseAvatar('DS'), { kind: 'text', value: 'DS' }, '短文字也是 text 形态');
eq(parseAvatar('deepseek'), { kind: 'mark', value: 'deepseek' }, '白名单内的名字 = 内置图标');
eq(parseAvatar('anthropic'), { kind: 'mark', value: 'anthropic' }, '同上');
eq(parseAvatar('notaprovider'), null, '不在白名单又超长的串 = 非法,不入库');
eq(parseAvatar('3f2a-9c.png'), { kind: 'file', value: '3f2a-9c.png' }, 'uuid.ext = 上传文件');
eq(parseAvatar('a.jpg').kind, 'file', 'jpg 认');
eq(parseAvatar('a.jpeg').kind, 'file', 'jpeg 认');
eq(parseAvatar('a.webp').kind, 'file', 'webp 认');
// 形态互斥 + 危险输入
ok(parseAvatar('a.svg')?.kind !== 'file', 'svg 永远不算文件形态(可内嵌脚本,头像不需要矢量)');
ok(parseAvatar('a.gif')?.kind !== 'file', 'gif 不在白名单');
eq(parseAvatar('../../../etc/passwd.png'), null, '带路径段的名字既不是文件形态也超长 → 拒');
eq(parseAvatar('sub/dir.png'), null, '带分隔符 → 拒');
eq(parseAvatar('https://evil.example/a.png'), null, '**URL 永远不入库**(热链=每条消息外呼+可被追踪+对方删图就裂)');
eq(parseAvatar('javascript:alert(1)'), null, '超长串一律拒');
eq(parseAvatar('<img onerror=x>'), null, '同上');
eq(sanitizeAvatar(' 🐋 '), '🐋', '入库值 = 剪过空白的原串');
eq(sanitizeAvatar('a.svg.png'), null, '多段扩展名不匹配文件正则(名字只含 [A-Za-z0-9-])');
eq(sanitizeAvatar('3f2a-9c.png'), '3f2a-9c.png', '服务端生成的文件名原样入库');
eq(sanitizeAvatar('这是一个很长的名字超过八个字'), null, '非法 → null = 不写/清除');
ok(AVATAR_MARKS.includes('anthropic') && AVATAR_MARKS.length >= 9, '内置图标白名单在单处定义');
{
  // 白名单必须与渲染端的 PROVIDER_AVATARS 键集合一致,否则选了图标却渲染不出来。
  const badge = read('client/src/components/ModelBadge.jsx');
  const keys = [...badge.matchAll(/^ {2}(\w+):\s*\{ gradient:/gm)].map((m) => m[1]);
  eq([...AVATAR_MARKS].sort(), [...keys].sort(), 'AVATAR_MARKS 与 PROVIDER_AVATARS 的键逐个对上');
}

// ── ② 名字与头像同源(r76 抽层不许改行为) ───────────────────────
const PROVIDERS = mergeProviderLists({
  providers: [
    { id: 'official', name: 'Anthropic 官方', category: 'official', models: [] },
    { id: 'ds', name: '我的 DeepSeek 中转', models: ['deepseek-chat'] },
  ],
  customProviders: [
    { id: 'kimi', name: 'Kimi 自建', models: ['kimi-k2-turbo', 'claude-opus-5'], baseURL: 'https://a.example', avatar: '🌙' },
    { id: 'glm', name: '智谱 GLM', models: ['glm-4.6'], baseURL: 'https://b.example', avatar: 'zhipu' },
  ],
});
for (const a of [
  { model: 'claude-opus-5', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true },
  { model: 'kimi-k2-turbo', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true },
  { model: 'glm-4.6', providers: PROVIDERS, activeName: 'X', activeOfficial: false },
  { model: 'unknown', providers: PROVIDERS, activeName: '智谱 GLM', activeOfficial: false },
  { model: '', providers: [], activeName: '', activeOfficial: false },
]) eq(resolveAssistantProvider(a).name, resolveAssistantName(a), '两个出口同一次判定(name 逐例相等)');

{
  const r = resolveAssistantProvider({ model: 'kimi-k2-turbo', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true });
  eq([r.official, r.name, r.row?.avatar], [false, 'Kimi 自建', '🌙'], '历史消息按自己的 model id 归属,头像取那一行的');
  const off = resolveAssistantProvider({ model: 'claude-opus-5', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true });
  eq([off.official, off.row], [true, null], '官方端点 → official,头像恒用 cc-gui 自有标识');
  // ③ 回落到"当前激活 provider"时也要给出那一行 —— 否则用户设了头像却只在部分消息上显示。
  const act = resolveAssistantProvider({ model: 'no-such-model', providers: PROVIDERS, activeName: '智谱 GLM', activeOfficial: false });
  eq([act.name, act.row?.avatar], ['智谱 GLM', 'zhipu'], '按显示名回找那一行,名字与头像同属一个 provider');
  const none = resolveAssistantProvider({ model: 'no-such-model', providers: PROVIDERS, activeName: '没配过的名字', activeOfficial: false });
  eq([none.name, none.row], ['没配过的名字', null], '对不上就 row=null,交给默认回落,不瞎认一行');
}

// ── ③ 四处齐动链:存 → 下发(两个口)→ 预填 → 保存 ──────────────
{
  const st = read('server/routes/settings.js');
  ok(/const av = acceptAvatar\(req\.body\?\.avatar\);\s*\n\s*if \(av\) entry\.avatar = av;/.test(st), '【存·POST】新增时写 avatar');
  ok(/if \(req\.body\?\.avatar !== undefined\) \{[\s\S]{0,400}?list\[idx\]\.avatar = av; else delete list\[idx\]\.avatar;/.test(st),
    '【存·PUT】显式传入才动:合法覆盖 / null 清除 / 不传保留');
  // 下发两个口各一处(编辑器读 /api/providers,其它消费者读 /api/custom-providers)。
  eq(st.match(/avatar: p\.avatar \|\| ''/g)?.length, 2, '【下发】GET /api/providers 与 GET /api/custom-providers 都下发 avatar');
  const iProviders = st.indexOf("router.get('/providers'");
  const iCustom = st.indexOf("router.get('/custom-providers'");
  const marks = [...st.matchAll(/avatar: p\.avatar \|\| ''/g)].map((m) => m.index);
  ok(marks.some((i) => i > iProviders && i < iCustom), 'GET /api/providers 那个投影里有(编辑器预填读的就是它)');
  ok(marks.some((i) => i > iCustom), 'GET /api/custom-providers 那个投影里也有');
  // 换头像/删 provider 清理旧文件,否则目录只涨不减。
  ok(/if \(prevAvatar && prevAvatar !== list\[idx\]\.avatar\) await deleteAvatarFile\(prevAvatar\)/.test(st), '换头像删旧文件');
  ok(/await deleteAvatarFile\(list\.find\(\(p\) => p\.id === req\.params\.id\)\?\.avatar\)/.test(st), '删 provider 清其头像文件');
  ok(/function acceptAvatar[\s\S]{0,400}?existsSync\(full\)/.test(st), 'file 形态必须核实文件真在库里(否则前端可塞任意名字)');
}
{
  const app = read('client/src/App.jsx');
  ok(/setAvatar\(editing\.avatar \|\| ''\)/.test(app), '【预填】编辑态从下发值回填');
  ok(/body\.avatar = avatar \|\| null;/.test(app), '【保存】回传(null = 清除,与 defaultModel 同语义)');
  ok(/const \[avatar, setAvatar\] = useState\(''\)/.test(app), '表单持有 avatar 状态');
  ok(/setAvatar\(''\);\s*setAvatarOpen\(false\)/.test(app), 'reset 清掉头像态,新增表单不带上一条的头像');
  // 四个消费点:气泡头像 + 三个列表。
  eq(app.match(/<ProviderMark row=\{p\}/g)?.length, 2, '桌面管理列表 + 手机 Provider 页各一处');
  const sel = read('client/src/components/SessionSelectors.jsx');
  ok(/<ProviderMark row=\{p\}/.test(sel), '顶栏切换卡片一处');
  const badge = read('client/src/components/ModelBadge.jsx');
  ok(/export function ProviderAvatar[\s\S]{0,400}?useAssistantProvider\(model\)[\s\S]{0,300}?<ProviderMark/.test(badge),
    '气泡头像走同一枚 ProviderMark(旧实现恒返回官方标,是本轮关键改点)');
  ok(/export function AssistantName[\s\S]{0,200}?useAssistantProvider\(model\)/.test(badge),
    '名字与头像共用 useAssistantProvider —— 同一次 resolveAssistantProvider 调用');
  eq(badge.match(/resolveAssistantProvider\(/g)?.length, 1, '客户端只有一个调用点,不许各解析一遍');
  ok(!/return PROVIDER_AVATARS\.anthropic;\s*\n\}\s*\n\s*\/\*\*\s*\n \* Circular avatar/.test(badge), '不再是"恒返回官方标"的旧实现');
}

// ── ④ 抓取/上传的三道校验 ──────────────────────────────────────
const rejects = async (url, why) => {
  n++;
  await assert.rejects(() => assertFetchableImageUrl(url), (e) => e.status === 400 || e.status === undefined, why);
};
await rejects('file:///etc/passwd', 'file: 拒(能读本机任意文件)');
await rejects('data:image/png;base64,AAAA', 'data: 拒');
await rejects('ftp://x.example/a.png', '非 http(s) 拒');
await rejects('http://127.0.0.1:6677/api/health', '本机回环拒(SSRF)');
await rejects('https://127.0.0.1:6677/x.png', 'https 回环同样拒');
await rejects('http://localhost:8080/x.png', 'localhost 拒');
await rejects('https://10.0.0.5/x.png', '10/8 拒');
await rejects('https://172.16.0.3/x.png', '172.16/12 拒');
await rejects('https://192.168.1.9/x.png', '192.168/16 拒');
await rejects('https://169.254.169.254/latest/meta-data', '链路本地(云元数据)拒');
await rejects('https://[::1]/x.png', 'IPv6 回环拒');
await rejects('不是地址', '非法地址拒');
{ n++; ok((await assertFetchableImageUrl('https://example.com/a.png')).protocol === 'https:', '公网 https 放行'); }
eq(pickImageExt('image/png'), 'png', 'png 认');
eq(pickImageExt('image/jpeg; charset=binary'), 'jpg', '带参数的 content-type 也认');
eq(pickImageExt('IMAGE/WEBP'), 'webp', '大小写不敏感');
eq(pickImageExt('image/svg+xml'), null, 'svg 拒(可内嵌脚本)');
eq(pickImageExt('text/html'), null, '非图片拒');
eq(pickImageExt(''), null, '未声明类型拒');
{
  const av = read('server/routes/avatars.js');
  ok(/MAX_BYTES = 1024 \* 1024/.test(av), '1MB 上限');
  ok(/if \(bytes > MAX_BYTES\) throw httpError\('图片超过 1MB 上限', 413\)/.test(av), 'content-length 可伪造 → 边读边数');
  ok(/allowLoopback: false/.test(av), 'SSRF 判定不放行回环');
  ok(/MAX_REDIRECTS = 2/.test(av) && /url = await assertFetchableImageUrl\(new URL\(loc, url\)\.href\)/.test(av),
    '重定向 ≤2 且**每一跳都重验**(跳进内网是经典绕过)');
  ok(/AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/.test(av) && /FETCH_TIMEOUT_MS = 10_000/.test(av), '10 秒超时');
  ok(!/svg/i.test(av.replace(/\/\/.*|不需要矢量/g, '')) || /不含 svg|不需要矢量/.test(av), 'svg 不在允许类型里');
  ok(/dotfiles: 'allow'/.test(av), '回源必须给 dotfiles:allow(.claude-gui 是点目录)');
  const st = read('server/routes/settings.js');
  ok(/isPathInside\(full, AVATAR_DIR\)/.test(st), '回源/删除防路径穿越');
}

// ── 变异哨兵(改坏实现必须红) ──────────────────────────────────
// 哨兵1:删掉 avatars.js 的 assertPublicBaseURL 调用(或把 allowLoopback 改回 true)
//        → 第 ④ 组的 127.0.0.1 / 10.x / 169.254 几条立刻绿变红(实测)。
// 哨兵2:GET /api/providers 或 GET /api/custom-providers 的投影里删掉 avatar
//        → 第 ③ 组"下发两个口"计数断言红(这正是"改名字清头像"的静默数据丢失)。
// 哨兵3:去掉 PUT 里的 deleteAvatarFile(prevAvatar) 或 DELETE 里的清理
//        → 第 ③ 组两条清理断言红(头像目录只涨不减)。
// 哨兵4:把 parseAvatar 的 [...v].length > 8 判据删掉
//        → 'https://evil.example/a.png' 会被当 text 存进库,第 ① 组那条红(URL 入库)。

console.log(`✓ check-provider-avatar: ${n} assertions passed`);
