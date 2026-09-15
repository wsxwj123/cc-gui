// r11-③:稳定锚点层 —— 核心 chrome 元素的 data-cgui 语义锚点清单(首批 40)。
// 承诺跨版本稳定:T2 皮肤/开发者样式靠 [data-cgui="…"] 选择器定位,不挂 Tailwind
// 类名(类名随重构随时变);锚点改名必须走废弃期(旧名保留一个大版本)。
// 本清单是唯一权威源:提示词生成器与文档从这里取;单测钉「清单内全部有挂点、
// 源码内 data-cgui 不越清单」双向闭合。
export const SKIN_ANCHORS = [
  // ── 布局骨架 ──
  { id: 'topbar', desc: '桌面顶栏(header)' },
  { id: 'topbar-mobile', desc: '手机顶栏(header)' },
  { id: 'sidebar', desc: '左侧项目/会话面板根' },
  { id: 'sidebar-search', desc: '侧栏搜索输入框' },
  { id: 'panel-dock', desc: '右侧面板坞按钮组' },
  { id: 'artifact-dock', desc: '代码/预览停靠面板根' },
  // ── 项目/会话列表 ──
  { id: 'project-row', desc: '项目行(项目页)' },
  { id: 'session-row', desc: '会话行' },
  { id: 'session-actions', desc: '会话行 hover 操作组' },
  // r13-①备案:drill-back(会话页「返回项目列表」行)随钻入两页退役而删除。
  // T2 皮肤若引用 [data-cgui="drill-back"] 只是选择器落空,不炸。
  { id: 'add-project-btn', desc: '添加项目按钮' },
  { id: 'new-session-btn', desc: '新建会话按钮' },
  { id: 'new-worktree-btn', desc: '新建 worktree 按钮' },
  // ── 输入区 ──
  { id: 'composer', desc: '输入区容器' },
  { id: 'composer-input', desc: '消息输入框(textarea)' },
  { id: 'send-btn', desc: '发送按钮' },
  { id: 'stop-btn', desc: '停止生成按钮' },
  { id: 'queue-btn', desc: '流式中入队按钮' },
  { id: 'stop-background-btn', desc: '停止后台子代理按钮' },
  { id: 'attach-btn', desc: '附件按钮' },
  { id: 'aside-btn', desc: '旁问按钮' },
  { id: 'mode-selector', desc: '权限模式选择器' },
  { id: 'effort-selector', desc: '思考力度选择器' },
  { id: 'model-selector', desc: '模型选择器' },
  { id: 'provider-selector', desc: 'Provider 切换器' },
  // ── 会话头/徽章 ──
  { id: 'badge-context', desc: '上下文占用徽章' },
  { id: 'session-menu', desc: '会话 ⋮ 菜单按钮组' },
  { id: 'theme-btn', desc: '主题按钮(顶栏)' },
  { id: 'settings-btn', desc: '设置入口按钮' },
  // ── 消息区 ──
  { id: 'message-list', desc: '消息滚动列表' },
  { id: 'message-user', desc: '用户消息气泡' },
  { id: 'message-assistant', desc: 'AI 回复气泡容器' },
  // R10:CLI 后台任务通知(harness 喂给模型的 <task-notification> 信封)在转写里的两种落盘
  // 形态被投影成同一行系统提示 —— 与 message-user/message-assistant 同级的消息行类型,
  // 永久留在历史里(不是转瞬即逝的提示)。通知行不存在时选择器落空不炸。
  { id: 'task-notice', desc: '后台任务通知行(CLI task-notification 信封投影成的系统提示行)' },
  // R42:轮末/消息用量行里的金额元素(两处渲染点 TurnBubble/MessageBubble 各一个),
  // 价格来源词挂在它的 title 上(窄面板下不再用行内文字占宽)。
  { id: 'usage-amount', desc: '用量行金额(悬停 title 首行 = 价格来源)' },
  // R43:轮末/消息用量行的行容器(两处渲染点各一个),token 明细(缓存命中/缓存写入/
  // 本轮累计读取/整轮命中率)收在它的 title 上 —— 行内只留 输入/输出/金额。
  { id: 'usage-line', desc: '用量行行容器(悬停 title = token 明细:缓存命中/缓存写入/本轮累计读取/整轮命中率)' },
  { id: 'turn-scrubber', desc: '右缘回合刻度条' },
  { id: 'chat-search', desc: '会话内搜索条' },
  { id: 'todo-panel', desc: '待办清单面板' },
  { id: 'goal-bar', desc: 'goal 常驻条(composer 上方)' },
  { id: 'goal-edit', desc: 'goal 常驻条「编辑」按钮' },
  { id: 'goal-clear', desc: 'goal 常驻条「清除」按钮' },
  { id: 'agent-monitor', desc: '子代理监控面板' },
  // R11/R12:子代理会话视图(在母会话之上展开的只读面)根容器 —— 同一个容器上还挂着
  // 合同身份 data-parent-session-id / data-tool-use-id。
  { id: 'subagent-view', desc: '子代理会话视图根(覆盖在母会话之上的只读面)' },
  { id: 'permission-card', desc: '权限确认卡片' },
  // r64:模型生成界面(genui 围栏)。挂在渲染成功的块根上,与 data-testid="genui-block"
  // 同一个元素(INTERFACE r64 §9.0);围栏退回代码块时整个块不存在,选择器落空不炸。
  { id: 'genui-block', desc: '模型生成界面块(genui 围栏渲染成功时的根容器)' },
  // ── Home ──
  { id: 'home', desc: 'Home(无会话首页)容器' },
  { id: 'home-greeting', desc: 'Home 问候标题' },
  { id: 'home-input', desc: 'Home 输入框' },
];

export const SKIN_ANCHOR_IDS = SKIN_ANCHORS.map((a) => a.id);
