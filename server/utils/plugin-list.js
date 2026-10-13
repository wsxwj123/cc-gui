// `claude plugin list` 的输出解析(纯函数,零依赖,单测直接喂字符串:tests/unit/check-r150-plugin-list.mjs)。
//
// 输出分两段。前一段是装在本机的插件(登记在 ~/.claude/plugins/installed_plugins.json):
//     ❯ pua@pua-skills
//       Version: 2.0.0
//       Scope: user
//       Status: ✔ enabled            (或 ✘ disabled / ✘ failed to load)
// 后一段是 Claude CLI 从 claude.ai 账号同步下来的插件,它们**不在** installed_plugins.json 里:
//   Synced from claude.ai:           (未开同步的环境里标题是
//     ❯ design@synced                  "Synced from claude.ai — sync is off in this shell; these load only in a synced session:")
//       Version: 1.2.0
//       Path: /…/plugins/synced/<目录>/design
//       Status: ✘ disabled            (或 ✔ loaded / ✔ enabled)
//
// r150 E1:原来的解析不分段、按不带 @ 的名字记启用状态,有两个问题 ——
//   ① 同步段的插件面板里完全看不到(列表只读 installed_plugins.json),用户没有入口整个停用;
//   ② 同步段里与已安装插件同名的那个(design@synced 对 design@某市场)会盖掉已安装那个的启用状态。

const SYNCED_HEADER = /^\s*Synced from claude\.ai\b/i;
const SYNCED_MARKET = 'synced';

/**
 * @param {string} output `claude plugin list` 的标准输出(外部数据:只取用到的字段,形态不对就当没有)
 * @returns {{ installed: Record<string, boolean>, synced: Array<{name:string, version:string, path:string, enabled:boolean, status:string}> }}
 *   installed —— 已安装那一段:不带 @ 的插件名 → 是否启用(与原解析同口径:只有 "✔ enabled" 算启用)
 *   synced    —— 账号同步那一段:name 一律是 <插件名>@synced(停用 / 启用命令用的就是这个名字);
 *                "✔ loaded" 与 "✔ enabled" 都算启用
 */
export function parsePluginList(output) {
  const installed = {};
  const synced = [];
  if (typeof output !== 'string' || !output) return { installed, synced };
  let inSynced = false;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const { bare, market, version, path, status } = cur;
    if (cur.inSynced || market === SYNCED_MARKET) {
      synced.push({ name: `${bare}@${SYNCED_MARKET}`, version, path, enabled: /^✔\s*(enabled|loaded)\b/i.test(status), status });
    } else {
      installed[bare] = /^✔\s*enabled/i.test(status);
    }
    cur = null;
  };
  for (const rawLine of output.split(/\r?\n/)) {
    if (SYNCED_HEADER.test(rawLine)) { flush(); inSynced = true; continue; }
    const head = rawLine.match(/^\s*❯\s*(\S+)/);
    if (head) {
      flush();
      const id = head[1];
      const at = id.indexOf('@');
      cur = { bare: at > 0 ? id.slice(0, at) : id, market: at > 0 ? id.slice(at + 1) : '', inSynced, version: '', path: '', status: '' };
      continue;
    }
    if (!cur) continue;
    const field = rawLine.match(/^\s*(Version|Path|Status):\s*(.*)$/i);
    if (!field) continue;
    const key = field[1].toLowerCase();
    cur[key] = field[2].trim();
  }
  flush();
  return { installed, synced };
}

// ── 插件名校验(r150c S6)──────────────────────────────────────
// 插件名会原样作为参数传给 `claude plugin enable / disable / update / uninstall <名字>`。以 - 开头的名字
// 会被命令行当成选项(-x、--help 之类),不是插件名。更新时 @ 后面那段还会单独传给
// `claude plugin marketplace update <市场>`,所以它也不许以 - 开头。
// 字符集与长度沿用路由里原有的那条规则;合法名字的判定不变。
const PLUGIN_NAME_RE = /^[A-Za-z0-9._@\-/]{1,100}$/;

/** 这个名字能不能安全地当作命令行参数传给 claude(字符集合法、不以 - 开头、@ 后各段也不以 - 开头)。 */
export function isSafePluginName(name) {
  if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) return false;
  return name.split('@').every((part) => !part.startsWith('-'));
}

