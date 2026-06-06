#!/usr/bin/env node

import assert from 'node:assert/strict';
import { trimJsonlBeforeTool } from '../server/routes/sessions.js';

const records = [
  {
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-06-07T00:00:00.000Z',
    message: { content: [{ type: 'text', text: 'do work' }] },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-06-07T00:00:01.000Z',
    message: {
      content: [
        { type: 'text', text: 'first text' },
        { type: 'tool_use', id: 'tool-a', name: 'Read', input: { file_path: 'a.txt' } },
        { type: 'text', text: 'after first tool' },
        { type: 'tool_use', id: 'tool-b', name: 'Bash', input: { command: 'echo b' } },
        { type: 'text', text: 'after target' },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-06-07T00:00:02.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-b', content: 'old result' }] },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-06-07T00:00:03.000Z',
    message: { content: [{ type: 'text', text: 'final answer' }] },
  },
];

const raw = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const result = trimJsonlBeforeTool(raw, 'tool-b');

assert.equal(result.found, true);
assert.equal(result.removedFromLine, 1);
assert.equal(result.keptAssistantBlocks, 3);

const kept = result.keptLines.filter((line) => line.trim()).map((line) => JSON.parse(line));
assert.equal(kept.length, 2);
assert.equal(kept[0].uuid, 'u1');
assert.equal(kept[1].uuid, 'a1');
assert.deepEqual(kept[1].message.content.map((block) => block.type === 'tool_use' ? block.id : block.text), [
  'first text',
  'tool-a',
  'after first tool',
]);

assert.equal(JSON.stringify(kept).includes('tool-b'), false);
assert.equal(JSON.stringify(kept).includes('old result'), false);
assert.equal(JSON.stringify(kept).includes('final answer'), false);

const missing = trimJsonlBeforeTool(raw, 'tool-missing');
assert.equal(missing.found, false);

console.log('[session-trim] ok');
