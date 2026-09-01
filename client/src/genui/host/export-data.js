/**
 * r69 图表导出 —— 纯数据层(CSV / JSON / 文件名)。
 *
 * 本文件**零 DOM、零 React、零网络**:输入是已经过 guard 的规格节点,输出是字符串。
 * 写成 `.js` 而不是 `.ts/.tsx` 是为了让裸 node 直接 import 真源码跑单测
 * (仓内先例:check-genui-table-sort 为了测 .tsx 里的函数要先切片写临时 .ts,
 *  那套周折的唯一原因就是扩展名;纯逻辑放 .js 就没这回事)。
 *
 * 导出路径**只读节点自身**:不碰会话、不碰 action/send、不发任何请求。
 * 因此本文件不许 import genui/host/action-* 的任何东西(单测按 import 面盯死)。
 *
 * @module genui/host/export-data
 */

/** CSV 单元格转义:逗号/引号/换行/首尾空格都要加引号,引号内部翻倍。 */
function csvCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  // 公式注入(CSV injection):单元格文本是**模型输出**,Excel/Numbers 会把
  // `=`/`+`/`@`/制表/回车 开头的格子当公式执行。加前导单引号让它退回文本。
  // `-` 只在整格读不出数字时才算危险 —— 负数 `-5` 是正常数据,不能被污染。
  if (/^[=+@\t\r]/.test(s) || (s.startsWith('-') && !Number.isFinite(Number(s)))) s = `'${s}`;
  return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 行数组 → CSV 文本。BOM 打头(Excel 不认 UTF-8 无 BOM,中文会乱码);CRLF 换行。 */
export function rowsToCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 分组序列(chart/echart 的 `series`)是否可用。 */
function usableSeries(node) {
  const s = node?.series;
  return Array.isArray(s) && s.length > 0 && Array.isArray(s[0]?.data) ? s : null;
}

/**
 * 节点 → 二维表(表头 + 数据行),没有表格语义时返回 null。
 *
 * chart / echart 的分组形态**照渲染器的取数方式**来:标签取第一条序列的 label 列、
 * 各序列按同一下标取值(charts.tsx 的 `grouped[0].data.map(d=>d.label)` + `s.data[i]`)。
 * 这样导出的表与屏幕上的图逐格对得上,不会因为某条序列多几个点就整体错位。
 */
export function nodeTable(node) {
  if (node?.type === 'table') {
    const columns = Array.isArray(node.columns) ? node.columns : [];
    const rows = Array.isArray(node.rows) ? node.rows : [];
    if (columns.length === 0) return null;
    return [columns, ...rows.map((r) => columns.map((_, j) => (Array.isArray(r) ? r[j] : undefined)))];
  }
  if (node?.type !== 'chart' && node?.type !== 'echart') return null;
  const series = usableSeries(node);
  if (series !== null) {
    const labels = series[0].data.map((d) => d?.label ?? '');
    return [
      ['标签', ...series.map((s, i) => s?.label ?? `序列${i + 1}`)],
      ...labels.map((label, i) => [label, ...series.map((s) => s?.data?.[i]?.value)]),
    ];
  }
  const data = Array.isArray(node.data) ? node.data : [];
  // echart 的完整 option 形态没有约定的数据形状(纯透传给 ECharts),不猜、不导 CSV。
  if (data.length === 0) return null;
  return [['标签', '值'], ...data.map((d) => [d?.label ?? '', d?.value])];
}

/** 节点 → CSV 文本;没有表格语义(plot / mermaid / diagram / 纯 option 的 echart)时返回 null。 */
export function buildCsv(node) {
  const table = nodeTable(node);
  return table === null ? null : rowsToCsv(table);
}

/** 每类节点允许出现在 JSON 里的字段。白名单而不是黑名单:导出物只含规格字面,
 * 渲染期/宿主挂上去的任何内部键都进不来。 */
const JSON_FIELDS = {
  chart: ['type', 'kind', 'data', 'series'],
  echart: ['type', 'title', 'height', 'preset', 'data', 'series', 'option'],
  plot: ['type', 'title', 'series', 'xMin', 'xMax', 'yMin', 'yMax'],
  table: ['type', 'columns', 'rows'],
  diagram: ['type', 'kind', 'variant', 'title', 'nodes', 'edges', 'zones', 'theme'],
};

/** 节点 → 复制到剪贴板的文本。mermaid 复制图源码,其余复制 JSON。 */
export function buildCopyText(node) {
  if (node?.type === 'mermaid') return typeof node.code === 'string' ? node.code : null;
  const fields = JSON_FIELDS[node?.type];
  if (fields === undefined) return null;
  const out = {};
  for (const k of fields) if (node[k] !== undefined) out[k] = node[k];
  try {
    return JSON.stringify(out, null, 2);
  } catch {
    return null;
  }
}

/** 文件名里必须清掉的字符:路径分隔符、Windows 保留字符、控制字符。 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[/\\:*?"<>|\x00-\x1f]/g;

const DEFAULT_BASE = { chart: '图表', echart: '图表', plot: '函数图', table: '表格', mermaid: '图示', diagram: '图示' };

/** 节点 → 文件名主干(已清洗)。取节点标题,没有标题就用类型中文名。
 * 危险字符换空格再折叠;前导 `.` 一并掐掉(标题以点开头会导成隐藏文件)。 */
export function exportFileBase(node) {
  const raw = typeof node?.title === 'string' ? node.title : '';
  const cleaned = raw.replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').slice(0, 40).trim();
  return cleaned || DEFAULT_BASE[node?.type] || '导出';
}

/** 两位补零。 */
const p2 = (n) => String(n).padStart(2, '0');

/** 节点 + 扩展名 → 完整文件名(带本地时间戳,同一图表多次导出不互相覆盖)。 */
export function exportFileName(node, ext, now = new Date()) {
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return `${exportFileBase(node)}-${stamp}.${ext}`;
}

/**
 * 节点 → 工具条按钮清单。返回 null = 该类型不出工具条。
 *
 * 取舍(BRIEF 允许按数据语义定):
 *  - `plot` 不导 CSV。它的"数据"是连续函数,真要出表得按当前 x 范围采样,而参数滑块的
 *    **实时值只活在组件本地 state**,导出层拿不到 —— 导出来的会是声明初值而不是屏幕上
 *    那条曲线,是错数据。宁可不给,只给 JSON(expr + 参数声明)与 PNG。
 *  - 只给了完整 `option` 的 `echart` 同理不导 CSV:option 是透传给 ECharts 的任意结构,
 *    没有约定的数据形状可抽。JSON 仍给(就是那份 option)。
 *  - `table` 不导 PNG:它是可横滚的 HTML 表,不是画布,截出来的图只会是当前可视区。
 *  - `scene3d` 整个不做:WebGL 画布未开 preserveDrawingBuffer,读回必是空白。
 */
export function exportPlan(node) {
  const copy = buildCopyText(node);
  if (copy === null) return null;
  return {
    copyLabel: node.type === 'mermaid' ? '复制源码' : '复制数据',
    csv: nodeTable(node) !== null,
    png: node.type !== 'table',
  };
}

/** 该节点是否要出导出工具条。渲染分发点用它决定包不包那层容器。 */
export function isExportable(node) {
  return exportPlan(node) !== null;
}
