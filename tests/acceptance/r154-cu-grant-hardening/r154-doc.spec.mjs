// D1:docs/computer-use.md 的内容断言(文档是对外公开面;不涉及任何进程)。
// 断言用布尔值而不是直接断言整份文档:失败时输出只有一行说明,不会把整篇文档打进报告。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { worktree } from './helpers/world.mjs';

test('D1 docs/computer-use.md:旧"尚无授权面板/只能走接口"两句已删,新增"禁止操控"一节,不泄露凭证机制的字面量', async () => {
  const doc = fs.readFileSync(path.join(worktree, 'docs', 'computer-use.md'), 'utf8');
  const has = (s) => doc.includes(s);
  expect.soft(has('图形界面尚未提供授权面板'), '不应再出现"图形界面尚未提供授权面板"').toBe(false);
  expect.soft(has('当前只能走接口'), '不应再出现"当前只能走接口"').toBe(false);
  expect.soft(has('禁止操控'), '应新增含"禁止操控"的一节').toBe(true);
  expect.soft(has('X-CGUI-Grant-Token'), '不应出现请求头名 X-CGUI-Grant-Token').toBe(false);
  expect.soft(has('cu:grant-token'), '不应出现 WebSocket 帧类型 cu:grant-token').toBe(false);
});
