// r11-②:Home(首页新建会话形态)的纯函数层。
// UI(App.jsx HomeState)只消费这里的输出;单测 tests/unit/check-home-state.mjs 钉住
// 显隐判定矩阵、项目选择(cwd 绑定)与 draft 创建参数。

/**
 * 主区形态判定:
 *  - 有选中会话 → 'session'(正常会话页);
 *  - 无选中会话且有项目 → 'home'(图标+称呼+输入框);
 *  - 无选中会话且零项目 → 'empty'(既有「添加一个项目开始」EmptyState)。
 */
export function homeView({ hasSession, projectCount }) {
  if (hasSession) return 'session';
  return (projectCount || 0) > 0 ? 'home' : 'empty';
}

/**
 * r29:SplitMain 窗格内容门控。e924a45 把新建入口从「写 draft」改成「写 null」后,
 * 旧门控 (soloPane || hasSession) 让 null 会话窗格永远挂静态占位,Home 进不来 ——
 * 分屏下聚焦空白窗格点「+」不落会话。
 * 口径:聚焦的空窗格也挂 SessionDetail(走上面的 homeView 判定进 Home);
 * 未聚焦的空窗格保留静态占位(「点左侧任一会话填入本分屏」),别把两个窗格都变成 Home。
 */
export function paneMountsSessionDetail({ soloPane, hasSession, focused }) {
  return !!(soloPane || hasSession || focused);
}

/**
 * Home 的目标项目解析:用户显式选择(chosenHash)优先 → 聚焦窗格的会话所属项目 →
 * 侧栏选中项目 → 最近活动项目;都没有 → null(Home 禁发)。
 *
 * r24:新增 focusedProjectHash(聚焦窗格当前会话的 projectHash)且压过 selectedProject。
 * selectedProject 是**侧栏**的选中项 —— 分屏时点开 B 窗格看项目 P 的会话并不改它,侧栏
 * 还停在 Q,新建会话就落到了你没在看的目录里(用户报的正是这个)。
 * 容错口径与 selectedProject 那支**故意不同**:那支在列表暂缺时还能拿 selectedProject.path
 * 兜底,而这里只有一个 hash、凑不出 buildHomeDraft 必需的 cwd(path),所以命中不了就直接
 * 往下走(交给 selectedProject / 最近活动),绝不凭空造项目。
 */
export function pickHomeProject({ chosenHash, focusedProjectHash, projects, selectedProject } = {}) {
  const list = Array.isArray(projects) ? projects.filter((p) => p && p.hash && p.path) : [];
  if (chosenHash) {
    const hit = list.find((p) => p.hash === chosenHash);
    if (hit) return hit;
  }
  if (focusedProjectHash) {
    const focused = list.find((p) => p.hash === focusedProjectHash);
    if (focused) return focused;
  }
  if (selectedProject?.hash) {
    const sel = list.find((p) => p.hash === selectedProject.hash);
    if (sel) return sel;
    if (selectedProject.path) return selectedProject; // 选中但列表暂缺(fetch 未到)也可用
  }
  if (!list.length) return null;
  return [...list].sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : -1;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : -1;
    return tb - ta;
  })[0];
}

/**
 * r21/r23:GET /api/prefs/hidden-projects 的响应 → hash Set。
 * 读失败/字段缺失/类型不对一律回落**空 Set(不过滤)**,绝不能变成"全过滤"(Home 会
 * 变成没有项目可选的死输入框)。响应字段名 `hidden` 是与服务端的契约,写在这里让它
 * 被行为单测钉住 —— 原来这一句埋在 App.jsx 的 .then 里,字段改名 → d?.hidden 恒
 * undefined → 过滤彻底失效,而对源码做正则的断言照样全绿。
 */
export function readHiddenHashes(payload) {
  return new Set(Array.isArray(payload?.hidden) ? payload.hidden.filter((x) => typeof x === 'string' && x) : []);
}

/**
 * Home 可选项目列表:减去被隐藏的项目(默认项目会写进新会话 cwd,家目录/临时目录
 * 这类被用户隐藏的不该当上默认);全被隐藏时回落全量,不把 Home 变成死输入框。
 *
 * r25:exemptHash(聚焦窗格的项目)豁免 hidden —— 与侧栏 composePanelProjects 的 panes
 * 豁免同一口径:「正在窗格里打开的项目即使被隐藏,那一行也照常在」。少了这一口,用户
 * 隐藏了自己正开着的项目 P 之后,P 先在这里被滤掉 → pickHomeProject 的聚焦分支永远
 * 命中不了 → 新建会话又开回侧栏选中的另一个目录(r24 立项要修的正是这个抱怨)。
 * 「全隐藏 → 回落全量」保持原样:有豁免项时 vis 非空(=只剩它,与侧栏同口径),
 * 没有豁免项时才回落全量。
 */
export function visibleHomeProjects(projects, hiddenHashes, exemptHash) {
  const all = Array.isArray(projects) ? projects : [];
  const hidden = hiddenHashes instanceof Set ? hiddenHashes : new Set(hiddenHashes || []);
  const vis = all.filter((p) => !hidden.has(p?.hash) || (!!exemptHash && p?.hash === exemptHash));
  return vis.length ? vis : all;
}

/**
 * Home 发送 → draft 会话参数(cwd 绑定所选项目;与侧栏 handleNew 的 draft 同构)。
 * draftId 由调用方传入(App.jsx newDraftId,保持 nonce 语义单一来源)。
 */
export function buildHomeDraft(project, draftId) {
  if (!project?.hash || !project?.path) return null;
  return {
    draft: true,
    draftId,
    sessionId: null,
    projectHash: project.hash,
    projectPath: project.path,
    firstPrompt: '新会话',
  };
}

/**
 * 皮肤自定义读取接口(占位):r11-③ 皮肤系统接管数据来源后往
 * window.__cguiHomeCustom 写 { icon?: string(资源 URL), greeting?: string }。
 * 当前无皮肤 → null,Home 用内置默认。
 */
export function readHomeCustom() {
  try {
    const c = (typeof window !== 'undefined' && window.__cguiHomeCustom) || null;
    return c && typeof c === 'object' ? c : null;
  } catch { return null; }
}

/** 时段词(内置问候共用)。 */
function timeWord(hour) {
  if (hour >= 5 && hour < 12) return '早上好';
  if (hour >= 12 && hour < 18) return '下午好';
  return '晚上好';
}

// r11-⑫:无称呼时 {name} 占位符整段优雅降级——连同紧邻分隔符一起摘除,
// 两侧都有分隔时保留后侧一枚(「A，{name}，B」→「A，B」),不留孤立标点。
const NAME_SEG_RE = /([\s，,、·:：]*)\{name\}([\s，,、·:：]*)/g;
function degradeNameSegments(tpl) {
  return tpl.replace(NAME_SEG_RE, (_, pre, post) => (pre && post ? post : '')).trim();
}

/**
 * 问候分段(hour, custom, name)→ [{ text, name?: true }]:
 *  - custom = 皮肤 home.greeting 模板(≤60,r11-③ 接管数据来源),支持 {name} 占位符;
 *    无称呼时占位符整段优雅降级,降级后为空则回落内置默认;
 *  - 无 custom:有称呼 →「{时段词}，{称呼}」,无称呼 → 现状文案「{时段词}，从这里开始」;
 *  - name 段单独成段(name:true),UI 用主题 accent 色渲染(精致化,不硬编码色值)。
 */
export function homeGreetingParts(hour, custom, name) {
  const n = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  const c = typeof custom === 'string' ? custom.trim().slice(0, 60) : '';
  if (c) {
    if (!c.includes('{name}')) return [{ text: c }];
    if (!n) {
      const degraded = degradeNameSegments(c);
      return degraded ? [{ text: degraded }] : homeGreetingParts(hour, null, '');
    }
    const parts = [];
    const segs = c.split('{name}');
    segs.forEach((s, i) => {
      if (s) parts.push({ text: s });
      if (i < segs.length - 1) parts.push({ text: n, name: true });
    });
    return parts.length ? parts : homeGreetingParts(hour, null, n);
  }
  const t = timeWord(hour);
  if (!n) return [{ text: `${t}，从这里开始` }];
  return [{ text: `${t}，` }, { text: n, name: true }];
}

/**
 * 称呼:皮肤自定义(home.greeting)优先,否则按时段给内置默认;第三参为用户称呼
 * (prefs.displayName,r11-⑫)。纯文本口径 = homeGreetingParts 拼接,两口径恒一致。
 */
export function homeGreeting(hour, custom, name) {
  return homeGreetingParts(hour, custom, name).map((p) => p.text).join('');
}
