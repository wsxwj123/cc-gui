import { test, expect } from '@playwright/test';
import {
  closeTerminal,
  createTerminal,
  disposeTerminal,
  getRuntime,
  openSocket,
  runShellCalculation,
  terminalStatus,
  uniqueId,
} from './helpers/runtime.mjs';

// 顺序无关约定（本文件所有用例）：每个创建终端的用例都在 finally 里用 disposeTerminal
// 结束自己开的 shell（合同路径：token 接管 + term-close）。需要先断言"分离后仍存活/上限仍保持"
// 的用例（FB-T02、FB-T04）先断言、后清理。任意顺序跑完，`GET /api/terminal/status` 的 active
// 必须回到跑前的值（干净实例上为 0）。

test('FB-T01 R01 reproduction: detach and reconnect preserve the same live PTY and output', async () => {
  const { baseURL } = getRuntime();
  const first = await openSocket(baseURL);
  const id = uniqueId('detach');
  let opened;
  let resumedClient;
  try {
    opened = await createTerminal(first, id);
    await runShellCalculation(first, opened, '13 * 17', 221);
    first.send({ type: 'term-detach', id, generation: opened.generation });
    await first.next(m => m.type === 'term-detached' && m.id === id && m.reason === 'detached');

    resumedClient = await openSocket(baseURL);
    resumedClient.send({
      type: 'term-open', id, generation: opened.generation, resumeToken: opened.resumeToken,
    });
    const resumed = await resumedClient.next(m => m.type === 'term-opened' && m.id === id);
    expect(resumed.generation).toBe(opened.generation);
    expect(resumed.pid).toBe(opened.pid);
    await runShellCalculation(resumedClient, resumed, '29 * 31', 899);
  } finally {
    // 此刻终端附在 resumedClient 上；中途失败时可能还附在 first 上或已分离，两个连接都交给清理去试
    await disposeTerminal(baseURL, opened, resumedClient, first);
    resumedClient?.close();
    first.close();
  }
});

test('FB-T02 R01 adjacent regression: repeated detach is harmless and active includes detached shells', async ({ request }) => {
  const { baseURL } = getRuntime();
  const client = await openSocket(baseURL);
  const id = uniqueId('idem_detach');
  let opened;
  try {
    opened = await createTerminal(client, id);
    client.send({ type: 'term-detach', id, generation: opened.generation });
    await client.next(m => m.type === 'term-detached' && m.id === id);
    client.send({ type: 'term-detach', id, generation: opened.generation });
    const status = await terminalStatus(request, baseURL);
    expect(status.maxTerminals).toBe(4);
    expect(status.active).toBeGreaterThanOrEqual(1);
  } finally {
    // 先断言"分离的 shell 仍计入 active"，再清理自己这一个（已分离：由新连接接管后关闭）
    await disposeTerminal(baseURL, opened, client);
    client.close();
  }
});

test('FB-T03 R02 reproduction: two browser-page sockets execute independently and closing one leaves the other interactive', async () => {
  const { baseURL } = getRuntime();
  const a = await openSocket(baseURL);
  const b = await openSocket(baseURL);
  let terminalA;
  let terminalB;
  try {
    terminalA = await createTerminal(a, uniqueId('page_a'));
    terminalB = await createTerminal(b, uniqueId('page_b'));
    expect(terminalA.id).not.toBe(terminalB.id);
    expect(terminalA.pid).not.toBe(terminalB.pid);
    await Promise.all([
      runShellCalculation(a, terminalA, '17 * 19', 323),
      runShellCalculation(b, terminalB, '19 * 23', 437),
    ]);
    await closeTerminal(a, terminalA);
    await runShellCalculation(b, terminalB, '23 * 29', 667);
  } finally {
    await disposeTerminal(baseURL, terminalA, a);
    await disposeTerminal(baseURL, terminalB, b);
    a.close();
    b.close();
  }
});

test('FB-T04 R02 adjacent regression: fifth live terminal is rejected without disturbing the first four', async ({ request }) => {
  const { baseURL } = getRuntime();
  const clients = [];
  const mine = [];
  try {
    // 顺序无关：先看既有水位（其他用例留下的存活 shell 也占名额），补满到上限再测"第五个被拒"。
    const before = await terminalStatus(request, baseURL);
    expect(before.maxTerminals).toBe(4);
    expect(before.active).toBeLessThanOrEqual(before.maxTerminals);
    const fill = before.maxTerminals - before.active;

    for (let index = 0; index < fill; index += 1) {
      const client = await openSocket(baseURL);
      clients.push(client);
      mine.push({ client, opened: await createTerminal(client, uniqueId(`limit_fill_${index}`)) });
    }

    const rejected = await openSocket(baseURL);
    clients.push(rejected);
    const fifthId = uniqueId('limit_fifth');
    rejected.send({ type: 'term-open', id: fifthId, cols: 80, rows: 24 });
    const error = await rejected.next(m => m.type === 'term-error' && m.id === fifthId);
    expect(error.code).toBe('TERM_LIMIT');
    expect(rejected.messages.filter(m => m.type === 'term-opened' && m.id === fifthId)).toHaveLength(0);

    // 前四个（含跑前既已存活的）不受扰：拒绝不结束任何已存活 shell
    const afterReject = await terminalStatus(request, baseURL);
    expect(afterReject.active).toBe(before.maxTerminals);
    // 本轮自己开的那些在拒绝之后仍可交互
    await Promise.all(mine.map(({ client, opened }, index) =>
      runShellCalculation(client, opened, `${index + 31} * 2`, (index + 31) * 2),
    ));
  } finally {
    for (const { client, opened } of mine) await disposeTerminal(baseURL, opened, client);
    clients.forEach(client => client.close());
  }
});

test('FB-T05 R03 reproduction: natural exit can restart as a new interactive generation', async () => {
  const { baseURL } = getRuntime();
  const client = await openSocket(baseURL);
  const id = uniqueId('restart');
  let opened;
  let restarted;
  try {
    opened = await createTerminal(client, id);
    client.send({ type: 'term-in', id, generation: opened.generation, data: 'exit 7\n' });
    const exited = await client.next(m => m.type === 'term-exit' && m.id === id);
    expect(exited.generation).toBe(opened.generation);
    expect(exited.exitCode).toBe(7);

    client.send({ type: 'term-restart', id, generation: opened.generation });
    restarted = await client.next(m => m.type === 'term-opened' && m.id === id && m.generation !== opened.generation);
    expect(restarted.pid).not.toBe(opened.pid);
    await runShellCalculation(client, restarted, '31 * 37', 1147);
  } finally {
    // opened 那一代多已自然退出（接管会被拒）；若用例中途失败则它仍是存活的，两种都清
    await disposeTerminal(baseURL, opened, client);
    await disposeTerminal(baseURL, restarted, client);
    client.close();
  }
});

test('FB-T06 R03 adjacent contract: an exited generation token cannot revive that process', async () => {
  const { baseURL } = getRuntime();
  const owner = await openSocket(baseURL);
  const other = await openSocket(baseURL);
  const id = uniqueId('stale');
  let opened;
  try {
    opened = await createTerminal(owner, id);
    owner.send({ type: 'term-in', id, generation: opened.generation, data: 'exit 9\n' });
    await owner.next(m => m.type === 'term-exit' && m.id === id);
    other.send({ type: 'term-open', id, generation: opened.generation, resumeToken: opened.resumeToken });
    const error = await other.next(m => m.type === 'term-error' && m.id === id);
    expect(['TERM_TOKEN_REVOKED', 'TERM_STALE', 'TERM_EXITED']).toContain(error.code);
  } finally {
    await disposeTerminal(baseURL, opened, owner);
    owner.close();
    other.close();
  }
});

test('FB-T07 R01/R02 contract: concurrent resume grants one attachment and does not kill the PTY', async () => {
  const { baseURL } = getRuntime();
  const owner = await openSocket(baseURL);
  const id = uniqueId('takeover');
  let opened;
  const contenders = [];
  try {
    opened = await createTerminal(owner, id);
    owner.send({ type: 'term-detach', id, generation: opened.generation });
    await owner.next(m => m.type === 'term-detached' && m.id === id);
    contenders.push(await openSocket(baseURL), await openSocket(baseURL));
    for (const contender of contenders) {
      contender.send({ type: 'term-open', id, generation: opened.generation, resumeToken: opened.resumeToken });
    }
    const outcomes = await Promise.all(contenders.map(client => client.next(m => m.id === id)));
    expect(outcomes.filter(item => item.type === 'term-opened')).toHaveLength(1);
    expect(outcomes.filter(item => item.code === 'TERM_ATTACH_CONFLICT')).toHaveLength(1);
    const winnerIndex = outcomes.findIndex(item => item.type === 'term-opened');
    await runShellCalculation(contenders[winnerIndex], outcomes[winnerIndex], '37 * 41', 1517);
    await closeTerminal(contenders[winnerIndex], outcomes[winnerIndex]);
  } finally {
    // 赢家连接可能已关掉该终端；中途失败时它仍附着在赢家上——两个竞争连接与 owner 都交给清理去试
    await disposeTerminal(baseURL, opened, ...contenders, owner);
    contenders.forEach(client => client.close());
    owner.close();
  }
});

test('FB-T08 R01/R03 contract: malformed terminal frames fail without executing a shell action', async ({ request }) => {
  const { baseURL } = getRuntime();
  const before = await terminalStatus(request, baseURL);
  const client = await openSocket(baseURL);
  try {
    client.socket.send('{broken-json');
    const malformed = await client.next(m => m.type === 'term-error' && m.code === 'TERM_INVALID_MESSAGE');
    expect(malformed.id).toBeNull();
    client.send({ type: 'term-unknown', id: uniqueId('unknown') });
    await client.next(m => m.type === 'term-error' && m.code === 'TERM_INVALID_MESSAGE');
    const after = await terminalStatus(request, baseURL);
    expect(after.active).toBe(before.active);
  } finally {
    client.close();
  }
});
