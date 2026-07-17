// CK-3: 使用指引。逐个高亮界面功能按钮,下方浮出说明文字。
// 目标元素通过 data-tour="<id>" 定位;找不到的步骤自动跳过(如分屏/远程在某些态不渲染)。
// 左栏是会话列表还是项目列表 → 动态裁剪对应步骤(避免在项目列表讲会话、反之亦然)。
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { X, ArrowRight, ArrowLeft } from 'lucide-react';

// 顶栏功能面板按钮(与 PANEL_MAP 同序)。逐个圈。
const PANEL_STEPS = [
  ['panel-files', '文件', '浏览当前项目的文件树,点开任意文件查看或编辑。\n· 图片 / PDF / Word / Excel / PPT / 文本都能直接看\n· html / svg / mermaid 可内联渲染,也可侧边停靠放大\n· 预览(含会话里的 html / svg / mermaid 预览)出运行时报错时,右下角出现报错徽章,点开可一键把报错发给 AI 修复\n· 文本类文件可直接编辑并保存(带撤销/重做)\n· 右键文件/文件夹:添加到上下文(输入框自动 @ 该文件)、用默认 App 打开、删除(10 秒内可撤销)'],
  ['panel-changes', '审查', '按 AI 的每个回合查看它改动了哪些文件。\n· 列出每回合新增/修改/删除的文件\n· 逐个文件看具体改动 diff(增删了哪些行)\n· 可回滚到某个回合改动之前的状态'],
  ['panel-monitor', '监控', '看 AI 派出去的代理在干什么。\n· 上半:子代理(Task)实时状态树,每个在跑什么、可逐个停止\n· 下半「后台代理」:一句话派一个无人值守的后台任务,查看它在等什么/进度/结果,一键停止(走官方 claude stop,只停目标不连坐)\n· 各区块均可折叠/展开;结束超过 30 天的后台代理自动不再显示'],
  ['panel-agents', 'Agent', '管理自定义子代理(存在 ~/.claude/agents 的 .md,定义名称/模型/可用工具/系统提示词)。\n· 新建 / 编辑 / 删除子代理\n· 一键安装内置预设:explorer(探索)、oracle(架构顾问)、orchestrator(编排)、designer、fixer 等'],
  ['panel-usage', '用量', '统计 token 消耗与费用。\n· 按模型 / 项目 / 日期分组\n· 显示总 token、缓存命中 token、命中率\n· 一键生成官方 /insights 使用报告(内联预览)\n· 导出 CSV;官方订阅额度(非第三方)也在这看'],
  ['panel-processes', '进程', '查看并管理正在运行的 claude 子进程。\n· 列出每个进程的 PID / 所属会话 / 已运行时长 / 模型\n· 可逐个停止(按进程精准杀,不误伤其它)'],
  ['panel-mcp', '工具', '管理 MCP 服务器和插件。\n· 增删 MCP 服务器(stdio / SSE / Streamable HTTP)、测连通性\n· 选快速模板自动回填常用 MCP 字段\n· 插件:内置推荐(含 superpowers)在「添加」弹层一键安装;已装的可更新到最新版或卸载,卸载后回到添加页可重装\n· 「添加」弹层顶部「从全部 marketplace 搜索(高级)」可展开,按名称 / 描述 / 来源检索精选清单外的全部可装插件'],
  ['panel-skills', '技能', '管理本机技能(skill)。\n· 查看 ~/.claude/skills 下已装的 skill;点任一条展开完整简介;SKILL.md 若声明 version 则显示版本号\n· 已装的可归档(停用、可随时恢复)或删除(需重新下载)\n· 一键从 Anthropic 官方及社区(vercel / hermes / garden 等)skill 市场导入\n· 也可粘贴 GitHub 或 Gitee 仓库地址导入(支持 /tree/分支、owner/repo@分支);导入过的仓库自动常驻列表可再次拉取或移除\n· 从市场/仓库装的技能带「更新」按钮,一键覆盖到上游最新'],
  ['panel-memory', '指令', '三个标签页:\n· 指令(CLAUDE.md):编辑 全局 / 项目 / 项目·私人 / 组织 四级指令(项目级随 git 与团队共享,项目·私人只留本机不提交)\n· 自动记忆:查看/编辑 AI 自己写的跨会话记忆\n· 提示词库:780 条内置预设,按 33 个分类折叠浏览 + 搜索,一键复制到输入框或 CLAUDE.md'],
  ['panel-settings', '设置', '多个标签页:\n· 概览:检查/安装更新、缓存优化开关、自动压缩窗口(token)、对话区背景(纯色/图片/视频 + 遮罩不透明度)\n· 全局热键截图:在概览里开启并可自定义热键(默认 Cmd/Ctrl+Shift+2);按下即置顶窗口截图(macOS 框选区域或点窗口),截图自动加进当前会话输入框\n· 环境:检查 node / claude / python / git / uv 是否就绪,缺失可装;安装失败后重新检测会恢复「安装」按钮\n· Hooks:配置钩子脚本\n· 原始配置:直接编辑 settings.json\n· 存储:清理缓存、彻底清理某项目的全部 Claude 状态\n· 网络:开局域网访问后配合内网穿透(如 Tailscale),手机浏览器可访问整个 GUI —— 与顶栏「远程」不同,那个是手机 App 只接管单条会话'],
];

function buildSteps(hasProject) {
  const steps = [
    ['sidebar-toggle', '收起 / 展开侧栏', '点这里收起左侧栏腾出空间,再点可展开。'],
  ];
  if (hasProject) {
    steps.push(
      ['sidebar-list', '会话列表', '当前项目下的所有会话,点任一条进入。\n· 顶部切「活跃 / 已归档」、搜索会话标题\n· 每条会话可 pin 置顶、归档、删除、分叉(fork 出一条新线)\n· 点标题即可重命名'],
      ['new-session', '新建会话', '在当前项目下开一个新会话(也可按 Cmd/Ctrl+N)。\n· 自动继承上一个会话的模型 / 推理力度 / 子代理模式,免得每次重选'],
      ['new-worktree', 'worktree 隔离会话', '在新建的 git worktree 里开会话,改动与主工作区隔离 —— 适合让 AI 大改代码而不污染当前分支。\n· 可选已有 worktree,或填名字新建'],
    );
  } else {
    steps.push(
      ['sidebar-list', '项目文件夹列表', '你添加的所有项目文件夹,点任一项进入其会话列表。\n· 每项可 pin 置顶、隐藏、彻底清理该项目的 Claude 状态\n· 顶部可搜索项目 / 会话'],
      ['add-project', '添加项目文件夹', '把一个本地文件夹加进来作为新项目。\n· 点这里弹系统文件夹选择器,或手动粘贴绝对路径'],
    );
  }
  steps.push(
    ['provider-switcher', '切换 Provider', '在官方 Anthropic 与第三方中转之间一键切换。\n· 点「添加」选内置预设:官方 OpenAI / Anthropic / Google Gemini、DeepSeek、Kimi、通义千问、豆包、智谱 GLM 等\n· 填 API key,点「获取模型」拉取该渠道可用模型即可用\n· 支持 openai 兼容与 anthropic 兼容两种协议(Gemini 走官方 OpenAI 兼容端点);选定协议后模板列表只显示该协议的预设,避免选错'],
    ['model-selector', '模型', '选当前会话使用的具体模型。\n· 分屏时每个窗格可各自独立选\n· 切到第三方 provider 会显示它自己的模型列表'],
    ['effort-selector', '推理力度', '调 AI 的思考强度:低 / 中 / 高 / 最高。\n· 越高思考越深入、结果越细致,但越慢、越费 token\n· 官方模型区别明显,部分第三方可能无效'],
    ['permission-selector', '权限模式', '控制 AI 调用工具时是否需要你逐个确认:\n· 默认:每个工具调用都弹卡片让你批准\n· 接受编辑:自动批准文件编辑,其它工具仍问\n· 规划:只读不改,先给出计划让你确认;计划批准后全文常驻在输入框上方(默认折叠一行,可展开回看或隐藏)\n· 放行:全自动执行、完全不问(慎用)'],
    ['agent-selector', '子代理模式', '选一个已安装的子代理作会话主控,它可经 Task 把任务委派给其它子代理并行执行。\n· 默认只有「普通模式」;orchestrator(编排)、explorer、oracle、designer、fixer 等预设需先在「Agent」面板点安装,才会出现在这里可选\n· 子代理跑完结果汇总回主对话;进度在「监控」面板看'],
    ['remote-control', '手机远程控制', '用手机上的 Claude App 同账号接管当前这一条会话继续对话。\n· 需已登录官方账号、且当前非第三方 provider\n· 与「设置·网络 + Tailscale」不同:那个是手机浏览器访问整个 GUI 界面,这个只接管单条会话'],
    ['pane-count', '分屏', '把界面分成 1–6 个窗格,并排同时看和操作多个会话。\n· 每个窗格的模型 / 权限模式相互独立'],
    ...PANEL_STEPS,
    ['theme-toggle', '主题与外观', '外观相关设置:\n· 配色主题(多套深浅色可选)\n· 界面字号、对话正文字号\n· AI 思考时的加载动画样式(30 种可选)'],
    ['composer', '输入框', '· Cmd/Ctrl+Enter 发送、Enter 换行\n· 输入 / 打开命令面板(含 /branch 分叉、/goal 目标、插件命令等)\n· 输入 @ 打开引用选择器:按目录层级浏览项目文件(点文件夹进入、「返回上级」回退),输入关键词则全局搜索;Tab 切到会话页可把本项目其它会话的内容注入当前对话\n· 可【拖入】图片 / PDF / Word / Excel / PPT 等文件\n· Cmd/Ctrl+Z 撤销输入\n· AI 回复中再输入会入队;输入框为空时按 ↑ 键召回最近入队的消息\n· 按 Cmd/Ctrl+/ 打开快捷键速查表(含切换分屏窗格 Ctrl+Tab、切上/下一条会话 Cmd+↑/↓ 等全部快捷键)'],
    ['help', '快捷键速查 & 重看指引', '随时按 Cmd/Ctrl+/ 打开【快捷键速查表】,里面列了发送、切会话、切分屏窗格等全部快捷键。\n· 以后忘了哪个功能,点这个问号就能重新走一遍本指引。'],
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
  // 问号导引 = 纯逐步(下一步/上一步),高亮【不随鼠标动】,逐个介绍界面功能。

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

  // 兜底看门狗:目标元素中途消失(面板关闭/布局变化)时 rect/pos 残留,全屏遮罩会把
  // 整页锁死(preview 实测过"顶栏全点不动")。定期验证当前目标仍在且可见:失效则顺延
  // 到下一个有效步骤,全部无效直接结束 tour。失败方向=宁可结束指引也不能锁死界面。
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      let idx = i;
      while (idx < steps.length) {
        const el = document.querySelector(`[data-tour="${steps[idx].sel}"]`);
        if (el && el.getBoundingClientRect().width > 0) break;
        idx++;
      }
      if (idx >= steps.length) onClose();
      else if (idx !== i) setI(idx);
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
            className="px-2.5 py-1 text-[11px] rounded bg-accent text-white hover:bg-accent/90 flex items-center gap-1">
            {last ? '完成' : <>下一步<ArrowRight size={11} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
