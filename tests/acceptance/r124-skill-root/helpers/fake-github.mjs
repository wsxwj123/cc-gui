// r124 · 本地假 GitHub(INTERFACE-r124 §B 的替身):一个进程、两个监听口。
//   API 口(替 api.github.com):GET /repos/{o}/{r} · GET /repos/{o}/{r}/git/trees/{ref}?recursive=1
//                               外加 branches/commits/contents 的最小形状,免得产品换一种问法就 404
//   RAW 口(替 raw.githubusercontent.com):GET /{o}/{r}/{branch}/{path}
//   控制口(只在 API 口,前缀 /__control):health · requests(收到过哪些请求)· root-sha(把某仓库根树 sha 换成别的值,C5 用)
// 用法:node fake-github.mjs --api-port N --raw-port M [--pid-file P]   → 就绪后 stdout 打一行 JSON
// 端口只许 6700–6999,硬拒 6677/6689/6710;只绑 127.0.0.1。
import http from 'node:http';
import fs from 'node:fs';
import { REPOS, DEFAULT_BRANCH, buildTree, blobSha } from './repos.mjs';

const FORBIDDEN = new Set([6677, 6689, 6710]);
const okPort = (p) => Number.isInteger(p) && p >= 6700 && p <= 6999 && !FORBIDDEN.has(p);

export function createFakeGithub() {
  const requests = [];
  const rootShaOverride = new Map();          // repo → sha
  const commitShaOf = (repo, rootSha) => `c0${rootSha.slice(2)}`;
  const rootShaOf = (repo) => rootShaOverride.get(repo) || buildTree(repo).sha;

  const json = (res, status, body, extra = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', ...extra });
    res.end(text);
  };
  const notFound = (res) => json(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => resolve(s)); });

  async function apiHandler(req, res) {
    const url = new URL(req.url, 'http://fake-api');
    requests.push({ via: 'api', method: req.method, path: url.pathname + url.search, at: Date.now() });
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (seg[0] === '__control') {
      if (seg[1] === 'health') return json(res, 200, { ok: true, repos: Object.keys(REPOS) });
      if (seg[1] === 'requests' && req.method === 'GET') return json(res, 200, { requests });
      if (seg[1] === 'requests' && req.method === 'POST') { requests.length = 0; return json(res, 200, { ok: true }); }
      if (seg[1] === 'root-sha' && req.method === 'POST') {
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
        if (!REPOS[body.repo]) return json(res, 404, { error: `unknown repo ${body.repo}` });
        if (body.sha) rootShaOverride.set(body.repo, String(body.sha)); else rootShaOverride.delete(body.repo);
        return json(res, 200, { repo: body.repo, sha: rootShaOf(body.repo) });
      }
      return json(res, 404, { error: 'unknown control op' });
    }
    if (seg[0] === 'rate_limit') return json(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } });
    if (seg[0] !== 'repos' || seg.length < 3) return notFound(res);
    const repo = `${seg[1]}/${seg[2]}`;
    const def = REPOS[repo];
    if (!def) return notFound(res);
    const tree = buildTree(repo);
    const rootSha = rootShaOf(repo);
    const commitSha = commitShaOf(repo, rootSha);

    if (seg.length === 3) {
      return json(res, 200, { id: 1, name: seg[2], full_name: repo, private: false, default_branch: DEFAULT_BRANCH, owner: { login: seg[1] }, html_url: `https://github.com/${repo}` });
    }
    if (seg[3] === 'git' && seg[4] === 'trees' && seg[5]) {
      const ref = seg[5];
      const isDirTree = tree.entries.find((e) => e.type === 'tree' && e.sha === ref);
      if (ref !== DEFAULT_BRANCH && ref !== rootSha && ref !== tree.sha && !isDirTree) return notFound(res);
      const recursive = url.searchParams.has('recursive') && url.searchParams.get('recursive') !== '0' && url.searchParams.get('recursive') !== 'false';
      let entries = tree.entries;
      let sha = rootSha;
      if (isDirTree) {
        const prefix = `${isDirTree.path}/`;
        entries = tree.entries.filter((e) => e.path.startsWith(prefix)).map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
        sha = isDirTree.sha;
      }
      if (!recursive) entries = entries.filter((e) => !e.path.includes('/'));
      const base = `http://127.0.0.1/repos/${repo}/git`;
      return json(res, 200, {
        sha,
        url: `${base}/trees/${sha}`,
        tree: entries.map((e) => ({ ...e, url: `${base}/${e.type === 'tree' ? 'trees' : 'blobs'}/${e.sha}` })),
        truncated: false,
      });
    }
    if (seg[3] === 'branches' && seg[4]) {
      if (seg[4] !== DEFAULT_BRANCH) return json(res, 404, { message: 'Branch not found' });
      return json(res, 200, { name: DEFAULT_BRANCH, commit: { sha: commitSha, commit: { tree: { sha: rootSha } } } });
    }
    if (seg[3] === 'commits' && seg[4]) {
      if (seg[4] !== DEFAULT_BRANCH && seg[4] !== commitSha && seg[4] !== 'HEAD') return json(res, 404, { message: 'No commit found' });
      return json(res, 200, { sha: commitSha, commit: { tree: { sha: rootSha }, message: 'fixture' } });
    }
    if (seg[3] === 'commits' && !seg[4]) {
      return json(res, 200, [{ sha: commitSha, commit: { tree: { sha: rootSha }, message: 'fixture' } }]);
    }
    if (seg[3] === 'contents') {
      const ref = url.searchParams.get('ref') || DEFAULT_BRANCH;
      if (ref !== DEFAULT_BRANCH && ref !== commitSha && ref !== rootSha) return notFound(res);
      const p = seg.slice(4).join('/');
      const files = def.files;
      if (p && files[p] !== undefined) {
        const content = files[p];
        return json(res, 200, { type: 'file', encoding: 'base64', size: Buffer.byteLength(content), name: p.split('/').pop(), path: p, sha: blobSha(content), content: Buffer.from(content).toString('base64') });
      }
      const prefix = p ? `${p}/` : '';
      const kids = tree.entries.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'));
      if (!kids.length) return notFound(res);
      return json(res, 200, kids.map((e) => ({ type: e.type === 'tree' ? 'dir' : 'file', name: e.path.split('/').pop(), path: e.path, sha: e.sha, size: e.size ?? 0 })));
    }
    return notFound(res);
  }

  function rawHandler(req, res) {
    const url = new URL(req.url, 'http://fake-raw');
    requests.push({ via: 'raw', method: req.method, path: url.pathname, at: Date.now() });
    let seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const plain404 = () => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404: Not Found'); };
    if (seg.length < 4) return plain404();
    const repo = `${seg[0]}/${seg[1]}`;
    const def = REPOS[repo];
    if (!def) return plain404();
    let rest = seg.slice(2);
    if (rest[0] === 'refs' && rest[1] === 'heads') rest = rest.slice(2);
    const branch = rest[0];
    const rootSha = rootShaOf(repo);
    if (branch !== DEFAULT_BRANCH && branch !== commitShaOf(repo, rootSha)) return plain404();
    const p = rest.slice(1).join('/');
    const content = def.files[p];
    if (content === undefined) return plain404();
    const type = p.endsWith('.md') ? 'text/plain; charset=utf-8' : p.endsWith('.js') ? 'text/plain; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(content) });
    res.end(content);
  }

  const wrap = (h) => (req, res) => { Promise.resolve(h(req, res)).catch((e) => { try { json(res, 500, { error: String(e?.message || e) }); } catch { /* 已回 */ } }); };
  const api = http.createServer(wrap(apiHandler));
  const raw = http.createServer(wrap(rawHandler));

  return {
    api, raw, requests,
    listen(apiPort, rawPort) {
      for (const p of [apiPort, rawPort]) if (!okPort(p)) throw new Error(`端口 ${p} 不在允许范围(6700–6999,且不碰 6677/6689/6710)`);
      return new Promise((resolve, reject) => {
        api.once('error', reject); raw.once('error', reject);
        api.listen(apiPort, '127.0.0.1', () => raw.listen(rawPort, '127.0.0.1', () => resolve({ apiBase: `http://127.0.0.1:${apiPort}`, rawBase: `http://127.0.0.1:${rawPort}` })));
      });
    },
    close() { return Promise.all([new Promise((r) => api.close(() => r())), new Promise((r) => raw.close(() => r()))]); },
  };
}

// 命令行入口(run.sh 用):打印一行 JSON 后常驻,SIGTERM 时退出。
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const apiPort = Number(arg('--api-port')); const rawPort = Number(arg('--raw-port')); const pidFile = arg('--pid-file');
  const fake = createFakeGithub();
  fake.listen(apiPort, rawPort).then((info) => {
    if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
    process.stdout.write(`${JSON.stringify({ ...info, pid: process.pid })}\n`);
  }).catch((e) => { process.stderr.write(`假 GitHub 起不来:${e.message}\n`); process.exit(1); });
  const bye = () => { fake.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
