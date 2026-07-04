// 使用指引。点问号一次性列出【全部】按钮的说明(含各面板的二级菜单),不再逐步高亮
// 逐个点(用户反馈:想看设置得点很多下太麻烦)。左栏是会话列表还是项目列表 → 动态
// 裁剪对应说明(避免在项目列表讲会话、反之亦然)。
import { useMemo } from 'react';
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

export function GuideTour({ open, onClose, hasProject }) {
  const steps = useMemo(() => buildSteps(hasProject), [hasProject]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[86dvh] flex flex-col bg-canvas border border-canvas-deep rounded-2xl shadow-2xl animate-glass-rise">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-canvas-deep shrink-0">
          <span className="text-[14px] font-display font-semibold text-ink flex-1">功能导引 · 一览</span>
          <span className="text-[10.5px] text-ink-faint font-body px-2 py-0.5 rounded bg-canvas-warm">
            {hasProject ? '会话列表视图' : '项目列表视图'}
          </span>
          <button onClick={onClose} className="text-ink-faint hover:text-ink shrink-0" title="关闭"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {steps.map((s) => (
            <div key={s.sel} className="border border-canvas-deep/60 rounded-lg px-3 py-2.5 bg-canvas-warm/30">
              <div className="text-[12px] font-body font-semibold text-ink mb-1">{s.title}</div>
              <div className="text-[11px] text-ink-muted font-body leading-relaxed whitespace-pre-line">{s.desc}</div>
            </div>
          ))}
        </div>
        <div className="px-5 py-2.5 border-t border-canvas-deep shrink-0 flex items-center gap-2">
          <span className="text-[10.5px] text-ink-faint font-body flex-1">此页一次列出全部按钮说明,无需逐步点击。</span>
          <button onClick={onClose} className="px-3 py-1.5 text-[12px] rounded-md bg-accent text-white hover:bg-accent/90 font-body">知道了</button>
        </div>
      </div>
    </div>
  );
}
