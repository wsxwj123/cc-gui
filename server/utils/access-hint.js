// r20:「系统拒绝访问该文件夹」的判据与指引 —— 三处共用(git init / git status / 会话列表)。
//
// 起因:r17-4 与 r17-8 各自把 macOS 的「完全磁盘访问」路径**硬编码**进了自己的提示文案,
// 判据也只认 macOS/Linux 的 `operation not permitted` / `permission denied`。
// 在 Windows 上这两条都是错的:
//   - git 报的是 `Access is denied` / 中文版 `拒绝访问`,上面的正则一条都不匹配
//     → 会落进「未知错误」兜底,用户看到的又是一句没用的原始报错;
//   - 就算匹配上了,指引让 Windows 用户去开「系统设置 → 隐私与安全性 → 完全磁盘访问」,
//     那个面板在 Windows 上根本不存在。
// 抽出来共用,是因为这个项目已经栽过一次「一对兄弟端点,一个精细一个粗糙」
// (/api/git/status 早就分类了,/api/git/init 却只回一句 Command failed)。
// 判据与文案各留一份,新增调用点直接用,别再各写各的。

/**
 * git / fs 报「被系统拒绝」的各平台措辞。中文 Windows 与中文 macOS 的本地化文案都在内。
 * r26-E6:补日文 Windows「アクセスが拒否されました」与繁中「存取被拒」形态。
 * 这是【开放集合,尽力而为】的辅判据 —— 本地化文本永远列不全,新语言案例按用户
 * 实报补充;语言无关的主判据在 isAccessDenied 里(fs 错误的结构化 code)。
 */
export const ACCESS_DENIED_RE =
  /operation not permitted|permission denied|access is denied|拒绝访问|不允许的操作|权限不够|アクセスが拒否|アクセス許可がありません|存取被拒|存取權限不足|權限不足/i;

/**
 * r26-E6:统一判定「系统拒绝访问」—— 错误码为主、文本为辅。
 *   主判据:fs 类错误自带结构化 code(EPERM/EACCES/EROFS),与系统语言无关,
 *     根治「本地化报错文本是开放集合」的漏判问题(日文/繁中 Windows 曾落未知兜底)。
 *     EROFS 计入:只读挂载与「系统拒绝」是同类可行动错误,平台指引里本就含
 *     「确认未只读」的排查项。
 *   辅判据:git stderr 这类没有 code 可给的失败,仍走本地化文本匹配(开放集合)。
 * 调用方:git.js(E1/E4/init 分类)、sessions.js(PKG-3 的 E3)。签名以此为准。
 */
export function isAccessDenied(err) {
  const code = err?.code;
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') return true;
  const text = String(err?.stderr || err?.message || '');
  return ACCESS_DENIED_RE.test(text);
}

/**
 * 平台对应的处理指引。文案风格按项目约定:条件 + 祈使式精确陈述,不用营销腔。
 * @param {string} [platform] 仅供测试注入;默认取 process.platform。
 */
export function accessDeniedHint(platform = process.platform) {
  if (platform === 'darwin') {
    return '打开「系统设置 → 隐私与安全性 → 完全磁盘访问」，把 cc-gui 加进去并勾选；已勾选的先取消再重新勾选，然后完全退出 App 再打开。';
  }
  if (platform === 'win32') {
    // Windows 没有「完全磁盘访问」这一说。同类症状的三个真实来源,按命中率排序。
    return '依次检查：①「Windows 安全中心 → 病毒和威胁防护 → 勒索软件防护」里的「受控文件夹访问」是否拦截了 cc-gui（把它加入「允许的应用」）；②该文件夹或其上级是否为只读，以及当前账户是否有写入权限；③第三方杀毒软件是否拦截。若该目录在网络驱动器上，请确认它已连接。';
  }
  return '检查该文件夹的属主与权限（`ls -ld <目录>`），确认当前用户可写；若目录挂载在外部存储或网络文件系统上，请确认它已挂载且未只读。';
}

/** 有没有一个「一键打开」的系统设置面板可跳(只有 macOS 有,见 routes/permission-check.js)。 */
export function canOpenAccessSettings(platform = process.platform) {
  return platform === 'darwin';
}
