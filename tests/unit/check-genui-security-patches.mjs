#!/usr/bin/env node
// r64 M8:安全补丁包的行为级单测。
// 覆盖 PLAN §5.3 的三个缺口 + 补丁 4 + M4 挂账的空卡缺陷 + send 类型谎言,对应契约
// INTERFACE §5.2(未知类型/全丢)、§5.4(媒体地址)、§5.5(echart option)、
// §5.6(密码字段)、§9.1(genui-ignored 的"必须存在/必须不存在"两半)。
//
// 每条安全用例都成对写:**攻击输入 → 被拦** 与 **正常输入 → 不误杀**。只写前一半的话,
// 把函数改成"什么都拒"照样全绿,而那等于把功能关掉(补丁 4 的四个标签就是这么被否掉的)。
//
// 能裸 node 加载的 .ts 一律真跑;.tsx / .jsx 加载不了(ERR_UNKNOWN_FILE_EXTENSION),
// 按仓内惯例(check-genui-fence-render / check-codeblock-extract)走源码锁 —— 但锁的是
// **顺序与结构**(门在 onAction 之前、零丢弃时元素不存在),不是"文案还在不在"。
//
// 变异自证(下面 8 条已逐条实跑过"改坏就红",不是"写法没变就绿"的文本锁):
//   A:guard 的 `default:` 退回上游 `return value as GenuiNode`      → 第 1 组红
//   B:repairNode 计数外壳只记 dropped 不记 kept(kept 恒 0)        → 第 2 组红
//   C:repairItems 预算耗尽时不补记被省略的兄弟                       → 第 2 组红
//   D:safeMediaSrc 放行绝对 http(s)(退回上游)                      → 第 6 组红
//   E:safeMediaSrc 的判定不剔控制符(退回 trim())                   → 第 6 组红
//   F:sanitizeEChartOption 去掉 isExternalRef 那一行                 → 第 7 组红
//   G:sanitizeEChartOption 不删 title.link / sublink                 → 第 7 组红
//   H:SVG_INJECTION 退回上游 `[\s"']on[a-z]+\s*=`                    → 第 8 组红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const { repairGenuiSpec, GENUI_LIMITS } = await import('../../client/src/genui/upstream/guard.ts');
const { assertSafeSvg } = await import('../../client/src/genui/upstream/mermaid-safe.ts');

/** 单节点过一遍 guard;被丢弃时 null。 */
const one = (n) => repairGenuiSpec({ items: [n] }).items[0] ?? null;
/** 带一个合法兄弟,用来断言"丢一个不牵连兄弟"以及灰字有地方显示。 */
const withSibling = (n) => repairGenuiSpec({ items: [n, { type: 'text', content: 'KEEP' }] });
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

// ── 1. 缺口 A:未知组件类型不再原样透传(§5.2)────────────────────────────────────
{
  for (const bad of ['script', 'iframe', 'html', 'object', 'embed', 'style', 'TEXT', 'Button',
    '__proto__', 'constructor', 'toString', 'x-custom']) {
    const r = withSibling({ type: bad, content: 'PAYLOAD', label: 'PAYLOAD', items: [] });
    assert.deepEqual(r.items.map((x) => x.type), ['text'],
      `未知类型必须丢弃(白名单是精确小写匹配): ${bad}`);
    assert.ok(!JSON.stringify(r).includes('PAYLOAD'),
      `被丢弃的节点不得残留在结果里: ${bad}`);
  }
  // 真正的危害不是"渲染出东西",是**架空预算**:透传的子树不限深度、不限字符串、
  // 自己只占 1 个节点([安全 §1.3])。这条是变异 A 的红绿线。
  const huge = { type: 'zzz', payload: Array.from({ length: 3000 }, (_, i) => ({ i, s: 'xxxxxxxxxx' })) };
  const t0 = Date.now();
  const r = withSibling(huge);
  assert.ok(Date.now() - t0 < 2000, '未知节点的子树不该被遍历/序列化');
  assert.ok(!JSON.stringify(r).includes('zzz'), '未知子树整棵都不得进渲染树(否则流式期每 chunk 两次 stringify)');
  // 正例:白名单类型照常活下来,别把闸门焊死
  assert.equal(one({ type: 'text', content: 'hi' }).type, 'text', '白名单类型不许被误杀');
  assert.equal(one({ type: 'card', items: [{ type: 'text', content: 'a' }] }).type, 'card');
}

// ── 2. 计数口径:dropped 数被丢的、kept 数活的(§5.2 / §9.1)──────────────────────
{
  const cases = [
    ['单个未知类型 + 合法兄弟', { items: [{ type: 'aa' }, { type: 'text', content: 'k' }] }, 1, 1],
    ['三个未知类型', { items: [{ type: 'aa' }, { type: 'bb' }, { type: 'cc' }, { type: 'text', content: 'k' }] }, 3, 1],
    ['节点本身不是对象', { items: ['<script>x</script>', 42, null, { type: 'text', content: 'k' }] }, 3, 1],
    ['type 缺失', { items: [{ content: 'a' }, { type: 'text', content: 'k' }] }, 1, 1],
    ['必填字段缺失(已知类型)', { items: [{ type: 'text' }, { type: 'text', content: 'k' }] }, 1, 1],
    ['嵌套里丢:容器活、孩子死', { items: [{ type: 'card', items: [{ type: 'text' }, { type: 'text', content: 'k' }] }] }, 1, 2],
    ['全干净:零丢弃', { items: [{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }] }, 0, 2],
    ['全部非法:kept=0', { items: [{ type: 'aa' }, { type: 'bb' }] }, 2, 0],
  ];
  for (const [why, spec, dropped, kept] of cases) {
    const r = repairGenuiSpec(spec);
    assert.equal(r.dropped, dropped, `dropped 口径不对(${why})`);
    assert.equal(r.kept, kept, `kept 口径不对(${why})`);
  }
  // 超预算裁剪同样计入「已忽略」(§9.1 把它列进了灰字的触发条件)。这是变异 C 的红绿线:
  // `break` 掉的兄弟从没进过 repairNode,不在那儿补记就永远少数。
  const over = repairGenuiSpec({
    items: [{ type: 'col', items: Array.from({ length: 300 }, (_, i) => ({ type: 'text', content: 'n' + i })) }],
  });
  assert.equal(over.kept, GENUI_LIMITS.maxNodes, '存活数应正好用满节点预算');
  assert.ok(over.dropped > 0, '被预算省略的兄弟必须计入 dropped,否则灰字少数一批');
  assert.equal(over.dropped + over.kept, 301, '丢的 + 活的 = 送进来的(1 个 col + 300 个 text)');
  // 计数是每次调用现算的,不跨调用累加
  const twice = () => repairGenuiSpec({ items: [{ type: 'aa' }, { type: 'text', content: 'k' }] }).dropped;
  assert.equal(twice(), twice(), '计数不得跨调用累加(ctx 每次新建)');
}

// ── 3. 一个可渲染组件都没有 ⟹ 退回代码块,不渲染空卡(§5.2 末段;M4 挂账)──────────
{
  // M12a:判定逻辑搬去 host/fence-classify.ts(裸 node 要 import 得到,PLAN §2.0.2);
  // JSX 只剩渲染。断言按归属分开,意思一字不变。
  const fence = read('client/src/components/GenuiFence.jsx');
  const classify = read('client/src/genui/host/fence-classify.ts');
  const body = classify.slice(classify.indexOf('export function classifyFence'));
  assert.ok(/kept === 0[\s\S]{0,60}kind: 'no-node'/.test(body),
    '空卡守卫要按 guard 回传的 kept 判(与灰字的 dropped 同源),不许在这里另算一遍节点数');
  assert.ok(body.indexOf('resolveGenuiSpec(') < body.indexOf('kept === 0'),
    '守卫在解析之后:得先有 spec 才谈得上有没有节点');
  // 降级形态:代码块恒在,且**不出说明条** —— JSON 是好的,说"解析失败"是撒谎;
  // 灰字也没有承载它的块(§9.1「全部节点都被丢弃时必须不存在」)。
  assert.ok(/kind: 'no-node', notice: null/.test(body),
    'no-node 必须不带 notice:JSON 是好的,弹"解析失败"是撒谎');
  assert.ok(/notice=\{fence\.notice\}/.test(fence),
    'JSX 的说明条只认 classifyFence 的回传,不许自己判形态再补一条文案');
  // 说明条配色接宿主主题变量,不留字面色:原来的 #f87171 是给深色底调的浅红,
  // 浅色主题下对比度不够;--color-error 本身是明暗两套(index.css)。
  const tone = fence.slice(fence.indexOf('const NOTICE_TONE'), fence.indexOf('function DegradedFence'));
  assert.ok(/var\(--color-error\)/.test(tone), '红条要用 --color-error');
  assert.ok(/var\(--color-ink-(faint|muted)\)/.test(tone), '中性说明条要用 --color-ink-* 而不是写死的灰');
  assert.ok(!/#[0-9a-fA-F]{3,8}|rgba?\(/.test(tone),
    '说明条配色里不许再留任何字面色值(换主题时只有一处要改)');
}

// ── 4. 灰字「N 个不支持的组件已忽略」(§9.1 的两半)────────────────────────────────
{
  const block = read('client/src/genui/upstream/GenuiBlock.tsx');
  assert.ok(/data-testid="genui-ignored"/.test(block), '灰字要挂 genui-ignored 锚(§9.1)');
  assert.ok(/spec\.dropped !== undefined && spec\.dropped > 0 && \(/.test(block),
    '零丢弃时整个元素**不存在**(不是渲染一个空灰字)——"必须不存在"那半靠这条成立');
  assert.ok(/\{spec\.dropped\} 个不支持的组件已忽略/.test(block), '文案逐字对上 §5.2');
  assert.equal((block.match(/data-testid="genui-ignored"/g) || []).length, 1, '每块至多一处');
  const css = read('client/src/genui/upstream/GenuiBlock.module.css');
  assert.ok(/\.ignored \{[\s\S]{0,220}var\(--dsw-alias-label-tertiary\)/.test(css),
    '灰字用既有的 tertiary 标签色跟着主题走,不许写死色值(会在深色主题下瞎)');
}

// ── 5. 缺口 B:password 的值没有任何出口(§5.6)──────────────────────────────────
{
  const forms = read('client/src/genui/upstream/blocks/forms.tsx');
  const iInput = forms.indexOf('export function InputNode');
  assert.notEqual(iInput, -1, '找不到 InputNode');
  // 切到**下一个** export 为止:切到文件尾会把 TextareaNode 等一起圈进来,
  // 那些组件本来就该直接调 onAction,断言会假红。
  const nextExport = forms.indexOf('\nexport ', iInput + 1);
  const input = forms.slice(iInput, nextExport === -1 ? forms.length : nextExport);
  const send = input.slice(input.indexOf('const send = (submit: boolean)'), input.indexOf('const ime = useImeComposing()'));
  assert.ok(send.includes('if (secret) return'), 'send 开头要有 secret 门');
  assert.ok(send.indexOf('if (secret) return') < send.indexOf('onAction('),
    'secret 门必须在 onAction 之前:放在后面等于没放');
  // blur 与 Enter 都只经 send —— 不许有绕过 send 直接 onAction 的第二条路
  const handlers = input.slice(input.indexOf('onBlur={'));
  assert.ok(!handlers.includes('onAction('),
    '事件处理器里不得直接调 onAction,否则 secret 门被绕过(blur/Enter 必须都走 send)');
  assert.ok(/onBlur=\{\(\) => \{[\s\S]{0,120}send\(false\)/.test(input), 'blur 走 send(false)');
  assert.ok(/send\(true\)/.test(input), 'Enter 走 send(true)');
  // 另外三条路(落盘 / 内存 / submit 聚合)是上游本来就做对的,一并锁住防回归
  assert.ok(/secret \? '' :/.test(input), '刷新不回填:secret 一律初始化为空串');
  assert.ok(/if \(!secret\) keepValue\(/.test(input), '值连内存层都不写');
  assert.ok(/!answers\?\.secretFields\.has\(id\)/.test(forms), 'submit 聚合要滤掉 secret 字段');
  assert.ok(/registerSecretField\(id\)/.test(input), 'secret id 要登记(落盘过滤靠它)');
}

// ── 6. 缺口 C:媒体地址只放行同源相对路径(§5.4)─────────────────────────────────
{
  const REJECT = [
    ['外部 http(零点击外连,IP+内容外泄)', 'http://evil.com/x.mp4'],
    ['外部 https', 'https://evil.com/x.mp4'],
    ['协议相对', '//evil.com/x.mp4'],
    ['javascript:', 'javascript:alert(1)'],
    ['大小写变形', 'JavaScript:alert(1)'],
    ['data:', 'data:text/html,<script>1</script>'],
    ['file:', 'file:///etc/passwd'],
    ['blob:', 'blob:http://x/y'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['首尾空白', '  javascript:alert(1)  '],
    ['内嵌 TAB(浏览器解析器会剔掉它 → 真实协议就是 javascript:)', 'java' + TAB + 'script:alert(1)'],
    ['内嵌换行', 'java\nscript:alert(1)'],
    ['内嵌 NUL', 'java' + NUL + 'script:alert(1)'],
    ['前置控制符', SOH + 'javascript:alert(1)'],
    ['反斜杠变形', '\\\\evil.com/x.mp4'],
    ['空串', ''],
    ['超 2048 字符', '/a/' + 'b'.repeat(2100)],
  ];
  for (const [why, src] of REJECT) {
    assert.equal(one({ type: 'audio', src }), null, `audio.src 必须被拒并丢弃整个节点(${why})`);
    assert.equal(one({ type: 'video', src }), null, `video.src 同一套判定(${why})`);
    const r = withSibling({ type: 'audio', src });
    assert.deepEqual(r.items.map((x) => x.type), ['text'], `被拒时兄弟照常渲染(${why})`);
    assert.equal(r.dropped, 1, `被拒的媒体节点要计入「已忽略」(${why})`);
  }
  const ACCEPT = [
    ['同源相对(绝对路径形态)', '/api/files/a.mp3'],
    ['同源相对(./)', './a.mp3'],
    ['同源相对(裸文件名)', 'a.mp3'],
    ['带查询串', '/api/files/a.mp3?v=2'],
    ['路径里有空格(不许被"剔控制符"改写)', '/api/files/my file.mp3'],
  ];
  for (const [why, src] of ACCEPT) {
    const n = one({ type: 'audio', src });
    assert.ok(n, `同源相对路径必须放行(${why})`);
    assert.equal(n.src, src, `放行的地址必须**原样**返回,剔控制符只用于判定(${why})`);
  }
  // poster 走同一道闸,但它只是选填字段:非法只丢它自己,不丢整个 video
  const v = one({ type: 'video', src: '/a.mp4', poster: 'https://evil.com/p.png' });
  assert.ok(v && v.src === '/a.mp4', 'src 合法时 video 照常渲染');
  assert.equal(v.poster, undefined, '非法 poster 必须被丢掉');
  assert.equal(one({ type: 'video', src: '/a.mp4', poster: '/p.png' }).poster, '/p.png', '合法 poster 不许被误杀');
  // link.href 是另一套(更严的白名单),不该被这次收紧牵连
  assert.equal(one({ type: 'link', label: 'L', href: 'https://example.com' }).href, 'https://example.com',
    'link.href 的 http(s) 白名单不受媒体收紧影响(§5.4 两张表是分开的)');
  assert.equal(one({ type: 'link', label: 'L', href: 'javascript:alert(1)' }).href, undefined,
    'link 的 javascript: 仍降级为纯文本');
}

// ── 7. 缺口 C:echart option 里的外部资源引用(§5.5)──────────────────────────────
{
  const optOf = (option) => one({ type: 'echart', option });
  const strings = (v, out = []) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
    return out;
  };
  for (const [why, s] of [
    ['http:// 开头', 'http://evil.com/x.png'],
    ['https:// 开头', 'https://evil.com/x.png'],
    ['协议相对 //', '//evil.com/x.png'],
    ['image:// 开头(ECharts 的远程图片写法,不含 url( 也不命中危险正则)', 'image://http://evil.com/x.png'],
    ['image: 后夹 TAB 的变形', 'image:' + TAB + '//evil.com/x.png'],
  ]) {
    const n = optOf({ title: { text: s, subtext: 'SAFE' }, series: [{ type: 'bar', data: [1] }] });
    assert.ok(n, `echart 节点不该整个消失,只丢那一条键(${why})`);
    assert.ok(!strings(n.option).includes(s), `外链字符串必须整条丢弃(${why})`);
    assert.ok(strings(n.option).includes('SAFE'), `同层的安全字段不许被牵连(${why})`);
  }
  // 三种远程图片写法(symbol / graphic.style.image / backgroundColor.image)——
  // 上游对这三条一条都拦不住,是缺口 C 的原始取证([安全 §3.3])
  const three = optOf({
    series: [{ type: 'scatter', data: [[1, 2]], symbol: 'image://http://evil.com/x.png' }],
    graphic: [{ type: 'image', style: { image: 'https://evil.com/y.png' } }],
    backgroundColor: { image: 'https://evil.com/z.png' },
  });
  assert.ok(!strings(three.option).join('|').includes('evil.com'), '图表不得加载任何远程图片');
  // title.link / sublink 整键删除:值是同源相对路径也删
  for (const [why, title] of [
    ['顶层 title', { title: { text: 'T', link: '/a', sublink: '/b', target: 'blank' } }],
    ['多标题数组', { title: [{ text: 'A', link: '/a' }, { text: 'B', sublink: '/b' }] }],
    ['baseOption 里的 title', { baseOption: { title: { text: 'B', link: '/x' } }, series: [{ type: 'bar', data: [1] }] }],
  ]) {
    const n = optOf(title);
    const all = JSON.stringify(n.option);
    assert.ok(!/"(sub)?link"/.test(all), `title.link / title.sublink 必须整键删除(${why}):${all}`);
    assert.ok(/"text"/.test(all), `标题文字本身要保留(${why})`);
  }
  assert.ok(optOf({ title: { text: 'T', link: '/a', target: 'blank' } }).option.title.target === 'blank',
    '同层其它字段不许被牵连');
  // 正例:正常图表一个字段都不许丢(只写反例的话,"什么都拒"照样全绿)
  const ok = optOf({
    xAxis: { data: ['1月', '2月'] },
    series: [{ type: 'bar', data: [120, 150] }],
    tooltip: { formatter: '{b}: {c}' },
  });
  assert.deepEqual(ok.option.xAxis.data, ['1月', '2月'], '普通类目轴不许被误杀');
  assert.deepEqual(ok.option.series[0].data, [120, 150], '普通数值数组不许被误杀');
  assert.equal(ok.option.tooltip.formatter, '{b}: {c}', '纯文本 formatter 不许被误杀');
  assert.equal(ok.option.tooltip.renderMode, 'richText', 'tooltip 仍被强制 richText(上游防线不许在这次改动里丢掉)');
}

// ── 8. 补丁 4:assertSafeSvg 正则加严(§5.8 的"绝不渲染未通过校验的 SVG")──────────
{
  const blocked = (svg) => { try { assertSafeSvg(svg); return false; } catch { return true; } };
  for (const [why, svg] of [
    ['上游漏的 <img/onerror=(前置字符类是 / 不在 [\\s"\'] 里)', '<svg><img/onerror=alert(1)></svg>'],
    ['换行分隔的 onerror', '<svg><img\nonerror=alert(1)></svg>'],
    ['带引号的 onclick(上游本来就拦)', '<svg><g onclick="x()"></g></svg>'],
    ['<script', '<svg><script>alert(1)</script></svg>'],
    ['<iframe 走私(替代被否掉的 <foreignObject 那条)', '<svg><foreignObject><iframe src=x></iframe></foreignObject></svg>'],
    ['<object', '<svg><object data=x></object></svg>'],
    ['<embed', '<svg><embed src=x></embed></svg>'],
    ['javascript: 链接', '<svg><a href="javascript:alert(1)">x</a></svg>'],
    ['data:text/html', '<svg><a href="data:text/html,payload">x</a></svg>'],
  ]) {
    assert.equal(blocked(svg), true, `攻击形态必须被拦: ${why}`);
  }
  // 反向那半才是这条的重点:PLAN 原本要补的四个标签 mermaid 自己就输出,补上去等于
  // 把 mermaid 关掉(取证见 mermaid-safe.ts 的注释)。这四条锁死"不许把它们加回来"。
  for (const [why, svg] of [
    ['每张 mermaid 图都自带的 <style>(mermaid.core.mjs:1200-1202 无条件插入)',
      '<svg id="m1"><style>#m1 .node rect{fill:#eee;stroke-width:1px;}</style><g class="node"><rect/></g></svg>'],
    ['flowchart 的 <foreignObject> 标签(htmlLabels 默认开,mermaid 自己加进 DOMPurify 白名单)',
      '<svg><g class="label"><foreignObject width="60" height="24"><div xmlns="http://www.w3.org/1999/xhtml">节点</div></foreignObject></g></svg>'],
    ['<use> / <image>(mermaid 有 3 处 / 9 处输出点)', '<svg><use href="#a"/><image width="10" height="10"/></svg>'],
    ['常见 SVG 属性(marker-end / transform / font-size 不许命中 on…=)',
      '<svg><path marker-end="url(#arrowhead)" transform="translate(1,2)" font-size="12px"/></svg>'],
  ]) {
    assert.equal(blocked(svg), false, `mermaid 的真实产物形态不许被拦(拦了 = 图全灭): ${why}`);
  }
}

// ── 9. 颜色字段:放行契约里的四种形态,其余降级为默认色(§2.7)──────────────────────
{
  // 颜色非法只**降级**(去掉该字段),不丢节点、不计入「已忽略」——与媒体地址那条
  // (被拒就丢整个节点)是两套处置,别混。
  for (const ok of ['#3ecf8e', '#fff', '#ABC', '#11223344', 'rgb(1,2,3)', 'rgba(0,0,0,.2)',
    'hsl(210 40% 50%)', 'hsla(210,40%,50%,.5)', 'var(--color-accent)', 'var(--color-ink)',
    'var(--color-accent, #3ecf8e)']) {
    const r = withSibling({ type: 'avatar', name: 'A', color: ok });
    assert.equal(r.items[0].color, ok, `合法颜色必须原样保留: ${ok}`);
    assert.equal(r.dropped, 0, `颜色合法时不该有任何丢弃: ${ok}`);
  }
  for (const [why, bad] of [
    ['url() 远程图片(外发通道)', 'url(https://evil.com/x.png)'],
    ['image-set()', 'image-set("a.png" 1x)'],
    ['CSS expression', 'expression(alert(1))'],
    ['上游设计系统前缀(模型无从知道,契约也没给)', 'var(--dsw-alias-label-primary)'],
    ['另一个上游前缀', 'var(--dsl-g-bg)'],
    ['任意变量名', 'var(--evil)'],
    ['变量兜底值里藏 url()', 'var(--color-accent, url(https://evil.com/x))'],
    ['带分号的 CSS 注入', '#fff; background: url(https://evil.com/x)'],
    ['命名颜色(不在四种形态里)', 'red'],
    ['非法 hex 字母', '#gggggg'],
    ['hex 只有 2 位', '#12'],
    ['hex 9 位', '#123456789'],
    ['超 64 字符', 'rgba(' + '0,'.repeat(40) + '0)'],
    ['注释穿插', '#ff/*x*/ffff'],
    ['空串', ''],
  ]) {
    const r = withSibling({ type: 'avatar', name: 'A', color: bad });
    assert.ok(r.items[0] && r.items[0].type === 'avatar', `颜色非法只降级,不该丢节点(${why})`);
    assert.equal(r.items[0].color, undefined, `非法颜色必须被去掉(${why})`);
    assert.equal(r.dropped, 0, `颜色降级不计入「已忽略」(${why})`);
  }
  // chart / plot 的序列色走同一个校验:非法项降级,数据点不许跟着丢
  const c = one({ type: 'chart', data: [{ label: 'a', value: 1, color: 'var(--evil)' }] });
  assert.equal(c.data[0].value, 1, '序列色非法不该牵连数据点');
  assert.equal(c.data[0].color, undefined, '序列里的非法颜色同样降级');
}

// ── 10. send 的类型签名与实现/调用点一致(M6b 上报的类型谎言)───────────────────────
{
  const ctx = read('client/src/genui/upstream/action-context.ts');
  assert.ok(/send: \(\s*actionId: string,\s*action: string,\s*payload: Record<string, unknown>,?\s*\)/.test(ctx),
    'send 的签名必须是三参(actionId, action, payload)');
  // .ts/.tsx 不进 tsc 门(vite 只剥类型不检查),签名写错不会被任何构建拦下 ——
  // 只能在这里把"签名 / 实现 / 调用点"三边对齐锁住。
  assert.ok(read('client/src/genui/upstream/GenuiBlock.tsx')
    .includes('capability.send(genuiActionId(stateKey, action), action, payload)'),
  '调用点是三参');
  assert.ok(/send: \(actionId, action, payload\) =>/.test(read('client/src/genui/host/action-context.jsx')),
    '实现是三参');
}

console.log('✅ check-genui-security-patches:缺口 A(未知类型丢弃/预算不被架空)+ 计数口径 + 空卡降级'
  + ' + genui-ignored 灰字 + 缺口 B(密码零出口)+ 缺口 C(媒体/echart 外链、title.link)'
  + ' + mermaid 正则加严(攻击拦住且不误杀 mermaid 自身产物)+ send 三参签名,全部通过');
