// CK-3: 使用指引。逐个高亮界面功能按钮,下方浮出说明文字。
// 目标元素通过 data-tour="<id>" 定位;找不到的步骤自动跳过(如分屏/远程在某些态不渲染)。
// 左栏是会话列表还是项目列表 → 动态裁剪对应步骤(避免在项目列表讲会话、反之亦然)。
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { X, ArrowRight, ArrowLeft } from 'lucide-react';

// 顶栏功能面板按钮(与 PANEL_MAP 同序)。逐个圈。
const PANEL_STEPS = [
  ['panel-files', '文件浏览器', '浏览项目文件;html/svg 可侧边停靠放大查看。'],
  ['panel-changes', '文件审查', '按回合查看 AI 改了哪些文件,可逐个回滚。'],
  ['panel-monitor', 'Subagent 监控', '实时看子代理(Task)的状态树,可逐个停止。'],
  ['panel-agents', '自定义 Agent', '在 GUI 内增删改 ~/.claude/agents 下的子代理定义。'],
  ['panel-usage', '用量统计', '按模型/项目/日期看 token 与费用,可导出 CSV。'],
  ['panel-processes', '进程管理', '查看并停止正在运行的 claude 子进程。'],
  ['panel-mcp', 'MCP 服务器', '增删 MCP、测连通性、一键装官方插件。'],
  ['panel-skills', 'Skill 市场', '看本机已装 skill,一键导入 Anthropic 官方 skill。'],
  ['panel-memory', 'CLAUDE.md 指令', '编辑全局/项目/本地三级 CLAUDE.md 指令。'],
  ['panel-settings', '设置', '网络/密码/端口/存储/更新/Hooks 等。'],
];

function buildSteps(hasProject) {
  const steps = [
    ['sidebar-toggle', '收起 / 展开侧栏', '点这里收起左侧栏腾出空间,再点可展开。'],
  ];
  if (hasProject) {
    steps.push(
      ['sidebar-list', '会话列表', '当前项目下的所有会话,点任一条进入。上方可切「活跃 / 已归档」。'],
      ['new-session', '新建会话', '在当前项目下开新会话(也可按 Cmd/Ctrl+N)。'],
      ['new-worktree', 'worktree 隔离会话', '在新的 git worktree 里开会话,改动与主工作区隔离。'],
    );
  } else {
    steps.push(
      ['sidebar-list', '项目文件夹列表', '你的项目文件夹。点任一项进入该项目的会话列表。'],
      ['add-project', '添加项目文件夹', '把一个本地文件夹加进来作为新项目。'],
    );
  }
  steps.push(
    ['provider-switcher', '切换 Provider', '在官方 Anthropic 与第三方中转(DeepSeek/MiMo 等)间一键切换。'],
    ['model-selector', '模型', '选当前会话使用的模型。'],
    ['effort-selector', '推理力度', '调思考强度(低→高),越高越细但越慢/越贵。'],
    ['permission-selector', '权限模式', '默认 / 接受编辑 / 规划 / 放行,控制工具调用是否需你确认。'],
    ['agent-selector', '子代理模式', '让主控把任务派给子代理执行。'],
    ['remote-control', '手机远程控制', '用手机 Claude App 同账号接管此会话(需登录、非三方 provider)。'],
    ['pane-count', '分屏', '把界面分成 1–6 格,并排看多个会话。'],
    ...PANEL_STEPS,
    ['composer', '输入框', 'Cmd/Ctrl+Enter 发送、Enter 换行;输入 / 打开命令;可拖入图片/PDF;Cmd/Ctrl+Z 撤销输入。'],
  );
  return steps.map(([sel, title, desc]) => ({ sel, title, desc }));
}

const TIP_W = 300;

export function GuideTour({ open, onClose, hasProject }) {
  const steps = useMemo(() => buildSteps(hasProject), [hasProject]);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const [pos, setPos] = useState(null);     // 说明卡定位 {top,left},经实测夹取后才显
  const overlayRef = useRef(null);
  const tipRef = useRef(null);

  // 开:回到第 1 步(rect 由下面的定位 effect 设)。关:清残留 rect/pos —— 否则下次重开
  // 的首帧会用到上一轮的旧 i/rect,而 steps 长度随 hasProject 变(有项目 22 步 / 无项目 21 步),
  // 旧 i 越界 → steps[i] 为 undefined → 渲染抛错整页白屏(用户报:返回初始界面再点指引白屏)。
  useEffect(() => {
    if (open) setI(0);
    else { setRect(null); setPos(null); }
  }, [open]);

  // 定位当前步骤目标;找不到就顺延到下一个有效步骤,全部找不到则结束。
  useLayoutEffect(() => {
    if (!open) return;
    let idx = i, el = null;
    while (idx < steps.length) {
      el = document.querySelector(`[data-tour="${steps[idx].sel}"]`);
      if (el && el.getBoundingClientRect().width > 0) break;
      el = null; idx++;
    }
    if (!el) { onClose(); return; }
    if (idx !== i) { setI(idx); return; }
    el.scrollIntoView({ block: 'nearest' });
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
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

  const step = steps[i];
  // !step 兜底:tour 开着时 hasProject 变化使 steps 变短、i 越界 → 不渲染(定位 effect 会纠正 i)。
  if (!open || !rect || !step) return null;
  const last = i === steps.length - 1;
  const pad = 6;
  // 高亮框同样要 ÷zoom(style 值会被 ×zoom 渲染),否则下方/右侧元素的圈会整体偏移。
  const z = pos?.zoom || 1;
  const spot = { top: (rect.top - pad) / z, left: (rect.left - pad) / z, width: (rect.width + pad * 2) / z, height: (rect.height + pad * 2) / z };

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[400]">
      {/* 高亮框 + 四周压暗(box-shadow 撑满屏) */}
      <div style={{ position: 'fixed', ...spot, borderRadius: 10, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', transition: 'top .15s, left .15s, width .15s, height .15s' }}
        className="ring-2 ring-accent pointer-events-none" />
      {/* 点暗区跳过 */}
      <div className="absolute inset-0" onClick={onClose} />
      {/* 说明卡 */}
      <div ref={tipRef} style={{ position: 'fixed', width: TIP_W, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        className="bg-canvas border border-canvas-deep rounded-xl shadow-2xl p-4 animate-glass-rise">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[13px] font-display font-semibold text-ink flex-1">{step.title}</span>
          <span className="text-[10px] text-ink-faint font-mono shrink-0">{i + 1}/{steps.length}</span>
          <button onClick={onClose} className="text-ink-faint hover:text-ink shrink-0" title="关闭指引"><X size={14} /></button>
        </div>
        <div className="text-[12px] text-ink-muted font-body leading-relaxed mb-3">{step.desc}</div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-[11px] text-ink-faint hover:text-ink mr-auto">跳过</button>
          {i > 0 && (
            <button onClick={() => setI(i - 1)}
              className="px-2 py-1 text-[11px] rounded border border-canvas-deep text-ink-soft hover:bg-canvas-deep flex items-center gap-1">
              <ArrowLeft size={11} />上一步
            </button>
          )}
          <button onClick={() => (last ? onClose() : setI(i + 1))}
            className="px-2.5 py-1 text-[11px] rounded bg-accent text-white hover:bg-accent/90 flex items-center gap-1">
            {last ? '完成' : <>下一步<ArrowRight size={11} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
