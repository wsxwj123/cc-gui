// O22 开发配置形态护栏(普通 node 单测写法,不起服务)。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { worktree } from './helpers/world.mjs';

test('O22 client/vite.config.js 的代理形态:/api 是字符串目标,/ws 是 ws:true 且不改写 Host 的对象', async () => {
  const mod = await import(pathToFileURL(path.join(worktree, 'client', 'vite.config.js')).href);
  let cfg = mod.default;
  if (typeof cfg === 'function') cfg = await cfg({ command: 'serve', mode: 'development' });
  const proxy = cfg?.server?.proxy ?? {};
  const why = '这条护栏保护的是"Vite 对 HTTP 代理改写 Host、对 WS 代理不改写 Host"这一形态;后端的来源校验(开发代理形态放行)依赖它。改这份配置前,必须先重新评估后端的来源校验。';
  expect.soft(typeof proxy['/api'], `server.proxy['/api'] 应是字符串目标(Vite 对字符串目标会改写 Host),实际类型 ${typeof proxy['/api']}。${why}`).toBe('string');
  const ws = proxy['/ws'];
  expect.soft(typeof ws === 'object' && ws !== null, `server.proxy['/ws'] 应是对象,实际 ${ws === null ? 'null' : typeof ws}。${why}`).toBe(true);
  expect.soft(ws?.ws, `server.proxy['/ws'].ws 应为 true,实际 ${JSON.stringify(ws?.ws)}。${why}`).toBe(true);
  expect.soft(ws?.changeOrigin === true, `server.proxy['/ws'].changeOrigin 不应为 true(否则 WS 的 Host 也被改写),实际 ${JSON.stringify(ws?.changeOrigin)}。${why}`).toBe(false);
});
