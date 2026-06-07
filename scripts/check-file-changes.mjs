#!/usr/bin/env node

import assert from 'node:assert/strict';
import { extractFileChanges } from '../server/routes/file-changes.js';

const records = [
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-06-07T00:00:00.000Z',
    message: {
      model: 'claude-test',
      content: [
        {
          type: 'tool_use',
          id: 'tool-edit',
          name: 'Edit',
          input: { file_path: '/tmp/a.txt', old_string: 'old', new_string: 'new' },
        },
        {
          type: 'tool_use',
          id: 'tool-multi',
          name: 'MultiEdit',
          input: {
            file_path: '/tmp/b.txt',
            edits: [
              { old_string: 'one', new_string: 'two' },
              { old_string: 'three', new_string: 'four' },
            ],
          },
        },
        {
          type: 'tool_use',
          id: 'tool-write',
          name: 'Write',
          input: { file_path: '/tmp/c.txt', content: 'line 1\nline 2' },
        },
      ],
    },
  },
];

const changes = extractFileChanges(records);

assert.equal(changes.length, 4);
assert.deepEqual(changes.map((change) => change.toolUseId), [
  'tool-edit',
  'tool-multi',
  'tool-multi',
  'tool-write',
]);
assert.deepEqual(changes.map((change) => change.file), [
  '/tmp/a.txt',
  '/tmp/b.txt',
  '/tmp/b.txt',
  '/tmp/c.txt',
]);
assert.equal(changes[1].editIndex, 0);
assert.equal(changes[2].editIndex, 1);
assert.equal(changes[0].additions, 1);
assert.equal(changes[0].deletions, 1);
assert.equal(changes[3].additions, 2);
assert.equal(changes[3].deletions, 0);
assert.match(changes[0].diff, /--- a\/tmp\/a\.txt/);
assert.match(changes[1].diff, /\+two/);
assert.match(changes[2].diff, /-three/);

console.log('[file-changes] ok');
