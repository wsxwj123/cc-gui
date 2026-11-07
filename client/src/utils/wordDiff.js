// r158:diff 的字级高亮(纯函数,裸 node 可直接 import 做单测)。
//
// 做法:成对的删除行 / 新增行按顺序一一配对(第 i 个删除行配第 i 个新增行),
// 去掉两行头尾的公共部分,中间不同的那段标成 changed。多出来没配上对的行不做字级高亮。
// 按 Unicode 码点切(Array.from),不把代理对切成两半。不引第三方 diff 库:
// Edit 卡喂进来的本来就是"一段换一段",头尾裁剪足够看出改了哪儿。

/** 两行文字 → { del, add } 两组片段,每段 { text, changed }。没有不同就返回 null。 */
export function wordDiffSegments(oldText, newText) {
  const a = Array.from(String(oldText ?? ''));
  const b = Array.from(String(newText ?? ''));
  const maxPrefix = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;
  if (prefix === a.length && prefix === b.length) return null;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const cut = (chars) => {
    const head = chars.slice(0, prefix).join('');
    const mid = chars.slice(prefix, chars.length - suffix).join('');
    const tail = chars.slice(chars.length - suffix).join('');
    return [
      head && { text: head, changed: false },
      mid && { text: mid, changed: true },
      tail && { text: tail, changed: false },
    ].filter(Boolean);
  };
  return { del: cut(a), add: cut(b) };
}

/**
 * lines:[{ type: 'add'|'del'|其它, content }],按 diff 顺序。
 * 返回 Map<下标, 片段数组>:只有配上对且确有不同的删除行 / 新增行才在表里。
 * 一段连续的删除行紧跟一段连续的新增行算一组,组内按顺序配对。
 */
export function buildWordDiffMap(lines) {
  const map = new Map();
  const list = Array.isArray(lines) ? lines : [];
  let i = 0;
  while (i < list.length) {
    if (list[i]?.type !== 'del') { i += 1; continue; }
    const dels = [];
    while (i < list.length && list[i]?.type === 'del') { dels.push(i); i += 1; }
    const adds = [];
    while (i < list.length && list[i]?.type === 'add') { adds.push(i); i += 1; }
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k += 1) {
      const seg = wordDiffSegments(list[dels[k]].content, list[adds[k]].content);
      if (!seg) continue;
      map.set(dels[k], seg.del);
      map.set(adds[k], seg.add);
    }
  }
  return map;
}
