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
// 引号挡不住的两条(调用方必须自己守住):
//   · `%VAR%`:cmd 的变量展开在引号内照常发生,引号只挡元字符不挡展开。含 `%` 的用户文本
//     当 argv 传下去,会被替换成环境变量值(或原样留下,取决于变量存不存在)。
//   · 换行:cmd 在换行处截断整条命令行,后面的内容变成"下一条命令"。多行文本不得当 argv 传
//     (chat.js:2683 对 BTW_SYSTEM_REMINDER 已焊死成单行)。
//
// 纯函数(export 仅为可单测);不改写调用方的 opts 对象。
export function winCmdSpawnSpec(resolved, args = [], opts = {}) {
  // 结尾的连续反斜杠要翻倍:反斜杠只在**紧邻引号**时才有转义含义,token 末尾的 `\` 会和收尾
  // 引号连成 `\"`,被 node.exe 的 CRT / CommandLineToArgvW 当成"一个字面引号"→ 引号不闭合,
  // 后续参数被并进同一个字符串(`-e ROOT=D:\data\ -- npx server` 会整段变成第 5 个参数)。
  // 只动结尾,中间的反斜杠(`C:\a\b`)保持原样;cmd 层看到的引号总数仍是偶数,奇偶规则不变。
  const q = (a) => `"${String(a).replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`;
  const line = [resolved, ...(Array.isArray(args) ? args : [])].map(q).join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    opts: { ...(opts || {}), windowsVerbatimArguments: true },
  };
}

