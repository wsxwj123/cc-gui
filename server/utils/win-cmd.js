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
  // 反斜杠只在**紧邻引号**时才有转义含义(CRT / CommandLineToArgvW:2N 个 `\` + `"` = N 个 `\`
  // 加引号开关,2N+1 个 `\` + `"` = N 个 `\` 加一个字面引号)。所以要翻倍的反斜杠有两处:
  //   · 紧邻**内嵌引号**前面的:`a\"b` 里的 `\` 会把我们用来转义的 `""` 吃掉半个 → 引号状态
  //     错位,后续参数被吞(MCP args 常见的 `--config "{\"k\":\"v\"}"` 正是这形态);
  //   · token **结尾**的:末尾的 `\` 会和收尾引号连成 `\"` 被当成字面引号 → 引号不闭合,
  //     后续参数被并进同一个字符串(`-e ROOT=D:\data\ -- npx server` 会整段变成第 5 个参数)。
  // 其余位置的反斜杠(`C:\a\b` 中间那些)保持原样;cmd 层看到的引号总数仍是偶数,奇偶规则不变。
  const q = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`;
  const line = [resolved, ...(Array.isArray(args) ? args : [])].map(q).join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    opts: { ...(opts || {}), windowsVerbatimArguments: true },
  };
}

// 「本次起进程是否真的经 cmd.exe」的唯一判据 —— 与 chat.js claudeSpawn 的分支逐字同口径。
// 注意**不等价**于 claude-resolver 的 claudeExecSpec(`win32 && !/\.exe$/i`):那边要把裸名/
// 无扩展名 shim 也交给 cmd 按 PATHEXT 解析(r106),这里问的是"claudeSpawn 会不会走 cmd 分支"。
// 两者故意不同,禁止统一。
export function spawnViaCmdExe(binPath, platform = process.platform) {
  return platform === 'win32' && typeof binPath === 'string' && /\.(cmd|bat)$/i.test(binPath);
}

// cmd.exe 单条命令行的字符上限。超过会被静默截断(不报错),故凡经 cmd 传用户文本的
// 调用方必须先量长度。直执行(CreateProcess)的上限是 32767 且超限会显式报错,不在此列。
export const WIN_CMD_LINE_MAX = 8191;

// 量「这次真正交给 CreateProcess 的那条命令行」有多长:必须用 winCmdSpawnSpec 组装后的
// 结果算,不能拿原始参数长度猜 —— 每个内嵌引号在引用时会翻倍,6999 个引号的 prompt
// 展开后是 14105 字符。不经 cmd.exe 时恒不判超(那条路的上限是另一套且会显式报错)。
// 已知盲区:cmd 的 `%VAR%` 展开发生在引号内,展开后可能更长,无法在此建模(见文件头)。
export function winCmdLineBudget(binPath, args, opts) {
  // opts 显式传 null 时解构默认值不生效(默认值只认 undefined),故在函数体里归一。
  const { platform = process.platform, max = WIN_CMD_LINE_MAX } = (opts && typeof opts === 'object') ? opts : {};
  const limit = max;
  if (!spawnViaCmdExe(binPath, platform)) return { viaCmd: false, length: 0, limit, over: false };
  const s = winCmdSpawnSpec(binPath, args);
  const length = [s.file, ...s.args].join(' ').length;
  return { viaCmd: true, length, limit, over: length > limit };
}

