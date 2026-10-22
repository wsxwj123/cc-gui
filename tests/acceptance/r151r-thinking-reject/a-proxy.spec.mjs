// A. OpenAI 协议代理流式输出里的"纯空白思考"(行为 R01–R06)。每条用例一个子进程(proxy/case.mjs):
// HOME 指向临时目录,进程内只调 openai-proxy 的公开入口,上游是子进程里的假服务(按 OpenAI 流式格式逐块吐 reasoning_content / content / tool_calls)。
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../r151b-xsession-p1/helpers/fixtures.mjs';

const CASE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxy', 'case.mjs');
test.describe.configure({ timeout: 90_000 });

function runCase(id) {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const home = fs.mkdtempSync(path.join(dataRoot(), 'proxyhome-'));
  const r = spawnSync(process.execPath, [CASE, String(id)], {
    cwd: home, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'en_US.UTF-8', TMPDIR: home },
  });
  const line = String(r.stdout).split('\n').find((l) => l.startsWith('R151R_RESULT '));
  if (!line) throw new Error(`子进程没给出结果:退出码 ${r.status} 信号 ${r.signal}\n${String(r.stdout).slice(-1200)}\n${String(r.stderr).slice(-1200)}`);
  return JSON.parse(line.slice('R151R_RESULT '.length));
}

/** 把代理吐出的 Anthropic 事件流还原成内容块列表:按 content_block_start 的先后,累加各块的 delta。 */
function blocksOf(events) {
  const byIndex = new Map();
  const list = [];
  for (const ev of events || []) {
    const d = ev.data;
    if (!d || typeof d !== 'object') continue;
    if (d.type === 'content_block_start') {
      const cb = d.content_block || {};
      const b = { index: d.index, type: cb.type, name: cb.name, startInput: cb.input, text: '', thinking: '', json: '' };
      byIndex.set(d.index, b);
      list.push(b);
    } else if (d.type === 'content_block_delta') {
      const b = byIndex.get(d.index);
      const dl = d.delta || {};
      if (!b) continue;
      if (dl.type === 'text_delta') b.text += dl.text;
      else if (dl.type === 'thinking_delta') b.thinking += dl.thinking;
      else if (dl.type === 'input_json_delta') b.json += dl.partial_json;
    }
  }
  return list;
}
const shape = (blocks) => blocks.map((b) => ({ index: b.index, type: b.type }));
const hasThinking = (blocks) => blocks.some((b) => b.type === 'thinking');

/** 跑一条流式用例并做公共前置断言(代理 200、上游确实被以流式调用过),返回内容块列表与原始事件。 */
function runStream(id) {
  const res = runCase(id);
  expect(res.status, `代理应返回 200:${res.rawHead}`).toBe(200);
  expect(res.upstreamCalls.some((c) => c.stream), `代理应以流式调用上游:${JSON.stringify(res.upstreamCalls)}`).toBe(true);
  expect(Array.isArray(res.events) && res.events.length > 0, `应有事件流输出:${res.rawHead}`).toBe(true);
  return { blocks: blocksOf(res.events), events: res.events };
}

test('R01 上游思考片段依次为 "\\n"、"\\n",随后正文「你好」 → 输出没有 thinking 块;序号 0 是 text 块「你好」', async () => {
  const { blocks } = runStream(1);
  expect(hasThinking(blocks), '纯空白思考不应输出 thinking 块').toBe(false);
  expect(shape(blocks)).toEqual([{ index: 0, type: 'text' }]);
  expect(blocks[0].text).toBe('你好');
});

test('R02 (相邻) 思考片段 "\\n"、"想"、"一下",正文「好」 → 恰好一个 thinking 块(序号 0)="\\n想一下",序号 1 是 text 块「好」', async () => {
  const { blocks } = runStream(2);
  expect(shape(blocks)).toEqual([{ index: 0, type: 'thinking' }, { index: 1, type: 'text' }]);
  expect(blocks[0].thinking).toBe('\n想一下');
  expect(blocks[1].text).toBe('好');
});

test('R03 思考片段只有两个空格,随后工具调用 get_weather({"city":"北京"})、无正文 → 没有 thinking 块;序号 0 是 tool_use,名字与参数和上游一致', async () => {
  const { blocks } = runStream(3);
  expect(hasThinking(blocks), '纯空白思考不应输出 thinking 块').toBe(false);
  expect(shape(blocks)).toEqual([{ index: 0, type: 'tool_use' }]);
  expect(blocks[0].name).toBe('get_weather');
  const args = blocks[0].json !== '' ? JSON.parse(blocks[0].json) : blocks[0].startInput;
  expect(args).toEqual({ city: '北京' });
});

test('R04 思考片段只有 "\\n\\t ",随后流结束(无正文、无工具调用) → 没有 thinking 块;流照常以 message_stop 结束', async () => {
  const { blocks, events } = runStream(4);
  expect(hasThinking(blocks), '纯空白思考不应输出 thinking 块').toBe(false);
  expect(events[0].event, '流应以 message_start 开头').toBe('message_start');
  expect(events[events.length - 1].event, '流应以 message_stop 结束').toBe('message_stop');
});

test('R05 (相邻) 思考「abc」+ 正文「x」 → thinking 块「abc」(序号 0) + text 块「x」(序号 1)', async () => {
  const { blocks } = runStream(5);
  expect(shape(blocks)).toEqual([{ index: 0, type: 'thinking' }, { index: 1, type: 'text' }]);
  expect(blocks[0].thinking).toBe('abc');
  expect(blocks[1].text).toBe('x');
});

test('R06 (相邻) 非流式请求,上游 reasoning_content="\\n\\n"、content="ok" → 返回的 content 里没有 thinking 块,有 text「ok」', async () => {
  const res = runCase(6);
  expect(res.status, `代理应返回 200:${res.rawHead}`).toBe(200);
  expect(res.upstreamCalls.some((c) => !c.stream), `代理应以非流式调用上游:${JSON.stringify(res.upstreamCalls)}`).toBe(true);
  const content = res.json && res.json.content;
  expect(Array.isArray(content), `返回体应带 content 数组:${res.rawHead}`).toBe(true);
  expect(content.some((b) => b.type === 'thinking'), '纯空白思考不应输出 thinking 块').toBe(false);
  const text = content.find((b) => b.type === 'text');
  expect(text && text.text).toBe('ok');
});
