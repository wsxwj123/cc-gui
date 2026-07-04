// 使用指引。点问号后【一次性高亮所有功能按钮】(不逐步、不罗列清单),鼠标悬停任一
// 高亮按钮即显示它的说明气泡(含二级菜单),说明与按钮直接视觉关联。左栏是会话列表
// 还是项目列表 → 动态裁剪对应说明。
import { useMemo, useState, useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';

// 顶栏功能面板按钮的说明(含二级菜单)。
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

const BUBBLE_W = 280;

export function GuideTour({ open, onClose, hasProject }) {
  const steps = useMemo(() => buildSteps(hasProject), [hasProject]);
  const [items, setItems] = useState([]);   // [{sel,title,desc,box:{top,left,width,height}}] 逻辑 px
  const [hover, setHover] = useState(null);  // index
  const overlayRef = useRef(null);

  // 测量所有 data-tour 元素位置。<html> 有 font-scale zoom → getBoundingClientRect
  // 返回缩放后实际像素,写进 style 会被再 ×zoom,故统一 ÷zoom 还原成逻辑 px。
  useLayoutEffect(() => {
    if (!open) { setItems([]); setHover(null); return; }
    const measure = () => {
      // zoom 直接读 <html> 的 style.zoom(uiFontScale 设的确切值,如 1.2),不再靠
      // overlay 的 rect/offset 估算——那个在 overlay 刚挂载、布局未稳时会算成 ~1,
      // 导致 fixed 定位在 zoom 上下文里被二次放大、越往右下偏移越大(高亮框全错位)。
      const zoom = parseFloat(document.documentElement.style.zoom) || 1;
      const out = [];
      for (const s of steps) {
        const el = document.querySelector(`[data-tour="${s.sel}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        // getBoundingClientRect 在 CSS zoom 下返回视觉坐标;fixed 定位会被 ×zoom 渲染,
        // 故 ÷zoom 还原,渲染后正好落回视觉位置。
        out.push({ ...s, box: { top: r.top / zoom, left: r.left / zoom, width: r.width / zoom, height: r.height / zoom } });
      }
      setItems(out);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, steps]);

  if (!open) return null;

  // 悬停项的说明气泡定位:优先按钮正下方,放不下翻到上方,再夹到视口内。
  const bubble = (() => {
    if (hover == null || !items[hover]) return null;
    const it = items[hover];
    // 视口边界换算到与 it.box 相同的逻辑坐标系(÷zoom),否则大字号下气箭夹取会偏。
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;
    const vw = window.innerWidth / zoom, vh = window.innerHeight / zoom;
    const b = it.box;
    // 估算气泡高度(说明多行);实际由内容撑开,这里只做定位择向。
    const estH = 44 + (it.desc.split('\n').length * 18);
    let top = b.top + b.height + 8;
    if (top + estH > vh - 8) top = Math.max(8, b.top - estH - 8); // 下方放不下→上方
    let left = b.left + b.width / 2 - BUBBLE_W / 2;               // 水平居中于按钮
    left = Math.max(8, Math.min(left, vw - BUBBLE_W - 8));        // 夹进视口
    // 引线:从按钮中心到气泡顶部中心(仅在气泡不紧贴时画,简单竖线足够示意归属)
    return { it, top, left, anchorX: b.left + b.width / 2, anchorY: b.top + b.height };
  })();

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[400]">
      {/* 半透明遮罩,点空白关闭 */}
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />

      {/* 顶部标题条 + 关闭 */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-canvas border border-canvas-deep shadow-lg pointer-events-auto">
        <span className="text-[12px] font-body font-medium text-ink">功能导引</span>
        <span className="text-[10px] text-ink-faint font-body">{hasProject ? '会话列表视图' : '项目列表视图'} · 悬停任意高亮按钮看说明</span>
        <button onClick={onClose} className="text-ink-faint hover:text-ink" title="关闭"><X size={13} /></button>
      </div>

      {/* 所有按钮同时高亮描边;悬停项加深并高于其它 */}
      {items.map((it, i) => (
        <div key={it.sel}
          onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          style={{ position: 'fixed', top: it.box.top - 3, left: it.box.left - 3, width: it.box.width + 6, height: it.box.height + 6, zIndex: hover === i ? 3 : 1 }}
          className={`rounded-lg pointer-events-auto cursor-help transition-colors ${hover === i ? 'ring-2 ring-accent bg-accent/10' : 'ring-2 ring-accent/45'}`}
        />
      ))}

      {/* 悬停说明气泡 + 一条竖向引线示意归属 */}
      {bubble && (
        <>
          <div style={{ position: 'fixed', left: bubble.anchorX - 0.5, top: Math.min(bubble.anchorY, bubble.top), width: 1, height: Math.abs(bubble.top - bubble.anchorY), zIndex: 4 }}
            className="bg-accent/50 pointer-events-none" />
          <div style={{ position: 'fixed', top: bubble.top, left: bubble.left, width: BUBBLE_W, zIndex: 5 }}
            className="bg-canvas border border-canvas-deep rounded-xl shadow-2xl p-3 pointer-events-none animate-fade-in">
            <div className="text-[12.5px] font-body font-semibold text-ink mb-1">{bubble.it.title}</div>
            <div className="text-[11px] text-ink-muted font-body leading-relaxed whitespace-pre-line">{bubble.it.desc}</div>
          </div>
        </>
      )}
    </div>
  );
}
