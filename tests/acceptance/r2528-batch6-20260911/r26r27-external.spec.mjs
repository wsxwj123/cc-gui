// R26 / R27 —— 仓库外部工程的边界（本套件只能以"守卫 + 只读/白名单命令"方式覆盖）
//
// 合同来源：.devflow/INTERFACE.md R26/R27 两段。
//   R26：外部 worker 入口仍接受现有 bot/chat/uuid/dispatcher_url；同一目标不得重复启动；
//        历史清理/压缩须保留可恢复原始记录、失败不覆盖、不以 token 轮换为触发；不重启运行中的 worker。
//   R27：HDSI/Brain 当前不回放 Claude 签名的请求路径、DeepSeek 选路与关闭用途保持；
//        GET /health 与既有 POST /v1/chat/completions 行为不因本批变更；R27 以当前源与出站请求
//        形状核查为准，不要求制造源码 diff。
//
// 这些工程不在被测仓库里（claudebotlife / HDSI / spawn-worker.sh / nainai-brain-bridge），
// 实例化运行会启动用户的常驻 worker 或改动外部部署，因此本套件默认一个都不做：
// 只有夹具显式提供**白名单命令/地址**时才执行，并且绝不启动 worker、绝不重启既有任务。
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as rt from './helpers/r2528-runtime.mjs';

const run = promisify(execFile);

test.describe('R26 外部 worker 入口', () => {
  test('R26-01 入口仍接受 bot/chat/uuid/dispatcher_url（跑夹具白名单里的只读命令）', async () => {
    rt.requireExternal('核查外部 worker 入口需要触碰仓库外目录，必须显式授权');
    const entry = rt.fixtureSection('workerEntry');
    const command = rt.requireField(entry, 'readonlyCommand');
    // 只跑操作者写进夹具的只读命令（例如该脚本自己的 --help）；本套件不发明调用方式，
    // 也绝不用它启动 worker。
    const { stdout, stderr } = await run(command, [], { timeout: 20_000, shell: true });
    const output = `${stdout}\n${stderr}`;
    for (const input of ['bot', 'chat', 'uuid', 'dispatcher_url']) {
      expect(output, `R26-01 入口的公开说明必须仍接受 ${input}`).toContain(input);
    }
  });

  test('R26-02 同一目标不得重复启动（需要可丢弃目标 + 两次启动授权）', async () => {
    rt.requireExternal('重复启动核查会真的起一个 worker，必须显式授权');
    const section = rt.fixtureSection('workerDuplicateStart');
    const command = rt.requireField(section, 'startCommand');
    const readInstances = rt.requireField(section, 'readInstancesCommand');
    const target = rt.requireField(section, 'target');

    await run(`${command} ${target}`, [], { timeout: 30_000, shell: true });
    await run(`${command} ${target}`, [], { timeout: 30_000, shell: true });
    const { stdout } = await run(readInstances, [], { timeout: 20_000, shell: true });

    const instances = stdout.split('\n').filter(line => line.includes(target));
    expect(instances.length, `R26-02 同一目标最多一个实例（观测：${stdout.slice(0, 200)}）`).toBeLessThanOrEqual(1);
  });
});

test.describe('R27 HDSI/Brain 边界', () => {
  test('R27-01 桥的 GET /health 与既有 POST /v1/chat/completions 不因本批变更', async ({ request }) => {
    rt.requireExternal('R27 需要外部桥实例地址；本套件不启动/不切外部部署');
    const bridge = rt.fixtureSection('bridge');
    const base = rt.requireField(bridge, 'baseURL').replace(/\/$/, '');

    const health = await request.get(`${base}/health`, { failOnStatusCode: false });
    expect(health.status(), 'R27-01 既有 /health 必须照常作答').toBe(200);

    // 基线由操作者在变更前记录（键集合与值类型）；没有基线就无法证明"不因本批变更"。
    const baselinePath = rt.requireField(bridge, 'healthShapeFile');
    const baseline = JSON.parse(await (await import('node:fs/promises')).readFile(baselinePath, 'utf8'));
    const shape = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? 'array' : typeof item]));
    expect(shape(await health.json()), 'R27-01 /health 形状必须与变更前基线一致').toEqual(shape(baseline));
  });

  test('R27-02 未来路径：带保留签名且要改前缀时不得静默伪造（当前未启用，只记边界）', async ({ request }) => {
    rt.requireExternal('该未来路径未实现/未启用时只记录边界，运行时核查需显式授权与可丢弃桥实例');
    const bridge = rt.fixtureSection('bridge');
    const base = rt.requireField(bridge, 'baseURL').replace(/\/$/, '');
    const path = bridge.chatPath || '/v1/chat/completions';

    const response = await request.post(`${base}${path}`, {
      data: {
        model: bridge.model || 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'R2528 边界探针' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '兼容边界探针', signature: 'r2528-not-a-real-signature' },
              { type: 'text', text: 'OK' },
            ],
          },
          { role: 'user', content: 'R2528 继续' },
        ],
      },
      failOnStatusCode: false,
    });

    expect(response.status(), 'R27-02 不得以 5xx 崩溃回应带签名历史').toBeLessThan(500);
    const body = await response.text();
    expect(body, 'R27-02 不得把伪造签名回执成"已保留/已验证"')
      .not.toMatch(/preserved[_ ]thinking|signature[_ ]verified|保留(思考|签名)成功/i);
    expect(response.status() === 200 && !body.trim(),
      'R27-02 不得以空 200 假装成功').toBe(false);
  });
});
