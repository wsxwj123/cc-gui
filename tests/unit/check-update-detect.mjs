// r14-1:其他电脑(Mac/Win)检测不到 GUI 更新的根因与修复。
// 根因二连:①版本检测用裸 fetch,而 Node 的 fetch(undici)不读系统代理 —— 墙内机器
// 直连 api.github.com 失败即恒"检测不到";本机因 Clash TUN 劫持全部流量恰好能通,
// 长期掩盖。②失败时若有旧缓存就静默复用,且前端渲染读的字段(state.error)与写入的
// 字段(message)不一致 → 失败原因从来没显示过。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// t1 GitHub 请求必须走带代理回落的 gfetch(直连失败/403 限流自动经本机代理重试)
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ gfetch \} from '\.\.\/utils\/github-fetch\.js'/, 't1: 引入共用代理回落层');
  assert.ok(!/await fetch\('https:\/\/api\.github\.com/.test(src), 't1: 不得再有裸 fetch 直连 GitHub(哨兵锚)');
  assert.match(src, /await gfetch\('https:\/\/api\.github\.com\/repos\/[^']+\/releases\/latest'/, 't1: releases/latest 走 gfetch');
  assert.match(src, /await gfetch\('https:\/\/api\.github\.com\/repos\/[^']+\/tags/, 't1: tags 兜底同样走 gfetch');
}

// t2 共用层保留原有语义:直连优先、网络失败回落代理、403 换代理重试
{
  const gh = readFileSync(new URL('../../server/utils/github-fetch.js', import.meta.url), 'utf8');
  assert.match(gh, /export async function gfetch/, 't2: 导出 gfetch');
  assert.match(gh, /try \{ r = await fetch\(url, opts\); \}/, 't2: 直连优先');
  assert.match(gh, /r\.status === 403/, 't2: 限流换代理链路');
  assert.match(gh, /CONNECT/, 't2: CONNECT 隧道(不设全局代理,不碰子进程环境)');
  // skills.js 不再各自持有一份实现
  const sk = readFileSync(new URL('../../server/routes/skills.js', import.meta.url), 'utf8');
  assert.ok(!/function proxyGet\(/.test(sk), 't2: skills 不再自带副本(单一实现)');
  assert.match(sk, /import \{ gfetch \} from '\.\.\/utils\/github-fetch\.js'/, 't2: skills 改用共用层');
}

// t3 失败原因必须可见(前端渲染字段与写入字段一致 + 旧缓存明示)
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  assert.match(src, /无法连接 GitHub/, 't3: 网络失败给人话原因');
  assert.match(src, /GitHub 接口限流/, 't3: 403 给人话原因');
  assert.match(src, /staleError/, 't3: 用旧缓存时带标记');
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /检查更新失败:\{state\.message \|\| state\.error/, 't3: 渲染读 message(原来只读 error 恒空)');
  assert.match(ui, /结果可能过期/, 't3: 旧缓存明示');
}

console.log('check-update-detect: all passed (r14-1)');

// t4(r14-2):没开代理 / 只开系统代理(非 TUN)的机器也要能检测。
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  // 系统代理读取:mac scutil、Windows 注册表(端口探测覆盖不到的场景)
  assert.match(src, /async function readSystemProxy\(\)/, 't4: 读系统代理设置');
  assert.match(src, /scutil/, 't4: macOS 走 scutil --proxy');
  assert.match(src, /HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Internet Settings/, 't4: Windows 读注册表');
  assert.match(src, /const sys = await readSystemProxy\(\)/, 't4: detectLocalProxy 先读系统设置(哨兵锚)');
  // 免代理兜底源:GitHub 全挂时仍能问出"有没有新版"
  assert.match(src, /async function fetchJsdelivrLatest\(\)/, 't4: 备用版本源');
  assert.match(src, /data\.jsdelivr\.com\/v1\/packages\/gh\//, 't4: jsDelivr 元数据接口(墙内免代理可达)');
  assert.match(src, /snap = await fetchJsdelivrLatest\(\);/, 't4: GitHub 全败后接管');
  assert.match(src, /无法连接 GitHub 与备用源/, 't4: 两条路都断才报错,文案说清');
}
