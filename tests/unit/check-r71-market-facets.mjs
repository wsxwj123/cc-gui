#!/usr/bin/env node
// r71:技能市场浏览层纯函数自检(搜索 / 来源分面 / 排序 / 计数)。
// 夹具照抄实测的真实形状(GET /api/skills/official 六源 1108 条):
//   · 字段只有 id / name / description / version / installed —— 没有分类、标签、下载量、更新时间
//   · 服务端 DESC_CAP=30,composio(864)与 hermes(196)整源 description 为空、name 退化成 id
//   · 跨源 id 会撞(实测 19 个,如 anthropic 与 composio 都有 docx)
import assert from 'node:assert/strict';
import {
  ALL_SOURCES, marketKey, matchSkill, filterMarket, sortMarket, countBySource, countInstalled,
} from '../../client/src/utils/skillMarket.js';

const S = (o) => ({ id: '', name: '', description: '', version: null, installed: false, ...o });
// 六源里各取真实条目形状
const FIX = [
  S({ id: 'docx', name: 'docx', description: 'Word 文档处理', source: 'anthropic' }),
  S({ id: 'canvas-design', name: 'canvas-design', description: 'Canvas design helper', source: 'anthropic', installed: true }),
  S({ id: 'brainstorming', name: 'brainstorming', description: 'You MUST use this before any creative work', source: 'superpowers' }),
  S({ id: 'docx', name: 'docx', description: '', source: 'composio' }),              // 跨源同 id + 空描述(DESC_CAP 截断)
  S({ id: '-21risk-automation', name: '-21risk-automation', description: '', source: 'composio' }),
  S({ id: 'web-design-engineer', name: 'web-design-engineer', description: '', source: 'hermes' }),
  S({ id: 'composition-patterns', name: 'vercel-composition-patterns', description: '', version: '1.0.0', source: 'vercel' }), // name ≠ id
  S({ id: 'beautiful-article', name: 'beautiful-article', description: '把素材编辑成一篇美丽的单文件 HTML 网页文章', source: 'garden', installed: true }),
];
const ORDER = ['anthropic', 'superpowers', 'composio', 'vercel', 'hermes', 'garden'];
const ids = (l) => l.map((s) => `${s.source}:${s.id}`);

// ── ① 跨源身份:裸 id 不够用 ────────────────────────────────────────────
assert.equal(marketKey(FIX[0]), 'anthropic:docx');
assert.notEqual(marketKey(FIX[0]), marketKey(FIX[3]), '变异哨兵1:同 id 不同源必须是两个 key(用裸 id 会让列表 key 撞、导入/忙碌标记串到另一个仓库的同名技能)');
assert.equal(marketKey(undefined), ':', '缺参不抛');

// ── ② 搜索:空查询 / 大小写 / 中文 / 多词 AND / 只在描述里命中 ─────────────
assert.equal(filterMarket(FIX, { q: '' }), FIX, '空查询返回原数组身份(调用方 memo 不被无谓打断)');
assert.equal(filterMarket(FIX, { q: '   ' }), FIX, '纯空白等同空查询');
assert.equal(filterMarket(FIX), FIX, '不传选项 = 不筛');
assert.deepEqual(ids(filterMarket(FIX, { q: 'DOCX' })), ['anthropic:docx', 'composio:docx'], '大小写不敏感,两个源的 docx 都在');
assert.deepEqual(ids(filterMarket(FIX, { q: '网页文章' })), ['garden:beautiful-article'], '中文子串命中描述');
assert.deepEqual(ids(filterMarket(FIX, { q: 'Word' })), ['anthropic:docx'], '变异哨兵3:仅描述里有也算命中(把 description 移出检索面会红)');
// 多词 AND:市场 id 是 kebab-case,用户打空格分词的自然写法必须能命中
assert.deepEqual(ids(filterMarket(FIX, { q: 'web design' })), ['hermes:web-design-engineer'], '空格分词后逐词命中 kebab-case id');
assert.deepEqual(filterMarket(FIX, { q: 'docx brainstorming' }), [], '变异哨兵2:多词是 AND 不是 OR(改成 OR 这里会返回 3 条)');
assert.deepEqual(filterMarket(FIX, { q: 'zzz-not-exist' }), [], '无命中返回空数组');
assert.equal(matchSkill(FIX[0], []), true, '零词元一律命中');

// ── ③ 分面:来源 + 安装状态,以及两者叠加 ──────────────────────────────
assert.equal(filterMarket(FIX, { source: ALL_SOURCES }).length, FIX.length, 'ALL_SOURCES 不筛来源');
assert.deepEqual(ids(filterMarket(FIX, { source: 'composio' })), ['composio:docx', 'composio:-21risk-automation'], '按来源窄化');
assert.deepEqual(ids(filterMarket(FIX, { installed: 'installed' })), ['anthropic:canvas-design', 'garden:beautiful-article'], '只看已安装');
assert.equal(filterMarket(FIX, { installed: 'available' }).length, 6, '只看未安装');
assert.deepEqual(ids(filterMarket(FIX, { q: 'design', installed: 'installed' })), ['anthropic:canvas-design'], '搜索 + 安装状态叠加(变异哨兵:任一维被短路都会红)');
assert.deepEqual(ids(filterMarket(FIX, { source: 'anthropic', installed: 'available', q: 'doc' })), ['anthropic:docx'], '三维同时生效');
assert.deepEqual(filterMarket(null, { q: 'x' }), [], '非数组入参回落空数组,不抛');

// ── ④ 计数:只数列表里真有的,没加载过的源不会凭空冒出来 ────────────────
assert.deepEqual(countBySource(FIX), { anthropic: 2, superpowers: 1, composio: 2, hermes: 1, vercel: 1, garden: 1 });
assert.deepEqual(countBySource([]), {}, '空列表没有任何源计数(不预置六个 0,免得像"该源真的空")');
assert.deepEqual(countBySource([{ id: 'x' }]), {}, '没有 source 标签的条目不计入任何源');
assert.deepEqual(countInstalled(FIX), { total: 8, installed: 2, available: 6 });
assert.deepEqual(countInstalled(undefined), { total: 0, installed: 0, available: 0 });

// ── ⑤ 排序:名称升/降、按来源(次序对齐来源按钮行),且不就地改原数组 ───────
const asc = sortMarket(FIX, 'name', ORDER);
assert.notEqual(asc, FIX, '返回新数组');
assert.deepEqual(ids(FIX).slice(0, 2), ['anthropic:docx', 'anthropic:canvas-design'], '变异哨兵3:原数组不得被就地排序');
assert.deepEqual(asc.map((s) => s.name)[0], '-21risk-automation', '升序第一条');
assert.deepEqual(sortMarket(FIX, 'name-desc', ORDER).map((s) => s.name), asc.map((s) => s.name).reverse(), '降序 = 升序反转');
// name 相同(两个 docx)时用 id 兜底比较,结果稳定
assert.equal(sortMarket([FIX[3], FIX[0]], 'name', ORDER).length, 2, '同名条目排序不丢条目');
const bySrc = sortMarket(FIX, 'source', ORDER);
assert.deepEqual(bySrc.map((s) => s.source), ['anthropic', 'anthropic', 'superpowers', 'composio', 'composio', 'vercel', 'hermes', 'garden'],
  '变异哨兵4:按来源排必须照 sourceOrder(来源按钮行的次序),不是按 source 字符串字典序');
assert.deepEqual(sortMarket(FIX, 'source', ORDER).filter((s) => s.source === 'anthropic').map((s) => s.name),
  ['canvas-design', 'docx'], '同源内按名称');
// 不在 sourceOrder 里的源(自定义仓库)排最后,不塞到中间
const withCustom = sortMarket([...FIX, S({ id: 'zz', name: 'zz', source: 'owner/repo' })], 'source', ORDER);
assert.equal(withCustom[withCustom.length - 1].source, 'owner/repo', '未知来源垫底');
assert.equal(sortMarket(FIX, 'bogus', ORDER), FIX, '未知排序键原样返回(不静默乱序)');
assert.deepEqual(sortMarket(null, 'name'), [], '非数组入参回落空数组');

// ── ⑥ 真实规模冒烟:864 条空描述的大源,检索只能靠 id ────────────────────
// (DESC_CAP 截断后 name 被置成 id,所以这类条目只有名称一条检索线索;检索面同时含 id 与 name,
//  两者今天恒等,任一条在都能搜到 —— 这里钉的是"整源空描述也必须搜得到",不是钉具体字段。)
const big = Array.from({ length: 864 }, (_, i) => S({ id: `vendor${i}-automation`, name: `vendor${i}-automation`, source: 'composio' }));
assert.equal(filterMarket(big, { q: 'automation' }).length, 864, '整源空描述时靠名称检索仍全命中');
assert.deepEqual(ids(filterMarket(big, { q: 'vendor7-' })), ['composio:vendor7-automation'], '大源里能精确定位到一条');
assert.deepEqual(ids(filterMarket(big, { q: 'vendor7- automation' })), ['composio:vendor7-automation'], '多词 AND 在大源上同样收敛到一条');

console.log('r71 市场浏览层纯函数自检通过');
