// 使用指引(spotlight 式):点问号后,半透明遮罩压暗全屏、【挖空所有功能按钮让它们亮
// 起来】(真高亮,不是描边框),每个按钮的说明框直接铺在下方留白区、用连线接回对应
// 按钮 —— 全部一次显示、无需悬停或点击。左栏是会话/项目列表 → 动态裁剪对应说明。
import { useMemo, useState, useLayoutEffect } from 'react';
import { X } from 'lucide-react';

// 顶栏功能面板按钮的说明(含二级菜单)。
const PANEL_STEPS = [
  ['panel-files', '文件', '· 浏览项目文件树、点开预览\n· html/svg 可侧边停靠放大\n· 图片/PDF/Office 直接预览'],
  ['panel-changes', '审查', '· 按 AI 回合看改了哪些文件\n· 逐个文件看 diff\n· 可按回合回滚'],
  ['panel-monitor', '监控', '· 子代理(Task)状态树\n· 后台代理:派发/查看/停止'],
  ['panel-agents', 'Agent', '· 增删改 ~/.claude/agents 子代理\n· 一键装内置预设'],
  ['panel-usage', '用量', '· 按模型/项目/日期看 token 与费用\n· 缓存命中率\n· 生成报告、导出 CSV'],
  ['panel-processes', '进程', '· 查看运行中的 claude 子进程\n· 逐个停止'],
  ['panel-mcp', '工具', '· 增删 MCP、测连通性\n· 装插件(未装项收进「添加」)'],
  ['panel-skills', '技能', '· 本机已装 skill\n· 一键导入官方与社区 skill 市场'],
  ['panel-memory', '指令', '· CLAUDE.md 四级指令\n· AI 自动记忆\n· 提示词库:780 条预设,分类折叠+搜索+复制到输入框/CLAUDE.md'],
  ['panel-settings', '设置', '· 概览:更新、缓存优化、自动压缩窗口、对话区背景\n· 环境/Hooks/原始配置/存储\n· 网络:开局域网+Tailscale 内网穿透→手机浏览器访问整个 GUI(与「远程」按钮不同,那个是手机 App 接管单会话)'],
];

function buildSteps(hasProject) {
  const steps = [
    ['sidebar-toggle', '收起 / 展开侧栏', '收起左侧栏腾空间,再点展开。'],
  ];
  if (hasProject) {
    steps.push(
      ['sidebar-list', '会话列表', '当前项目的所有会话,点任一条进入;上方切「活跃/已归档」。'],
      ['new-session', '新建会话', '当前项目下开新会话(Cmd/Ctrl+N)。'],
      ['new-worktree', 'worktree 会话', '在新 git worktree 里开会话,改动与主工作区隔离。'],
    );
  } else {
    steps.push(
      ['sidebar-list', '项目列表', '你的项目文件夹,点任一项进入其会话列表。'],
      ['add-project', '添加项目', '把本地文件夹加进来作为新项目。'],
    );
  }
  steps.push(
    ['provider-switcher', '切换 Provider', '官方 Anthropic 与第三方中转(DeepSeek/Gemini 等)一键切换;添加时选内置预设填 key 即用。'],
    ['model-selector', '模型', '选当前会话的模型。'],
    ['effort-selector', '推理力度', '思考强度(低→高),越高越细但越慢/贵。'],
    ['permission-selector', '权限模式', '默认/接受编辑/规划/放行,控制工具调用是否需确认。'],
    ['agent-selector', '子代理模式', '让主控把任务派给子代理执行。'],
    ['remote-control', '手机远程', '手机 Claude App 同账号接管此会话(与「设置·网络」不同,后者是手机访问整个 GUI)。'],
    ['pane-count', '分屏', '界面分 1–6 格,并排看多个会话。'],
    ...PANEL_STEPS,
    ['theme-toggle', '主题与外观', '· 配色主题(深浅色)\n· 界面/正文字号\n· 加载动画样式'],
    ['composer', '输入框', 'Cmd/Ctrl+Enter 发送、Enter 换行;/ 打开命令;可拖入图片/PDF/Office;Cmd/Ctrl+Z 撤销。'],
  );
  return steps.map(([sel, title, desc]) => ({ sel, title, desc }));
}

export function GuideTour({ open, onClose, hasProject }) {
  const steps = useMemo(() => buildSteps(hasProject), [hasProject]);
  const [items, setItems] = useState([]);
  const [dims, setDims] = useState({ vw: 1280, vh: 800 });

  // 测量所有 data-tour 元素(逻辑 px:getBoundingClientRect 在 CSS zoom 下是视觉坐标,
  // fixed/SVG 在 zoom 上下文会被再 ×zoom,故全部 ÷zoom 还原;zoom 直读 <html>.style.zoom)。
  useLayoutEffect(() => {
    if (!open) { setItems([]); return; }
    const measure = () => {
      const zoom = parseFloat(document.documentElement.style.zoom) || 1;
      setDims({ vw: window.innerWidth / zoom, vh: window.innerHeight / zoom });
      const out = [];
      for (const s of steps) {
        const el = document.querySelector(`[data-tour="${s.sel}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        out.push({ ...s, box: { top: r.top / zoom, left: r.left / zoom, width: r.width / zoom, height: r.height / zoom } });
      }
      setItems(out);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, steps]);

  if (!open) return null;
  const { vw, vh } = dims;

  // 说明框网格铺在按钮下方留白区,全部直接显示;每个框用连线接回其按钮。
  const PW = 208, GAP = 14, ROW_H = 122, TOP0 = 128;
  const cols = Math.max(2, Math.min(5, Math.floor((vw - 40) / (PW + GAP))));
  const gridW = cols * PW + (cols - 1) * GAP;
  const gridLeft = Math.max(20, (vw - gridW) / 2);
  const panels = items.map((it, i) => ({
    ...it,
    panel: { left: gridLeft + (i % cols) * (PW + GAP), top: TOP0 + Math.floor(i / cols) * ROW_H },
  }));

  return (
    <div className="fixed inset-0 z-[400]">
      {/* spotlight:暗遮罩 + 挖空所有按钮(露出真实按钮 → 亮);连线接回说明框。点空白关闭。 */}
      <svg width={vw} height={vh} style={{ position: 'fixed', top: 0, left: 0 }} onClick={onClose}>
        <defs>
          <mask id="cgui-spotlight">
            <rect x="0" y="0" width={vw} height={vh} fill="white" />
            {items.map((it) => (
              <rect key={it.sel} x={it.box.left - 3} y={it.box.top - 3} width={it.box.width + 6} height={it.box.height + 6} rx="9" fill="black" />
            ))}
          </mask>
        </defs>
        <rect x="0" y="0" width={vw} height={vh} fill="rgba(0,0,0,0.58)" mask="url(#cgui-spotlight)" />
        {panels.map((p) => (
          <line key={p.sel}
            x1={p.box.left + p.box.width / 2} y1={p.box.top + p.box.height / 2}
            x2={p.panel.left + PW / 2} y2={p.panel.top}
            stroke="rgba(217,119,87,0.5)" strokeWidth="1" />
        ))}
      </svg>

      {/* 挖空处的按钮已经亮起;再补一圈细描边点明"这是被讲解的按钮" */}
      {items.map((it) => (
        <div key={it.sel} style={{ position: 'fixed', top: it.box.top - 3, left: it.box.left - 3, width: it.box.width + 6, height: it.box.height + 6 }}
          className="rounded-lg ring-[1.5px] ring-accent pointer-events-none" />
      ))}

      {/* 说明框:全部直接显示,无需悬停 */}
      {panels.map((p) => (
        <div key={p.sel} style={{ position: 'fixed', top: p.panel.top, left: p.panel.left, width: PW }}
          className="bg-canvas border border-canvas-deep rounded-lg shadow-lg px-2.5 py-2 pointer-events-none">
          <div className="text-[11.5px] font-body font-semibold text-accent mb-0.5">{p.title}</div>
          <div className="text-[10px] text-ink-muted font-body leading-snug whitespace-pre-line">{p.desc}</div>
        </div>
      ))}

      {/* 顶部标题条 + 关闭 */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-canvas border border-canvas-deep shadow-lg pointer-events-auto z-10">
        <span className="text-[12px] font-body font-medium text-ink">功能导引</span>
        <span className="text-[10px] text-ink-faint font-body">{hasProject ? '会话列表视图' : '项目列表视图'} · 高亮=按钮位置,连线指向对应说明</span>
        <button onClick={onClose} className="text-ink-faint hover:text-ink" title="关闭"><X size={13} /></button>
      </div>
    </div>
  );
}
