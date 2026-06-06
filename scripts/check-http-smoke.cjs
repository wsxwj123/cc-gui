#!/usr/bin/env node

const { spawn } = require('node:child_process');

const root = process.cwd();

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not become ready\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('Claude GUI server READY')) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}\n${output}`));
    });
  });
}

async function spawnServer() {
  let lastError = null;
  for (const port of [6686, 6687, 6688, 6689, 6690]) {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        CGUI_DISABLE_FILE_WATCHER: '1',
        CGUI_ENABLE_LOCAL_ROUTES: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(child, 8000);
      return { child, port };
    } catch (error) {
      child.kill();
      lastError = error;
      if (!/EADDRINUSE/.test(error.message)) break;
    }
  }
  throw lastError || new Error('server did not start');
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { child, port } = await spawnServer();

  try {
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetchText(`${baseUrl}/api/health`, 2500);
    if (health.response.status !== 200 || !/"ok":true/.test(health.text)) {
      throw new Error(`/api/health failed: ${health.response.status} ${health.text.slice(0, 120)}`);
    }

    const html = await fetchText(`${baseUrl}/`, 2500);
    if (html.response.status !== 200) throw new Error(`/ failed: ${html.response.status}`);
    const scriptMatch = html.text.match(/src="(\/assets\/[^"]+\.js)"/);
    if (!scriptMatch) throw new Error('HTML did not reference a JS asset');

    const js = await fetchText(`${baseUrl}${scriptMatch[1]}`, 2500);
    if (js.response.status !== 200) throw new Error(`${scriptMatch[1]} failed: ${js.response.status}`);

    console.log(`[http-smoke] ok http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(`[http-smoke] failed: ${error.message}`);
  process.exit(1);
});
