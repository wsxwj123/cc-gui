// 官方 MCP 注册表搜索(registry.modelcontextprotocol.io)。
// 壳子原则核查:claude CLI 无注册表搜索命令(`claude mcp` 子命令仅 add/list/get/remove/
// login/logout/serve 等,2026-07 实测 --help),故此处直调注册表 HTTP API,不算在 server 重造 CLI 能力。
// GET /v0/servers?search=&version=latest&limit= 实测返回 { servers:[{ server:{name,description,
// version,repository,packages[],remotes[]}, _meta }], metadata:{count,nextCursor} }。
// 注册表返回的名称/描述/命令全部是外部数据:仅作为添加表单的预填初值展示,不自动执行安装。
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 50; // 只判 TTL 不清除会让去抖的中间关键词单调堆积;超上限删最早插入的
const LIMIT = 20;
// r73 浏览页大小。实测 version=latest 深翻到第 10 页(约 1000 条)上游返回 HTTP 500,
// 故只做 cursor 浅翻,不镜像全量;页大小取 50(50×10 仍在可翻范围内)。
const BROWSE_LIMIT = 50;
const cache = new Map(); // `${q}\0${cursor}` -> { at, data:{ items, nextCursor } }

// 注册表条目 → GUI 添加表单可预填的结构。可预填的三类:
//   remotes[0].url → http/sse 类型 URL;npm 包 → `npx -y <id>`;pypi 包 → `uvx <id>`。
// 三者都没有(如仅 oci 镜像)返回 null,搜索结果里不展示(选了也填不出配置)。
export function normalizeRegistryEntry(entry) {
  const sv = entry?.server || {};
  const fullName = String(sv.name || '');
  const base = {
    name: fullName,
    // 建议的表单 ID:取 reverse-DNS 名末段,清洗成 MCP 名允许的字符
    id: (fullName.split('/').pop() || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64),
    description: String(sv.description || '').slice(0, 300),
    version: String(sv.version || ''),
    repository: String(sv.repository?.url || ''),
  };
  const remote = Array.isArray(sv.remotes) ? sv.remotes.find((r) => r && r.url) : null;
  if (remote) {
    // 信任边界:预填的 url 后续会作为 claude CLI 的裸位置参数,恶意注册表条目给
    // `-` 开头字符串会被解析成 flag。URL 解析 + 协议仅允许 http/https,
    // 不合格视为不可预填条目(return null,与下方仅 oci 的过滤同路)。
    let parsed;
    try { parsed = new URL(String(remote.url)); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return {
      ...base,
      kind: 'remote',
      transport: remote.type === 'sse' ? 'sse' : 'http', // streamable-http / http → http
      url: String(remote.url),
      commandLine: '',
      env: [],
      // 条目声明的请求头:只预填键名(值留空由用户填),isSecret/isRequired 进 hint。
      // 注册表内容是外部数据,仅作表单初值。
      headers: (Array.isArray(remote.headers) ? remote.headers : [])
        .filter((h) => h?.name)
        .map((h) => ({
          k: String(h.name),
          hint: [h.isRequired ? '必填。' : '', h.isSecret ? '密钥。' : '', String(h.description || '')].filter(Boolean).join(''),
        })),
    };
  }
  const pkgs = Array.isArray(sv.packages) ? sv.packages : [];
  const pkg = pkgs.find((p) => p?.registryType === 'npm') || pkgs.find((p) => p?.registryType === 'pypi');
  if (pkg?.identifier) {
    const isNpm = pkg.registryType === 'npm';
    // 包后的位置参数(packageArguments)带默认值的一并预填;命名参数/无值的留给用户按文档补。
    const extra = (Array.isArray(pkg.packageArguments) ? pkg.packageArguments : [])
      .map((a) => String(a?.value || a?.default || '')).filter(Boolean).join(' ');
    return {
      ...base,
      kind: isNpm ? 'npm' : 'pypi',
      transport: 'stdio',
      url: '',
      commandLine: `${isNpm ? 'npx -y' : 'uvx'} ${pkg.identifier}${extra ? ' ' + extra : ''}`,
      env: (Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : [])
        .filter((e) => e?.name)
        .map((e) => ({
          k: String(e.name),
          hint: [e.isRequired ? '必填。' : '', String(e.description || '')].filter(Boolean).join(''),
        })),
    };
  }
  return null;
}

// r73:拉一页注册表并归一,返回 { items, nextCursor }。q 为空 = **浏览**(不带 search 参数,
// 即注册表首页);cursor 原样透传给上游做浅翻。15 分钟内存缓存 keyed by (q, cursor)。
// 上游失败抛可读错误(不静默空列表):网络层失败提示"网络不可达,可重试",HTTP 错误透传状态与 body 片段
// —— 浏览翻页失败时前端据此保留已加载条目并显示原因,而不是把列表变空。
export async function browseRegistry({ q = '', cursor = '', fetchImpl = fetch, ttlMs = CACHE_TTL_MS } = {}) {
  const term = String(q || '').trim();
  const cur = String(cursor || '');
  const key = `${term.toLowerCase()}\u0000${cur}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const p = new URLSearchParams({ version: 'latest', limit: String(term ? LIMIT : BROWSE_LIMIT) });
  if (term) p.set('search', term);
  if (cur) p.set('cursor', cur);
  let r;
  try {
    r = await fetchImpl(`${REGISTRY_URL}?${p}`, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '超时(10s)' : (e?.cause?.code || e?.message || String(e));
    throw new Error(`MCP 注册表网络不可达,可重试。(${why})`);
  }
  if (!r.ok) {
    let body = '';
    try { body = (await r.text()).slice(0, 200); } catch {}
    throw new Error(`MCP 注册表返回 HTTP ${r.status}${body ? `:${body}` : ''},可重试。`);
  }
  const raw = await r.json();
  const data = {
    items: (Array.isArray(raw?.servers) ? raw.servers : []).map(normalizeRegistryEntry).filter(Boolean),
    nextCursor: String(raw?.metadata?.nextCursor || ''),
  };
  cache.set(key, { at: Date.now(), data });
  // ponytail: FIFO 上限(Map 迭代序即插入序),命中率要求高再换 LRU
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return data;
}

// 搜索注册表(数组形状,McpForm 折叠搜索走这条)。空词返回空列表且不打上游 —— "空词浏览"
// 是 browseRegistry 的语义,这里保持原样,免得表单的去抖中间态(清空输入)白拉一次首页。
export async function searchRegistry(q, opts = {}) {
  const key = String(q || '').trim();
  if (!key) return [];
  return (await browseRegistry({ q: key, ...opts })).items;
}
