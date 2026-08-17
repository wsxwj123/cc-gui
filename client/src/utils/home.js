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
 * Home 的目标项目解析:用户显式选择(chosenHash)优先 → 当前选中项目 →
 * 最近活动项目 → 列表首个;都没有 → null(Home 禁发)。
 */
export function pickHomeProject({ chosenHash, projects, selectedProject } = {}) {
  const list = Array.isArray(projects) ? projects.filter((p) => p && p.hash && p.path) : [];
  if (chosenHash) {
    const hit = list.find((p) => p.hash === chosenHash);
    if (hit) return hit;
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

/**
 * 称呼:皮肤自定义(home.greeting,≤60 字符,r11-③ 接管数据来源)优先,
 * 否则按时段给内置默认。custom 传 null/空 = 无皮肤。
 */
export function homeGreeting(hour, custom) {
  const c = typeof custom === 'string' ? custom.trim() : '';
  if (c) return c.slice(0, 60);
  if (hour >= 5 && hour < 12) return '早上好，从这里开始';
  if (hour >= 12 && hour < 18) return '下午好，从这里开始';
  return '晚上好，从这里开始';
}
