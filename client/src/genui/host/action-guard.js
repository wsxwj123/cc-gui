// genui action 的**送达前断言**(PLAN §1.3.3 L4,INTERFACE §5.10 三条不变量)。
//
// action 是全案唯一一条「模型输出 → 用户权限」的写通道:用户点一下,渲染器就以**用户
// 身份**往会话里发一条消息。L1(guard 的标识符形态门)与 L2(action-send 的 payload
// 白名单)已经各拦一道,这里是第三道 —— 拦的不是今天的输入,是**明天的改动**:
//   · 有人在 guard 外新增一个触发点,动作名没过 L1;
//   · 有人往 COMPONENT_FIELDS 里加了一个带模型散文的字段。
// 这两种改动都不会有人重跑威胁模型,只会有这行报警。
//
// 单独成文件而不是并进 action-send.js:那份是消息**构造**,这份是**放行判定**,
// 混在一起时"谁把关"就不再 grep 得到;且 M7 的折叠解析正在同一批改那个文件。
import { isGenuiIdent } from '../upstream/guard.ts';

/**
 * 模型撰写的自然语言字段。一个字都不许以用户身份出去 —— 否则就是"模型让用户替自己
 * 说话",典型的提示注入放大器(INTERFACE §3.2)。
 */
const PROSE_FIELDS = ['label', 'title', 'question', 'placeholder', 'explanation'];

/** `answers` / `fields` 的**键**是组名与字段 id,同样由模型撰写,必须也是标识符。 */
const IDENT_KEYED_MAPS = ['answers', 'fields'];

/**
 * 这条 action 可不可以送达。返回 `null` = 可送;返回字符串 = 拒发的**理由代号**。
 *
 * 理由代号只含规则名与字段名,**不含任何字段值** —— 违规的那个值本身很可能就是注入
 * 载荷,写进 console 等于换个地方泄漏(INTERFACE §5.9:日志只许出现非内容信息)。
 *
 * 入参 `component` 必须是 `pickComponent()` 的产物 —— 真正被序列化进消息的那份,不是
 * 组件递上来的原始 payload。截断(`shrinkToBudget`)只砍字符串**值**、不动键,所以在
 * 它之前查还是之后查,这三条的结果完全一样。
 *
 * 值不查:`select` / `radio` 的选项文本、输入框里的字,是用户在屏幕上亲眼选中、亲手
 * 填的,§3.2 明确它们是唯一允许外发的模型撰写字符串(用户看得见 = 用户输入)。
 *
 * @param {unknown} action 动作名
 * @param {Record<string, unknown>} component `pickComponent()` 收缩后的 component
 * @returns {string|null}
 */
export function assertSendable(action, component) {
  // 不变量 1:外发文本中出现的动作名必然匹配 ^[A-Za-z0-9_.:-]{1,64}$
  if (!isGenuiIdent(action)) return 'action-shape';
  if (component === null || typeof component !== 'object') return 'component-shape';
  // 不变量 2:不含 label / title / question / placeholder / explanation
  for (const k of PROSE_FIELDS) if (k in component) return `prose-field:${k}`;
  // 不变量 3:模型撰写部分只出现在 JSON 字符串内,且字符集不含引号/换行/尖括号
  for (const k of IDENT_KEYED_MAPS) {
    const m = component[k];
    if (m === null || typeof m !== 'object') continue;
    for (const key of Object.keys(m)) if (!isGenuiIdent(key)) return `ident-key:${k}`;
  }
  if (Array.isArray(component.groups) && !component.groups.every(isGenuiIdent)) return 'ident-item:groups';
  return null;
}
