#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldPauseAutoScroll } from '../../client/src/utils/scroll.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const input = readFileSync(join(root, 'client/src/components/ChatInput.jsx'), 'utf8');
const scrubber = readFileSync(join(root, 'client/src/components/TurnScrubber.jsx'), 'utf8');
const subagent = readFileSync(join(root, 'client/src/components/SubagentView.jsx'), 'utf8');

assert.equal(shouldPauseAutoScroll({ previousTop: 900, currentTop: 850 }), true,
  '用户一开始向上滚就应暂停自动跟底，不能等离底 200px 才锁');
assert.equal(shouldPauseAutoScroll({ previousTop: 850, currentTop: 900 }), false,
  '向下滚动不应误判成离底意图');

assert.match(input, /mergeIntoCurrentTurn = isStreaming && \(e\.metaKey \|\| e\.ctrlKey\)/,
  '流式时 Cmd/Ctrl+Enter 必须显式路由到并入语义');
assert.match(input, /handleSend\(\{ steer: mergeIntoCurrentTurn \}\)/,
  '输入框必须把并入意图传给会话发送态机');
assert.match(app, /opts\.steer[\s\S]{0,1600}steerCurrentTurnRef\.current/,
  '发送态机必须调用 CLI/SDK 输入队列的无打断并入路径');

const contextButton = app.slice(app.indexOf('function ContextBreakdownButton'), app.indexOf('function LoginScreen'));
assert.doesNotMatch(contextButton, /else load\(\);/,
  '点徽章只能秒开本地/缓存数据，不能自动启动昂贵的 /context');
assert.match(contextButton, /本地统计/,
  '没有精确缓存时必须立即显示本地上下文统计');

assert.match(scrubber, /data-turn-wave/,
  '回合标记必须是线性波形，不再使用圆点');
assert.match(subagent, /data-subagent-scroll/,
  '子代理会话必须提供独立滚动容器与回底入口');
assert.match(app, /min-w-0 overflow-hidden[\s\S]{0,300}min-w-0 break-words[^>]*>正在创建基线提交/,
  '侧栏基线提示文本必须允许收缩和断行，不能越出面板');
const gitBanner = app.slice(app.indexOf('function GitInitBanner'), app.indexOf('function CompactDivider'));
assert.match(gitBanner, />本文件夹未git初始化<\//, '未初始化横幅正文必须逐字匹配');
assert.match(gitBanner, /flex flex-col gap-2[\s\S]*本文件夹未git初始化[\s\S]*flex flex-wrap gap-1\.5[\s\S]*立即初始化[\s\S]*本会话忽略/,
  '未初始化横幅必须正文在上、动作在下并允许按钮换行');

console.log('✓ check-session-interaction-fixes: 五项交互回归守卫全过');
