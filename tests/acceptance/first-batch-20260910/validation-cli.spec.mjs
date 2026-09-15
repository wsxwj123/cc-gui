import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EnvironmentBlocked, getRuntime } from './helpers/runtime.mjs';

function runValidation(worktree, dataRoot, args, timeoutMs = 180_000) {
  const script = path.join(worktree, 'docs', 'validation', 'integration-verify.sh');
  fs.mkdirSync(dataRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(dataRoot, 'validation-'));
  const isolatedHome = path.join(runRoot, 'home');
  const isolatedClaude = path.join(isolatedHome, '.claude');
  fs.mkdirSync(isolatedClaude, { recursive: true });
  const startedAt = Date.now();
  const completion = new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...args], {
      cwd: worktree,
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        CLAUDE_CONFIG_DIR: isolatedClaude,
        BASE_URL: undefined,
        FIRST_BATCH_FIXTURES: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 自建进程组：脚本会自起实例/单测子进程，只杀 bash 会把它们留成孤儿（实测量到过）。
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-1_000_000);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const signalGroup = signal => {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    let deadlineHit = false;
    let killTimer;
    const timer = setTimeout(() => {
      deadlineHit = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 2_000);
    }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      // bash 退出不等于它起的实例/子进程退出：到过时限就整组兜底收尾，不留孤儿。
      if (deadlineHit && groupAlive()) signalGroup('SIGKILL');
      resolve({
        code,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
        timedOut: signal === 'SIGTERM' || signal === 'SIGKILL',
      });
    });
  });
  return completion.finally(() => fs.rmSync(runRoot, { recursive: true, force: true }));
}

async function listenOnUnusedPort() {
  const server = net.createServer(socket => socket.end('test-owned-listener'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

test('FB-T09 R04 reproduction: occupied port exits nonzero, never prints all-pass, and leaves owner alive', async () => {
  test.setTimeout(90_000);
  const { worktree, manifest } = getRuntime({ requireManifest: true });
  const { server, port } = await listenOnUnusedPort();
  try {
    const result = await runValidation(worktree, manifest.dataRoot, [String(port)], 60_000);
    expect(result.timedOut, 'FB-T09: the validation script must exit on its own before the timeout; a hang killed by the timeout (timedOut=true, code=null) must never count as a pass — 挂死/被超时杀死不得算通过').toBe(false);
    expect(result.elapsedMs, 'FB-T09: the script must finish on its own well before the 60s timeout (healthy run ≈70ms); a deadline kill, even one that traps SIGTERM and exits by itself, must never count as a pass — 被时限杀死（包括脚本自行清理后退出）不得算通过').toBeLessThan(30_000);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('全量验证通过');
    expect(server.listening).toBe(true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('FB-T10 R04 boundary: invalid explicit port exits nonzero without an all-pass message', async () => {
  const { worktree, manifest } = getRuntime({ requireManifest: true });
  const result = await runValidation(worktree, manifest.dataRoot, ['not-a-port'], 30_000);
  expect(result.timedOut, 'FB-T10: the validation script must exit on its own before the timeout; a hang killed by the timeout (timedOut=true, code=null) must never count as a pass — 挂死/被超时杀死不得算通过').toBe(false);
  expect(result.elapsedMs, 'FB-T10: the script must finish on its own well before the 30s timeout (healthy run ≈10ms); a deadline kill, even one that traps SIGTERM and exits by itself, must never count as a pass — 被时限杀死（包括脚本自行清理后退出）不得算通过').toBeLessThan(15_000);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain('全量验证通过');
});

test('FB-T11 R04/R29 happy path: every required check must complete before all-pass and exit zero', async () => {
  test.setTimeout(16 * 60_000);
  if (process.env.FIRST_BATCH_RUN_FULL_VALIDATION !== '1') {
    throw new EnvironmentBlocked('set FIRST_BATCH_RUN_FULL_VALIDATION=1 on the prepared isolated host');
  }
  const { worktree, manifest } = getRuntime({ requireManifest: true });
  const result = await runValidation(worktree, manifest.dataRoot, [], 15 * 60_000);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('全量验证通过');
  expect(result.stderr).not.toMatch(/(?:FAIL|失败|timed? out|超时)/i);
});
