// 官方 MCP 注册表搜索(registry.modelcontextprotocol.io)。
// 壳子原则核查:claude CLI 无注册表搜索命令(`claude mcp` 子命令仅 add/list/get/remove/
// login/logout/serve 等,2026-07 实测 --help),故此处直调注册表 HTTP API,不算在 server 重造 CLI 能力。
// GET /v0/servers?search=&version=latest&limit= 实测返回 { servers:[{ server:{name,description,
// version,repository,packages[],remotes[]}, _meta }], metadata:{count,nextCursor} }。
// 注册表返回的名称/描述/命令全部是外部数据:仅作为添加表单的预填初值展示,不自动执行安装。
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const CACHE_TTL_MS = 15 * 60_000;
const LIMIT = 20;
const cache = new Map(); // q(lowercase) -> { at, items }

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

// 搜索注册表(带 15 分钟内存缓存 keyed by q)。fetchImpl 可注入供测试。
// 上游失败抛可读错误(不静默空列表):网络层失败提示"网络不可达,可重试",HTTP 错误透传状态与 body 片段。
export async function searchRegistry(q, { fetchImpl = fetch, ttlMs = CACHE_TTL_MS } = {}) {
  const key = String(q || '').trim().toLowerCase();
  if (!key) return [];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.items;
  const url = `${REGISTRY_URL}?search=${encodeURIComponent(key)}&version=latest&limit=${LIMIT}`;
  let r;
  try {
    r = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '超时(10s)' : (e?.cause?.code || e?.message || String(e));
    throw new Error(`MCP 注册表网络不可达,可重试。(${why})`);
  }
  if (!r.ok) {
    let body = '';
    try { body = (await r.text()).slice(0, 200); } catch {}
    throw new Error(`MCP 注册表返回 HTTP ${r.status}${body ? `:${body}` : ''},可重试。`);
  }
  const data = await r.json();
  const items = (Array.isArray(data?.servers) ? data.servers : [])
    .map(normalizeRegistryEntry)
    .filter(Boolean);
  cache.set(key, { at: Date.now(), items });
  return items;
}
