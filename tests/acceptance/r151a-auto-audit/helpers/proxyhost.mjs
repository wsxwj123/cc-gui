#!/usr/bin/env node
// r151a:在测试端口单独起"被测工作树"里的 openai 协议代理(只调它对外导出的启动函数,不改它),上游指向本地假接口。
// 为什么不用 GUI 自己起的那一个:本机 127.0.0.1:8798 / 8799 上常驻着用户自己的代理守护进程,隔离实例切到
// 第三方 provider 时会指向它 —— 往那里发请求会打到用户真实的 provider。这里另起一份,端口在 6700–6999。
// 用法: HOME=<临时目录> node proxyhost.mjs <oaPort> <upstreamBaseURL> [<upstreamModel>]
// 就绪后打印一行 JSON:{ ready:true, port, pid }。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [oaPort, upstream, upstreamModel = 'r151-chat'] = process.argv.slice(2);
const port = Number(oaPort);
if (!(port >= 6700 && port <= 6999) || [6677, 6689, 6710].includes(port)) { console.error(`端口 ${oaPort} 不在允许范围`); process.exit(2); }
const realHome = os.userInfo().homedir;
if (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(realHome)) { console.error('拒绝:HOME 没有指到临时目录'); process.exit(2); }
const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const mod = await import(path.join(worktree, 'server', 'services', 'openai-proxy.js'));
mod.setOpenAIUpstream({ baseURL: upstream, apiKey: 'dummy-r151-upstream-key', model: upstreamModel });
const got = await mod.startOpenAIProxy(port);
console.log(JSON.stringify({ ready: true, port: got, pid: process.pid }));
