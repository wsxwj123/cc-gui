// CK-3: 使用指引。逐个高亮界面功能按钮,下方浮出说明文字。
// 目标元素通过 data-tour="<id>" 定位;找不到的步骤自动跳过(如分屏/远程在某些态不渲染)。
// 左栏是会话列表还是项目列表 → 动态裁剪对应步骤(避免在项目列表讲会话、反之亦然)。
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { X, ArrowRight, ArrowLeft } from 'lucide-react';

// P1.5:原 10 个面板步骤并为 1 步「面板坞」——步骤进入时经 cgui:dock-rail-open 事件
// 展开 rail 做演示(第 4 元素 = enter 事件名),文案压缩为每面板一行。
const PANEL_STEPS = [
  ['panel-dock', '设置(功能面板坞)', '10 个功能面板都收纳在顶栏「设置」里:点它原位展开面板条,再点任一图标打开对应面板;点外部或再点「设置」图标收起。\n· 文件:项目文件树,查看 / 编辑 / 预览,右键可添加到上下文\n· 审查:按回合看 AI 改了哪些文件(diff),可回滚\n· 监控:子代理 + 后台代理实时状态,可逐个停止\n· Agent:管理自定义子代理(~/.claude/agents)\n· 用量:token / 费用统计,/insights 报告,导出 CSV\n· 进程:查看并停止正在运行的 claude 子进程\n· 工具:MCP 服务器与插件的增删 / 测试 / 安装\n· 技能:skill 市场导入与本机技能管理\n· 指令:CLAUDE.md 四级指令 / 自动记忆 / 提示词库\n· 通用:更新 / 会话 / 外观 / Provider / 权限 / 网络 等 9 个标签页\n快捷键 Cmd/Ctrl+1..9 直达前 9 个面板、0 打开「通用」(面板条收起时同样可用);有可用更新时「设置」图标出现红点,展开后点「更新」直达更新区。', 'cgui:dock-rail-open'],
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
    ['provider-switcher', '切换 Provider', '在官方 Anthropic 与第三方中转之间一键切换(点任一条即切,对新发的消息生效)。\n· 增删改 / 测试连接 / 隐藏 / 从 cc-switch 导入等管理操作,在弹层底部「管理 Provider」进入 通用 → Provider 页\n· 管理页有内置模板:官方 OpenAI / Anthropic / Google Gemini、DeepSeek、Kimi、通义千问、豆包、智谱 GLM 等,填 API key、点「获取模型」即可用\n· 支持 openai 兼容与 anthropic 兼容两种协议,选定协议后模板只显示该协议预设,避免选错'],
    ['model-selector', '模型', '选当前会话使用的具体模型。\n· 分屏时每个窗格可各自独立选\n· 切到第三方 provider 会显示它自己的模型列表'],
    ['effort-selector', '推理力度', '调 AI 的思考强度:低 / 中 / 高 / 最高。\n· 越高思考越深入、结果越细致,但越慢、越费 token\n· 官方模型区别明显,部分第三方可能无效'],
    ['permission-selector', '权限模式', '控制 AI 调用工具时是否需要你逐个确认:\n· 默认:每个工具调用都弹卡片让你批准\n· 接受编辑:自动批准文件编辑,其它工具仍问\n· 规划:只读不改,先给出计划让你确认;计划批准后全文常驻在输入框上方(默认折叠一行,可展开回看或隐藏)\n· 放行:全自动执行、完全不问(慎用)'],
    ['agent-selector', '子代理模式', '选一个已安装的子代理作会话主控,它可经 Task 把任务委派给其它子代理并行执行。\n· 默认只有「普通模式」;orchestrator(编排)、explorer、oracle、designer、fixer 等预设需先在「Agent」面板点安装,才会出现在这里可选\n· 子代理跑完结果汇总回主对话;进度在「监控」面板看'],
    ['remote-control', '手机远程控制', '用手机上的 Claude App 同账号接管当前这一条会话继续对话。\n· 需已登录官方账号、且当前非第三方 provider\n· 与「通用·网络 + Tailscale」不同:那个是手机浏览器访问整个 GUI 界面,这个只接管单条会话'],
    ['pane-count', '分屏', '把界面分成 1–6 个窗格,并排同时看和操作多个会话。\n· 每个窗格的模型 / 权限模式相互独立'],
    ...PANEL_STEPS,
    ['theme-toggle', '主题与外观', '外观相关设置:\n· 配色主题(多套深浅色可选)\n· 界面字号、对话正文字号\n· AI 思考时的加载动画样式(30 种可选)\n· 同样的设置也在 通用 → 外观 页(两处同源)'],
    // P1.2 被收纳项的新落点:会话信息徽章 + 会话头 ⋮(无会话时锚点不在 DOM,自动跳过)。
    ['ctx-badge', '会话信息徽章', '本会话的信息中枢:显示上下文占用 xx k / 窗口(百分比),点开看 /context 分项明细并可重新精确计算。\n· 弹层还收纳:当前模型与「曾用」模型史、第三方 provider 标识、工具调用次数、累计 token / 费用 / 缓存命中率\n· 新会话数据未到达时,徽章先显示模型徽章(零态),首个回合后自动切为占用数字'],
    ['session-menu', '会话头 ⋮ 菜单', '更多会话操作收纳在这里:\n· 导出:把当前会话导出为 Markdown(下载到本地或复制到剪贴板)\n· 检查点:Checkpoint 时间线 —— 给工作目录拍快照,可随时回到某个快照并裁剪会话到该时刻\n· 重命名点标题旁铅笔;分叉 / 归档在左侧会话列表 hover 菜单'],
    ['composer', '输入框', '· Cmd/Ctrl+Enter 发送、Enter 换行\n· 输入 / 打开命令面板(含 /branch 分叉、/goal 目标、插件命令等)\n· 输入 @ 打开引用选择器:按目录层级浏览项目文件(点文件夹进入、「返回上级」回退),输入关键词则全局搜索;Tab 切到会话页可把本项目其它会话的内容注入当前对话\n· 可【拖入】图片 / PDF / Word / Excel / PPT 等文件\n· Cmd/Ctrl+Z 撤销输入\n· AI 回复中再输入会入队;输入框为空时按 ↑ 键召回最近入队的消息\n· 按 Cmd/Ctrl+/ 打开快捷键速查表(含切换分屏窗格 Ctrl+Tab、切上/下一条会话 Cmd+↑/↓ 等全部快捷键)'],
    ['help', '快捷键速查 & 重看指引', '随时按 Cmd/Ctrl+/ 打开【快捷键速查表】,里面列了发送、切会话、切分屏窗格等全部快捷键。\n· 以后忘了哪个功能,点这个问号就能重新走一遍本指引。'],
  );
  // enter(可选)= 进入该步骤时 dispatch 的 window 事件名(如展开面板坞做演示)。
  return steps.map(([sel, title, desc, enter]) => ({ sel, title, desc, enter }));
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
  // 的首帧会用到上一轮的旧 i/rect,而 steps 长度随 hasProject 变(有项目态多 1 步),
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
    // P1.5 步骤联动:进入带 enter 的步骤时 dispatch 对应事件(如 cgui:dock-rail-open 展开
    // 面板坞)。展开会让锚点(wrapper)尺寸变化,320ms 后补量一次高亮框(等 rail 动画落定)。
    if (steps[idx].enter) window.dispatchEvent(new CustomEvent(steps[idx].enter));
    el.scrollIntoView({ block: 'nearest' });
    const update = () => setRect(el.getBoundingClientRect());
    update();
    const remeasure = steps[idx].enter ? setTimeout(update, 320) : null;
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); if (remeasure) clearTimeout(remeasure); };
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
