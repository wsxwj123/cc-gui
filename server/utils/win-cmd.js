// Windows 上「经 cmd.exe 起一个非 .exe 目标」的唯一组装口(r108 立规、r110 收口)。
//
// 为什么要有这么一层:Node 的非 shell spawn 只会给**带空格的参数**自己加引号,其余参数
// 原样拼进命令行 —— 而 cmd.exe 会先做一遍元字符解释。于是:
//   · `mcp<2`(paper-search 的合法参数)→ cmd 把 `<2` 当成"从文件 2 读 stdin"的重定向,
//     整条命令报 "The system cannot find the file specified.",claude 根本没被执行;
//   · 命令路径带空格(`C:\Program Files\nodejs\npx.cmd`)+ 任一参数带空格时,命令行里出现
//     4 个引号 → 不满足 cmd 的"恰好两个引号"保留规则 → cmd 删掉首尾引号 → 只看到
//     `C:\Program` → "不是内部或外部命令"。
// 修法(execa / npm 的标准做法):每个 token 各自加引号(内部引号翻倍),整条再套一层外层
// 引号让 cmd 的"删首尾引号"只吃掉它;`windowsVerbatimArguments:true` 声明 Node 不要再插手
// 参数拼接。每 token 独立引号后 `&`/`|`/`^`/`>`/`<` 全落在引号内不被 cmd 解释,注入面不比
// 旧写法大。
//
// 纯函数(export 仅为可单测);不改写调用方的 opts 对象。
export function winCmdSpawnSpec(resolved, args = [], opts = {}) {
  const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
  const line = [resolved, ...(Array.isArray(args) ? args : [])].map(q).join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    opts: { ...(opts || {}), windowsVerbatimArguments: true },
  };
}

// 「用默认程序打开 URL / 文件」= cmd 的**内建命令** `start`,不能复用上面那套 —— 内建命令
// 一旦被加上引号,cmd 会当成文件路径去找,报"不是内部或外部命令"。所以 start 本身裸着,
// 只给目标加引号(内部引号翻倍):URL 里的 `&`(`?a=1&b=2` 太常见)、路径里的 `&`(用户名
// `A&B`)才不会把命令劈成两半、只打开半截。第二个空引号是 start 的"窗口标题"占位,少了它
// start 会把带引号的目标当标题、什么也不开。opts 固定带 verbatim(Node 不要再插手拼接)。
export function winStartSpec(target) {
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `start "" "${String(target).replace(/"/g, '""')}"`],
    opts: { windowsVerbatimArguments: true },
  };
}
