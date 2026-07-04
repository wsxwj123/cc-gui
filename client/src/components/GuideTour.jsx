// 使用指引:点问号后半透明遮罩压暗全屏、【挖空所有功能按钮让它们亮起来】(spotlight
// 高亮),鼠标悬停任一高亮按钮即在它旁边显示该按钮的二级菜单与说明(一次一个气泡,紧贴
// 按钮,不用连线不铺满)。左栏是会话/项目列表 → 动态裁剪对应说明。
import { useMemo, useState, useLayoutEffect } from 'react';
import { X } from 'lucide-react';

const PANEL_STEPS = [
  ['panel-files', '文件', '· 浏览项目文件树、点开预览\n· html/svg 可侧边停靠放大查看\n· 图片/PDF/Office 直接预览'],
  ['panel-changes', '审查', '· 按 AI 回合查看改了哪些文件\n· 逐个文件看改动 diff\n· 可按回合回滚改动'],
  ['panel-monitor', '监控', '· 实时看子代理(Task)状态树\n· 后台代理:一句话派发、查看、停止\n· 可逐个停止'],
  ['panel-agents', 'Agent', '· 增删改 ~/.claude/agents 的子代理定义\n· 一键安装内置预设(explorer/oracle/fixer 等)'],
  ['panel-usage', '用量', '· 按模型/项目/日期看 token 与费用\n· 总量、缓存命中率\n· 一键生成使用报告、导出 CSV'],
  ['panel-processes', '进程', '· 查看正在运行的 claude 子进程\n· 逐个停止'],
  ['panel-mcp', '工具', '· 增删 MCP 服务器、测连通性\n· 安装插件(未装的推荐项收进「添加」)'],
  ['panel-skills', '技能', '· 查看本机已装 skill\n· 一键导入 Anthropic 官方与社区 skill 市场'],
  ['panel-memory', '指令', '· 指令(CLAUDE.md):编辑全局 / 项目 / 项目·私人 / 组织 四级指令\n· 自动记忆:查看/编辑 AI 自写的跨会话记忆\n· 提示词库:780 条内置预设,按 33 个分类折叠浏览+搜索,一键复制到输入框或 CLAUDE.md'],
  ['panel-settings', '设置', '· 概览:更新检查、缓存优化开关、自动压缩窗口、对话区背景(纯色/图片/视频+遮罩)、输入预测\n· 环境:检查 node / claude / python 是否就绪\n· Hooks:钩子脚本\n· 原始配置:直接编辑 settings.json\n· 存储:清理缓存、彻底清理某项目的全部 Claude 状态\n· 网络:开启局域网访问后,配合内网穿透工具(如 Tailscale)可用手机浏览器打开本 GUI 远程操作 —— 这和顶栏「远程」按钮不同:「远程」是手机 Claude App 接管单条会话,「网络+Tailscale」是手机直接访问整个 GUI 界面'],
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
    ['provider-switcher', '切换 Provider', '在官方 Anthropic 与第三方中转(DeepSeek/MiMo/Gemini 等)间一键切换。添加时可选内置预设(官方 OpenAI / Anthropic / Gemini 等),填 key 即用。'],
    ['model-selector', '模型', '选当前会话使用的模型。'],
    ['effort-selector', '推理力度', '调思考强度(低→高),越高越细但越慢/越贵。'],
    ['permission-selector', '权限模式', '默认 / 接受编辑 / 规划 / 放行,控制工具调用是否需你确认。'],
    ['agent-selector', '子代理模式', '让主控把任务派给子代理执行。'],
    ['remote-control', '手机远程控制', '用手机 Claude App 同账号接管此会话(需登录、非三方 provider)。与「设置·网络+Tailscale」不同:后者是手机直接访问整个 GUI 界面。'],
    ['pane-count', '分屏', '把界面分成 1–6 格,并排看多个会话。'],
    ...PANEL_STEPS,
    ['theme-toggle', '主题与外观', '· 配色主题(多套深浅色)\n· 界面与正文字号\n· AI 思考时的加载动画样式'],
    ['composer', '输入框', 'Cmd/Ctrl+Enter 发送、Enter 换行;输入 / 打开命令;可【拖入】图片/PDF/Word/Excel/PPT 等文件;Cmd/Ctrl+Z 撤销输入。'],
  );
  return steps.map(([sel, title, desc]) => ({ sel, title, desc }));
}

export function GuideTour({ open, onClose, hasProject }) {
  const steps = useMemo(() => buildSteps(hasProject), [hasProject]);
  const [items, setItems] = useState([]);
  const [dims, setDims] = useState({ vw: 1280, vh: 800 });
  const [hover, setHover] = useState(null);

  // 测量所有 data-tour 元素(逻辑 px:CSS zoom 下 getBoundingClientRect 是视觉坐标,
  // fixed/SVG 在 zoom 上下文会被再 ×zoom,故 ÷zoom 还原;zoom 直读 <html>.style.zoom)。
  useLayoutEffect(() => {
    if (!open) { setItems([]); setHover(null); return; }
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

  // 悬停项的说明气泡:紧贴按钮,下方优先/放不下翻上方,水平夹进视口。
  const PW = 260;
  const bub = (() => {
    if (hover == null || !items[hover]) return null;
    const it = items[hover], b = it.box;
    const estH = 40 + it.desc.split('\n').length * 17;
    let top = b.top + b.height + 10;
    if (top + estH > vh - 8) top = Math.max(8, b.top - estH - 10);
    let left = Math.max(8, Math.min(b.left + b.width / 2 - PW / 2, vw - PW - 8));
    return { it, top, left };
  })();

  return (
    <div className="fixed inset-0 z-[400]">
      {/* 底层:点空白关闭。必须单独一层——spotlight 的 SVG 若带 onClick 会以全屏
          pointer-events 盖住按钮上的悬停捕获层,导致 mouseenter 永不触发、悬停无注解
          (用户实报)。故 SVG 设 pointer-events:none 纯视觉,关闭交给这个底层。 */}
      <div className="absolute inset-0" onClick={onClose} />
      {/* spotlight:暗遮罩 + 挖空所有按钮(露出真实按钮 → 亮起)。纯视觉,不挡鼠标。 */}
      <svg width={vw} height={vh} style={{ position: 'fixed', top: 0, left: 0, pointerEvents: 'none' }}>
        <defs>
          <mask id="cgui-spotlight">
            <rect x="0" y="0" width={vw} height={vh} fill="white" />
            {items.map((it) => (
              <rect key={it.sel} x={it.box.left - 3} y={it.box.top - 3} width={it.box.width + 6} height={it.box.height + 6} rx="9" fill="black" />
            ))}
          </mask>
        </defs>
        <rect x="0" y="0" width={vw} height={vh} fill="rgba(0,0,0,0.55)" mask="url(#cgui-spotlight)" />
      </svg>

      {/* 每个按钮上盖一层透明捕获区:悬停显示说明、加深描边 */}
      {items.map((it, i) => (
        <div key={it.sel}
          onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          style={{ position: 'fixed', top: it.box.top - 3, left: it.box.left - 3, width: it.box.width + 6, height: it.box.height + 6, zIndex: hover === i ? 3 : 1 }}
          className={`rounded-lg pointer-events-auto cursor-help transition-colors ${hover === i ? 'ring-2 ring-accent' : 'ring-[1.5px] ring-accent/55'}`}
        />
      ))}

      {/* 悬停说明气泡(含二级菜单),一次只显示一个 */}
      {bub && (
        <div style={{ position: 'fixed', top: bub.top, left: bub.left, width: PW, zIndex: 6 }}
          className="bg-canvas border border-canvas-deep rounded-xl shadow-2xl p-3 pointer-events-none animate-fade-in">
          <div className="text-[12.5px] font-body font-semibold text-accent mb-1">{bub.it.title}</div>
          <div className="text-[11px] text-ink-muted font-body leading-relaxed whitespace-pre-line">{bub.it.desc}</div>
        </div>
      )}

      {/* 顶部标题条 + 关闭 */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-canvas border border-canvas-deep shadow-lg pointer-events-auto z-10">
        <span className="text-[12px] font-body font-medium text-ink">功能导引</span>
        <span className="text-[10px] text-ink-faint font-body">{hasProject ? '会话列表视图' : '项目列表视图'} · 悬停任意高亮按钮看它的说明</span>
        <button onClick={onClose} className="text-ink-faint hover:text-ink" title="关闭"><X size={13} /></button>
      </div>
    </div>
  );
}
