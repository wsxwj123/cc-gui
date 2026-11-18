// 回退截断时要补回的标题行(零依赖纯模块,不 import 任何东西;三处截断共用)。
//
// 为什么要补回:会话记录是只追加的日志。改名 / 自动名 / 标签三类记录
//   {"type":"custom-title","customTitle":…,"sessionId":…}
//   {"type":"ai-title","aiTitle":…,"sessionId":…}
//   {"type":"tag","tag":…,"sessionId":…}
// 没有 uuid、没有时间戳,是「后写胜出」的会话级状态:改名、命令行退出时补写、AI 起标题
// 都把新的一行追加在文件末尾。回退(trim)、回退到工具调用前(trim-before-tool)、回退并
// 压缩(compact-segment after)按位置截断,截断点之后的整段丢掉,名字也跟着回到截断点之前
// 的值。回退的本意是撤掉对话,不是撤掉会话名,所以把截掉段里的这几行补回去。
//
// 只搬这三类:命令行退出补写前会从文件末尾把这三类同步进内存,说明它自己就把这三类当成
// 「别人可以在末尾追加、以最新为准」的状态。其余补写项不搬:last-prompt(leafUuid)、
// memory-mode(afterUuid)、旧式 summary(leafUuid)指向具体消息;tools-used 是对被删内容
// 的统计;mode 之类应用不读或每次起进程都显式传参。另加一道守卫:类型对、但带 uuid /
// parentUuid / leafUuid / afterUuid 任一字段的也不搬(防将来标题记录带上锚点后被误搬,
// 最坏结果只是退回不补回的旧行为)。字段必须是字符串(空串算,表示清空了名字),与
// session-reader.js 的 takeTitleLine 一致。
//
// 为什么按「类型 + sessionId」每组取最后一条:应用的读法(takeTitleLine)每类只认整份文件
// 的最后一条,截掉段里每类的最后一条必是其所在组的最后一条,一定被选中;命令行续跑时按
// sessionId 分别记名字,用「最后一条对话所带编号」下的那个。分叉 / 续接留下的文件可能混着
// 祖先编号,只取「每类最后一条」会让祖先编号那组退回截断点之前更旧的值。sessionId 缺失或
// 不是字符串的单独成一组。不和保留段里已有的同值记录去重:同值多一行对两个读者都没影响;
// 反复回退也不会越积越多(上次补回的行落进下一刀的截掉段,会与同组记录归并成一条)。
//
// 为什么放在结果最末尾:标题行没有 uuid / parentUuid,不进对话链、不改变叶子;命令行自己
// 退出、压缩之后也是把会话级记录补写在文件末尾(压缩时在摘要之后),这是它的原生形态。
// 补回行之间按原文件里的先后排,保证两个读者的「最后一条」与回退前相同。
//
// 预筛与 takeTitleLine 同写法(行里包含带引号的类型名才 JSON.parse):消息正文、工具结果
// 文本里的这些字样在 JSON 里是转义过的(引号前有反斜杠),不会命中;命中的只有真 JSON
// 对象部分带这些键 / 值的行,解析后按顶层 type 排除。只记下标、不拷贝字符串,扫描只从截断
// 下标起,不新增读盘与整份拆行(调用方已有行数组)。
//
// 不打日志:预览、提交各算一次会重复打;认不出时只是退回不补回的行为。命令行的标题记录
// 写法若变了(type 名、字段名、是否带 sessionId / 锚点字段),靠升级命令行时的复核项发现。

const TITLE_FIELD = new Map([ // 用 Map 不用对象下标:防 "__proto__" / "toString" 之类的 type 命中原型
  ['custom-title', 'customTitle'],
  ['ai-title', 'aiTitle'],
  ['tag', 'tag'],
]);
const ANCHOR_KEYS = ['uuid', 'parentUuid', 'leafUuid', 'afterUuid'];

/**
 * 从截断下标起(0 基,含该行)挑出标题类记录的原行:每组(类型 + sessionId)只取最后一条,
 * 按原下标升序返回。没有可补回的行时返回空数组(调用方拼接后与不补回时逐字节相同)。
 * 纯函数:不读时间、不取随机数、不打日志,同一输入必得同一输出(预览与提交一致靠它)。
 * @param {string[]} lines 整份会话记录按 '\n' 拆开的行(行尾的 '\r' 原样保留在行里)
 * @param {number} fromIdx 截断下标;不是非负整数时视为没有截断,返回空数组
 * @returns {string[]}
 */
export function sessionTitleLinesAfter(lines, fromIdx) {
  if (!Array.isArray(lines) || !Number.isInteger(fromIdx) || fromIdx < 0) return [];
  const lastIdxByGroup = new Map();
  for (let i = fromIdx; i < lines.length; i += 1) {
    const line = lines[i];
    if (typeof line !== 'string') continue;
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"tag"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const field = TITLE_FIELD.get(obj.type);
    if (!field || typeof obj[field] !== 'string') continue;
    if (ANCHOR_KEYS.some((key) => obj[key] !== undefined)) continue;
    const sid = typeof obj.sessionId === 'string' ? obj.sessionId : '';
    lastIdxByGroup.set(JSON.stringify([obj.type, sid]), i); // 后写覆盖 = 每组取最后一条
  }
  return [...lastIdxByGroup.values()].sort((a, b) => a - b).map((i) => lines[i]);
}
