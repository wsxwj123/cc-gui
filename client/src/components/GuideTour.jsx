// CK-3: 使用指引。逐个高亮界面功能按钮,下方浮出说明文字。
// 目标元素通过 data-tour="<id>" 定位;找不到的步骤自动跳过(如无项目态 composer 不在 DOM)。
// 左栏是会话列表还是项目列表 → 动态裁剪对应步骤(避免在项目列表讲会话、反之亦然)。
// 顺序按视觉上→下、左→右:顶栏(侧栏开关 → 右簇 Provider/模型/力度/远程/主题/坞 → 坞内
// 分屏+10 面板)→ 会话头(徽章 / ⋮)→ 左栏(列表 / 新建)→ 输入框(composer / 权限 / 附件 / 旁问)
// → help 收尾。附件、旁问各有独立步骤(data-tour=attach/aside 挂 ChatInput 按钮,paneIsActive 门控)。
// 机制:步骤可带 enter(进入该步骤时 dispatch 的 window 事件,支持数组)——
//  · cgui:tour-ensure-draft:无会话时在活跃窗格自动建 draft(App 监听;无项目则不建,步骤自动跳过)
//  · cgui:dock-rail-open:展开顶栏面板坞 rail
// enter 先派发再找锚点(draft/菜单/rail 是异步渲染,给 3×150ms 重试),仍找不到才顺延跳过。
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { X, ArrowRight, ArrowLeft } from 'lucide-react';

// 面板 ×10 平铺(文案沿用),每步 enter=展开 rail(锚点 panel-<id> 仅 rail 展开时在 DOM)。
const PANEL_STEPS = [
  ['panel-files', '文件浏览器', '项目文件树:查看 / 编辑 / 预览文件,右键可把文件添加到对话上下文。', 'cgui:dock-rail-open'],
  ['panel-changes', '文件审查', '按回合查看 AI 改了哪些文件(diff 对比),不满意可一键回滚。', 'cgui:dock-rail-open'],
  ['panel-monitor', 'Subagent 监控', '子代理与后台代理的实时状态,可逐个停止。', 'cgui:dock-rail-open'],
  ['panel-agents', 'Agent 管理', '管理自定义子代理(写入 ~/.claude/agents)。\n· 内置 orchestrator / explorer / oracle / designer / fixer 等预设首次启动已自动安装,在此可查看 / 编辑 / 重装', 'cgui:dock-rail-open'],
  ['panel-usage', '用量统计', 'token / 费用统计,/insights 报告,可导出 CSV。', 'cgui:dock-rail-open'],
  ['panel-processes', '进程管理', '查看并停止正在运行的 claude 子进程。', 'cgui:dock-rail-open'],
  ['panel-mcp', '工具(MCP)', 'MCP 服务器与插件的增删 / 测试 / 安装。', 'cgui:dock-rail-open'],
  ['panel-skills', 'Skill 市场', 'skill 市场导入与本机技能管理。', 'cgui:dock-rail-open'],
  ['panel-memory', 'CLAUDE.md 指令', 'CLAUDE.md 四级指令 / 自动记忆 / 提示词库。', 'cgui:dock-rail-open'],
  // 修正批#7:Provider tab 已删(管理迁顶栏 Provider 卡片底部「管理」弹窗),7 个标签页。
  ['panel-settings', '通用设置', '更新 / 会话 / 环境 / 权限 / Hooks / 网络 / 高级 共 7 个标签页;顶部可搜索设置项。', 'cgui:dock-rail-open'],
];

function buildSteps(hasProject) {
  // 顺序 = 视觉从上到下、从左到右:①顶栏(最左侧栏开关 → 右簇 Provider/模型/力度/
  // 远程/主题/坞 → 坞内分屏+面板)②会话头(徽章 / ⋮)③左栏(列表 / 新建)④输入框
  // (composer → 权限模式 → 附件 → 旁问)⑤help 收尾(重看指引)。
  const steps = [
    // ── ① 顶栏(从左到右)────────────────────────────
    ['sidebar-toggle', '收起 / 展开侧栏', '点这里收起左侧栏腾出空间,再点可展开。'],
    ['provider-selector', 'Provider', '切换 API 服务来源:官方 Anthropic 与第三方中转一键切换,对新发的消息生效。\n· 增删改 / 测试 / 隐藏 / 导入在列表底部「管理 Provider」弹窗'],
    ['model-selector', '模型', '选当前会话使用的具体模型(分屏时作用于聚焦的窗格,每格独立)。\n· 支持 1M 上下文开关、搜索 / 拉取最新模型、手填自定义模型 ID'],
    ['effort-selector', '推理力度', '调 AI 的思考强度:低 / 中 / 高 / 极高 / 极限(分屏时作用于聚焦的窗格)。\n· 越高思考越深入、结果越细致,但越慢、越费 token\n· 官方模型区别明显,部分第三方可能无效'],
    ['remote-control', '远程控制', '用手机 Claude App 同账号接管当前会话(需先发送一条消息创建会话)。\n· 激活后输入框锁定,再点一次收回控制'],
    ['theme-toggle', '主题与外观', '外观相关设置的唯一入口:\n· 明暗 / 配色主题(多套深浅色)、界面字号、对话正文字体\n· AI 思考时的加载动画样式(30 种可选)\n· 聊天模式(折叠思考 / 工具只看对话文本)、对话区背景(纯色 / 图片 / 视频)'],
    ['panel-dock', '设置(面板坞)', '分屏和所有功能面板都收纳在这:点它原位展开面板条,再点任一图标打开对应面板;展开后常驻,再点坞图标(或 Esc)才收起。\n· 快捷键 Cmd/Ctrl+1..9 直达前 9 个面板、0 打开「通用」(面板条收起时同样可用)\n· 有可用更新时图标出现红点,展开后点「更新」直达更新区', 'cgui:dock-rail-open'],
    ['dock-pane', '分屏', '把界面分成 1–6 个窗格,并排同时看和操作多个会话。\n· 每个窗格的模型 / 权限模式 / 力度相互独立\n· Ctrl+Tab 轮换聚焦窗格', 'cgui:dock-rail-open'],
    ...PANEL_STEPS,
    // ── ② 会话头 ────────────────────────────────────
    ['ctx-badge', '会话信息徽章', '本会话的信息中枢:显示上下文占用 xx k / 窗口(百分比),点开看 /context 分项明细并可重新精确计算。\n· 弹层还收纳:当前模型与「曾用」模型史、第三方 provider 标识、工具调用次数、累计 token / 费用 / 缓存命中率\n· 新会话数据未到达时,徽章先显示模型徽章(零态),首个回合后自动切为占用数字'],
    ['session-menu', '会话头 ⋮ 菜单', '更多会话操作收纳在这里:\n· 导出:把当前会话导出为 Markdown(下载到本地或复制到剪贴板)\n· 检查点:Checkpoint 时间线 —— 给工作目录拍快照,可随时回到某个快照并裁剪会话到该时刻\n· 重命名点标题旁铅笔;分叉 / 归档在左侧会话列表 hover 菜单'],
  ];
  // ── ③ 左栏(内容随有无项目切换)──────────────────
  if (hasProject) {
    steps.push(
      ['sidebar-list', '会话列表', '当前项目下的所有会话,点任一条进入。\n· 顶部切「活跃 / 已归档」、搜索会话标题\n· 每条会话可 pin 置顶、归档、删除、分叉(fork 出一条新线)\n· 点标题即可重命名'],
      ['new-session', '新建会话', '在当前项目下开一个新会话(也可按 Cmd/Ctrl+N)。\n· 自动继承上一个会话的推理力度,免得每次重选\n· 旁边的「worktree」按钮在隔离的 git worktree 里开会话,改动不污染当前分支'],
    );
  } else {
    steps.push(
      ['sidebar-list', '项目文件夹列表', '你添加的所有项目文件夹,点任一项进入其会话列表。\n· 每项可 pin 置顶、隐藏、彻底清理该项目的 Claude 状态\n· 顶部可搜索项目 / 会话'],
      ['add-project', '添加项目文件夹', '把一个本地文件夹加进来作为新项目。\n· 点这里弹系统文件夹选择器,或手动粘贴绝对路径'],
    );
  }
  // ── ④ 输入框(底部,从左到右)+ ⑤ help 收尾 ────────
  // composer 系步骤:enter 自动建 draft 会话(无项目态建不出 → 整段自动跳过,末步文案引导重看)。
  steps.push(
    ['composer', '输入框', '对话都从这里开始;下方一排 [权限模式][附件][旁问] 按钮下面逐个介绍。\n· Enter 发送、Shift+Enter 换行;输入 / 打开命令面板;输入 @ 引用文件或其它会话\n· 可拖入图片 / PDF / Office 文件;Cmd/Ctrl+Z 撤销输入\n· AI 回复中再输入会入队;输入框为空按 ↑ 召回最近入队消息;AI 工作中还会出现「转后台」按钮\n· 按 Cmd/Ctrl+/ 打开快捷键速查表', 'cgui:tour-ensure-draft'],
    ['mode-selector', '权限模式', '控制 AI 执行动作前是否询问你(按会话独立记忆;窄窗口下只显图标):\n· 逐步确认:每次编辑 / 命令 / 网络前都询问,只读直接执行\n· 接受编辑:文件编辑直接执行,其它命令仍询问\n· 规划:只读研究并给出计划,你批准后自动切到执行档\n· 自动:后台安全分类器逐动作审查,通过即执行(仅官方 Anthropic 端点显示)\n· 放任:跳过全部权限检查(危险,仅建议隔离环境)', 'cgui:tour-ensure-draft'],
    ['attach', '附件 / 文件导入', '把图片、PDF 或任意文件加进本条消息,发送后 AI 能读取其内容。\n· 也可直接把文件拖进输入框,或在左侧「文件浏览器」面板里右键把文件加到对话上下文\n· 图片可单击放大;编辑重发时原附件会恢复成可删除的卡片', 'cgui:tour-ensure-draft'],
    ['aside', '旁问', '不打断当前工作、不写入会话历史的临时提问 —— AI 正忙时你想单独问点别的(查个用法、解释一段代码),点这里弹出旁问框,答完即走,不影响主线对话。\n· 有未读回答时按钮右上角显示角标\n· 旁问窗口可拖动;分屏变窄时会自动吸附到边界不被挡住', 'cgui:tour-ensure-draft'],
    ['help', '快捷键速查 & 重看指引', '随时按 Cmd/Ctrl+/ 打开【快捷键速查表】,里面列了发送、切会话、切分屏窗格、面板直达等全部快捷键。\n· 以后忘了哪个功能,点这个问号就能重新走一遍本指引' + (hasProject ? '。' : ';添加项目后重看,可看到输入框一排开关的完整介绍。')],
  );
  // enter(可选)= 进入该步骤时 dispatch 的 window 事件名(字符串或数组)。
  return steps.map(([sel, title, desc, enter]) => ({ sel, title, desc, enter }));
}

const TIP_W = 300;
const findEl = (sel) => {
  const el = document.querySelector(`[data-tour="${sel}"]`);
  return (el && el.getBoundingClientRect().width > 0) ? el : null;
};
const fireEnter = (step) => {
  if (!step?.enter) return false;
  for (const ev of [].concat(step.enter)) window.dispatchEvent(new CustomEvent(ev));
  return true;
};

export function GuideTour({ open, onClose, hasProject }) {
  const steps = useMemo(() => buildSteps(hasProject), [hasProject]);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const [pos, setPos] = useState(null);     // 说明卡定位 {top,left},经实测夹取后才显
  const overlayRef = useRef(null);
  const tipRef = useRef(null);
  // 问号导引 = 纯逐步(下一步/上一步),高亮【不随鼠标动】,逐个介绍界面功能。

  // 开:回到第 1 步(rect 由下面的定位 effect 设)。关:清残留 rect/pos —— 否则下次重开
  // 的首帧会用到上一轮的旧 i/rect,而 steps 长度随 hasProject 变,旧 i 越界 →
  // steps[i] 为 undefined → 渲染抛错整页白屏(用户报:返回初始界面再点指引白屏)。
  useEffect(() => {
    if (open) setI(0);
    // 关闭指引时收起被 panel 步骤展开的坞 rail(坞持久化后不再点外部自动收 → 否则残留占顶栏)。
    else { setRect(null); setPos(null); window.dispatchEvent(new CustomEvent('cgui:dock-rail-close')); }
  }, [open]);

  // 定位当前步骤目标。P2.6:先派发 enter(建 draft/开菜单/开 rail 都是异步渲染),
  // 给 3×150ms 重试等锚点出现;仍找不到才顺延到下一个有效步骤,全部找不到则结束。
  useLayoutEffect(() => {
    if (!open) return;
    const step = steps[i];
    if (!step) { onClose(); return; }
    fireEnter(step);
    let cancelled = false;
    let tries = 0;
    let retryTimer = null;
    const resolve = () => {
      if (cancelled) return;
      const el = findEl(step.sel);
      if (!el) {
        if (tries < 3) { tries++; retryTimer = setTimeout(resolve, 150); return; }
        // 锚点确实不在(如无项目态的 composer 系步骤)→ 顺延到下一个存在的步骤。
        let idx = i + 1;
        while (idx < steps.length && !findEl(steps[idx].sel) && !steps[idx].enter) idx++;
        if (idx >= steps.length) { onClose(); return; }
        setI(idx);
        return;
      }
      el.scrollIntoView({ block: 'nearest' });
      setRect(el.getBoundingClientRect());
    };
    resolve();
    const update = () => { const el = findEl(step.sel); if (el) setRect(el.getBoundingClientRect()); };
    // enter 引发的展开动画落定后补量一次高亮框。
    const remeasure = step.enter ? setTimeout(update, 320) : null;
    window.addEventListener('resize', update);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', update);
      if (retryTimer) clearTimeout(retryTimer);
      if (remeasure) clearTimeout(remeasure);
    };
  }, [open, i, steps, onClose]);

  // 说明卡定位。关键:<html> 有 font-scale `zoom`(如 1.2),getBoundingClientRect 返回
  // 的是缩放后的实际像素,而写进 style 的 top/left 会被浏览器再 ×zoom 渲染 —— 直接拿
  // rect 值当 style 用会二次放大、大坐标处溢出。所以:先在「实际像素」空间夹取(目标下方/
  // 上方/贴边),最后把结果 ÷zoom 还原成 style 值。测完才显(避免闪现)。
  useLayoutEffect(() => {
    if (!open || !rect || !overlayRef.current || !tipRef.current) return;
    const vp = overlayRef.current.getBoundingClientRect(); // 视口(实际像素)
    const zoom = vp.width / (overlayRef.current.offsetWidth || vp.width) || 1;
    const tip = tipRef.current.getBoundingClientRect();    // 卡片实际尺寸
    const M = 10;
    const left = Math.max(vp.left + M, Math.min(rect.left, vp.right - tip.width - M));
    let top;
    if (rect.bottom + M + tip.height <= vp.bottom - M) top = rect.bottom + M;
    else if (rect.top - M - tip.height >= vp.top + M) top = rect.top - M - tip.height;
    else top = Math.max(vp.top + M, vp.bottom - tip.height - M);
    setPos({ top: top / zoom, left: left / zoom, zoom });
  }, [open, rect, i]);

  // 兜底看门狗:目标元素中途消失(rail 被点收起 / 布局变化)时 rect/pos 残留,全屏遮罩
  // 会把整页锁死(preview 实测过"顶栏全点不动")。定期验证当前目标仍在且可见:
  //  · 失效且该步带 enter → 先重派 enter(重开 rail/菜单)给两轮机会,不立即跳过;
  //  · 仍失效 / 无 enter → 顺延到下一个有效步骤,全部无效直接结束 tour。
  // 失败方向 = 宁可结束指引也不能锁死界面。
  const missRef = useRef(0);
  useEffect(() => { missRef.current = 0; }, [i, open]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      const step = steps[i];
      if (!step) { onClose(); return; }
      if (findEl(step.sel)) { missRef.current = 0; return; }
      missRef.current++;
      if (missRef.current <= 2 && fireEnter(step)) return; // 重开展开态,下一轮再验
      let idx = i + 1;
      while (idx < steps.length && !findEl(steps[idx].sel) && !steps[idx].enter) idx++;
      if (idx >= steps.length) onClose();
      else setI(idx);
    }, 600);
    return () => clearInterval(timer);
  }, [open, i, steps, onClose]);

  const step = steps[i];
  // !step 兜底:tour 开着时 hasProject 变化使 steps 变短、i 越界 → 不渲染(定位 effect 会纠正 i)。
  if (!open || !rect || !step) return null;
  const last = i === steps.length - 1;
  const pad = 6;
  // 高亮框同样要 ÷zoom(style 值会被 ×zoom 渲染),否则下方/右侧元素的圈会整体偏移。
  const z = pos?.zoom || 1;
  const spot = { top: (rect.top - pad) / z, left: (rect.left - pad) / z, width: (rect.width + pad * 2) / z, height: (rect.height + pad * 2) / z };

  return (
    // 根容器 pointer-events-none:遮罩是否拦截由下面的点击层单独控制,
    // 说明卡未定位完成(pos 为空 = 卡片不可见)时不拦任何点击,防锁死。
    <div ref={overlayRef} className="fixed inset-0 z-[400] pointer-events-none">
      {/* 高亮框 + 四周压暗(box-shadow 撑满屏) */}
      <div style={{ position: 'fixed', ...spot, borderRadius: 10, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', transition: 'top .15s, left .15s, width .15s, height .15s' }}
        className="ring-2 ring-accent pointer-events-none" />
      {/* 点暗区跳过 —— 只在说明卡真实可见时才拦截整页点击 */}
      {pos && <div className="absolute inset-0 pointer-events-auto" onClick={onClose} />}
      {/* 说明卡 */}
      <div ref={tipRef} style={{ position: 'fixed', width: TIP_W, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden', zIndex: 5 }}
        className="bg-canvas border border-canvas-deep rounded-xl shadow-2xl p-4 animate-glass-rise pointer-events-auto">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[13px] font-display font-semibold text-ink flex-1">{step.title}</span>
          <span className="text-[10px] text-ink-faint font-mono shrink-0">{i + 1}/{steps.length}</span>
          <button onClick={onClose} className="text-ink-faint hover:text-ink shrink-0" title="关闭指引"><X size={14} /></button>
        </div>
        <div className="text-[12px] text-ink-muted font-body leading-relaxed mb-3 whitespace-pre-line">{step.desc}</div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-[11px] text-ink-faint hover:text-ink mr-auto">跳过</button>
          {i > 0 && (
            <button onClick={() => setI(i - 1)}
              className="px-2 py-1 text-[11px] rounded border border-canvas-deep text-ink-soft hover:bg-canvas-deep flex items-center gap-1">
              <ArrowLeft size={11} />上一步
            </button>
          )}
          <button onClick={() => (last ? onClose() : setI(i + 1))}
            className="px-2.5 py-1 text-[11px] rounded bg-accent text-on-accent hover:bg-accent/90 flex items-center gap-1">
            {last ? '完成' : <>下一步<ArrowRight size={11} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
