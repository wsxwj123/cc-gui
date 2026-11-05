// 电脑操控的「禁止操控」名单(r154)。纯函数、无 I/O。
//
// 为什么要有它:授权表(grants.json)任何同用户进程都能写,它又是"能操控哪些应用"的唯一判据。
// 这里是一条与授权表无关的底线——终端类、CC-GUI 自身、系统设置与脚本自动化工具、钥匙串与
// 密码管理器,即使授权表里有(旧数据、手改文件)也不会被操控。
//
// 这是**已知高危的下限,不是边界**:名单不穷举(新终端模拟器层出不穷),浏览器 / IDE / 启动器
// 有意不在名单里(合法自动化场景多,属残余风险,见 docs/computer-use.md「已知边界」)。
// 本机 Info.plist 实验证明没有可靠特征能把"终端 / IDE"和普通应用分开,所以只能是名单。
//
// 为什么是代码常量而不是配置文件:能降低保护的配置,任何同用户进程(含模型)都能改;
// 名单只随版本发布增加。

export const FORBIDDEN_CATEGORIES = Object.freeze({
  terminal: {
    label: '终端类',
    macIds: [
      'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable', 'dev.warp.Warp',
      'com.mitchellh.ghostty', 'org.alacritty', 'net.kovidgoyal.kitty', 'com.github.wez.wezterm',
      'co.zeit.hyper', 'org.tabby', 'com.raphaelamorim.rio',
    ],
    macPrefixes: [],
    winExeNames: [
      'cmd', 'powershell', 'pwsh', 'powershell_ise', 'windowsterminal', 'wt', 'conhost', 'openconsole',
      'mintty', 'wsl', 'bash', 'alacritty', 'wezterm-gui', 'wezterm', 'hyper', 'tabby', 'putty',
    ],
  },
  self: {
    label: 'CC-GUI 自身',
    // 主 id = src-tauri/tauri.conf.json 的 identifier(有对齐测试);变体应用(如 .ds)同样自带
    // 权限批准按钮,按前缀一并挡住,只写主 id 会漏。
    macIds: ['com.claudegui.desktop'],
    macPrefixes: ['com.claudegui.desktop.'],
    // claude-gui = src-tauri/Cargo.toml 包名(Tauri 默认可执行文件名,有对齐测试;Windows 产物未实测)
    winExeNames: ['claude-gui', 'cc-gui'],
  },
  system: {
    label: '系统设置与脚本自动化工具',
    macIds: ['com.apple.systempreferences', 'com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts'],
    macPrefixes: [],
    winExeNames: ['systemsettings', 'control', 'regedit', 'mmc', 'taskmgr'],
  },
  secrets: {
    label: '钥匙串与密码管理器',
    macIds: [
      'com.apple.keychainaccess', 'com.apple.Passwords', 'com.1password.1password',
      'com.agilebits.onepassword7', 'com.bitwarden.desktop', 'org.keepassxc.keepassxc',
    ],
    macPrefixes: [],
    winExeNames: ['1password', 'bitwarden', 'keepassxc', 'keepass', 'dashlane'],
  },
});

// 预先算好小写查找表:macOS 按 bundleId 不区分大小写精确匹配,Windows 按 exe 文件名(去 .exe)匹配。
const MAC_ID_TO_CATEGORY = new Map();
const MAC_PREFIXES = [];
const WIN_NAME_TO_CATEGORY = new Map();
for (const [category, def] of Object.entries(FORBIDDEN_CATEGORIES)) {
  for (const id of def.macIds) MAC_ID_TO_CATEGORY.set(id.toLowerCase(), category);
  for (const prefix of def.macPrefixes) MAC_PREFIXES.push([prefix.toLowerCase(), category]);
  for (const name of def.winExeNames) WIN_NAME_TO_CATEGORY.set(name.toLowerCase(), category);
}

/** 所有类别标签,用「、」连接。提示文案统一从这里生成,不各写一份。 */
export function forbiddenCategoryLabels() {
  return Object.values(FORBIDDEN_CATEGORIES).map((def) => def.label).join('、');
}

/**
 * 应用身份是否属禁止类别 → null | { category, label }。
 * macOS:去首尾空白 + NFC 后,不区分大小写精确匹配,或命中前缀。
 * Windows:应用身份是 exe 路径,口径与 cu-common 的 normalizeAppId 一致(大小写不敏感、
 * `/` 与 `\` 等价),取最后一段文件名、去掉 `.exe` 后按名单比。这里自己切文件名而不 import
 * cu-common,是为了让本模块保持无依赖的纯函数(cu-common 反过来要 import 本模块)。
 */
export function forbiddenAppReason(appId, platformName = process.platform) {
  if (typeof appId !== 'string') return null;
  const text = appId.trim().normalize('NFC').toLowerCase();
  if (!text) return null;
  let category = null;
  if (platformName === 'win32') {
    const parts = text.split(/[\\/]+/).filter(Boolean);
    const fileName = parts.length ? parts[parts.length - 1] : '';
    const stem = fileName.endsWith('.exe') ? fileName.slice(0, -4) : fileName;
    category = WIN_NAME_TO_CATEGORY.get(stem) || null;
  } else {
    category = MAC_ID_TO_CATEGORY.get(text) || null;
    if (!category) {
      const hit = MAC_PREFIXES.find(([prefix]) => text.startsWith(prefix));
      category = hit ? hit[1] : null;
    }
  }
  return category ? { category, label: FORBIDDEN_CATEGORIES[category].label } : null;
}

/** MCP 动作被拒时的 detail(一句话,含"禁止")。 */
export function forbiddenActionDetail(reason) {
  return `目标应用属于禁止操控的类别(${reason.label}),不会被操控;授权表里有它也不生效。`;
}

/** HTTP 403 CU_APP_FORBIDDEN 的文案。 */
export function forbiddenGrantMessage(reason) {
  return `该应用属于禁止操控的类别(${reason.label}),无法授权。`;
}
