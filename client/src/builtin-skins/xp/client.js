// Windows XP (Luna) — cgui T2 客户端脚本（dsh appearance-gallery xp apply() 移植）。
// 职责：body 挂 data-cgui-xp 作用域标记、注入 Luna 标题栏/米色状态栏/侧栏任务栏绿色
// 「开始」按钮/四色旗 favicon/窗口标题、给资源管理器选中行打 .cgui-xp-current 标记；
// 通过 window.__cguiSkinDispose 注册完整卸载器（三重卸载第一重）。
(function () {
  var body = document.body;
  var html = document.documentElement;
  var originalTitle = document.title;
  var SKIN_TITLE = 'Windows XP · Claude GUI 在线';

  // 四色 Windows 旗（dsh xp 原版内联 SVG，无外部素材）
  var FLAG_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">',
    '<rect x="0.5" y="0.5" width="15" height="15" fill="#f0f6fd"/>',
    '<rect x="1.5" y="1.5" width="6.5" height="6.5" fill="#e33e2b"/>',
    '<rect x="8" y="1.5" width="6.5" height="6.5" fill="#4baf4d"/>',
    '<rect x="1.5" y="8" width="6.5" height="6.5" fill="#2d6fd6"/>',
    '<rect x="8" y="8" width="6.5" height="6.5" fill="#f4b400"/>',
    '</svg>'
  ].join('');

  body.setAttribute('data-cgui-xp', '');

  // 悬浮窗口尺寸：按 App 官方口径（innerHeight/zoom 的 zoom 不变量 px）写
  // body 作用域的 --app-h/--app-w，扣掉桌面边距(上30+下26=56、左右10+10=20)。
  // 跟踪 resize 与 html style 上的 zoom 变化（字体档切换）；卸载器全清。

  // ── 标题栏图标与应用头部 CC-GUI logo【机械对齐】(r45 引擎无关化)────────────
  // 定值内边距在不同缩放/布局下必偏(r44 已证伪);r44 改成的「gBCR ÷ CSS zoom」在用户机
  // (系统 WebKit,zoom 1.2)仍偏 —— 那是拿「gBCR 给的是布局 px」当假设在换算,不同引擎
  // 口径不同就换算错。这里不再假设任何口径,改【实测换算系数】:offsetWidth 恒为布局 px,
  // gBCR.width 按引擎当下的实际口径给数,两者之商 = 该引擎该时刻的真实系数(口径一致时
  // 自然退化为 1)。target/current 取原始 gBCR.left(同口径相减),修正量 ÷ 系数换回布局 px。
  var alignRaf = 0;
  var settleTimer = 0;
  var settleLeft = 12;      // settle 轮询余额:250ms × 12 ≈ 3s 后自停,不留常驻定时器
  var topbarObserver = null;
  var observedTopbar = null;
  var topbarRaf = 0;
  var topbarRo = null;       // ResizeObserver:侧栏开合等布局位移不改 topbar 子树、不触发 resize,只有它能醒

  // 取证:皮肤脚本经 Blob-URL 以经典脚本注入,拿不到 skins.js 的模块作用域;又不能自带
  // 上报通道 —— T2 静态黑名单按小写全文扫,信标与网络请求两类调用一律拒载(连注释里
  // 写全形态都会命中),内联一个就是整张皮肤不上身。故走 skins.js 挂出的全局桥
  // window.__cguiSkinTrace(桥不在则静默不发,异常全吞)。
  function trace(data) {
    try { if (window.__cguiSkinTrace) window.__cguiSkinTrace('skin:align', data); } catch (e) {}
  }

  function alignTitlebar() {
    if (!titlebar || !titlebar.isConnected || !icon) return;
    var brand = document.querySelector('[data-cgui="topbar"] .cgui-brand') || document.querySelector('.cgui-brand');
    if (!brand) return;
    var scale = titlebar.offsetWidth ? (titlebar.getBoundingClientRect().width / titlebar.offsetWidth) : 1;
    if (!(scale > 0)) scale = 1;
    var target = brand.getBoundingClientRect().left;
    var current = icon.getBoundingClientRect().left;
    if (target <= 0 || Math.abs(target - current) < 1) return;
    // 判官建议1:优先读自己写过的 element style(恒为布局 px,免疫任何 computed 口径),首轮才回落 computed。
    var pad = parseFloat(titlebar.style.paddingLeft) || parseFloat(getComputedStyle(titlebar).paddingLeft) || 0;
    var next = Math.round(pad + (target - current) / scale);
    if (next >= 6) {
      titlebar.style.paddingLeft = next + 'px';
      trace({ target: target, current: current, scale: scale, pad: pad, next: next });
    }
  }

  // 触发加固:一次性测量在用户机实证会 miss(测的那一刻 topbar 还没到终态)。除
  // install/首帧 rAF/fitDesk(resize+字号缩放)外再补三路,幂等守卫(差<1px 直接 return)
  // 保证对齐之后每一轮都是零写入零成本。
  // settle 轮询:250ms 一跳、跳满 12 次自停的 setTimeout 链(不是 setInterval,不常驻)。
  function settleTick() {
    settleLeft -= 1;
    watchTopbar();
    alignTitlebar();
    settleTimer = settleLeft > 0 ? setTimeout(settleTick, 250) : 0;
  }
  // topbar 结构观察器:收起/展开侧栏这类结构变化会横移 logo,那时 resize 不发生、settle 已停。
  // 【零回环论证】observe 的是 [data-cgui="topbar"] 子树;alignTitlebar 的唯一写入是
  // titlebar.style.paddingLeft,而 titlebar 是本脚本 appendChild 到 body 的节点,不在 topbar
  // 子树内 —— 写入永远落不进被观察范围,回调不可能自触发(r41 教训:观察器回调写自己观察
  // 的东西 = 微任务无限循环冻页)。读 brand/icon 的 gBCR 只读不写,同样不产生 mutation。
  function watchTopbar() {
    var topbar = document.querySelector('[data-cgui="topbar"]');
    if (!topbar || topbar === observedTopbar) return;   // 还没挂载 / 已经盯着它:不重复接
    if (topbarObserver) topbarObserver.disconnect();     // 路由重建了 topbar → 改盯新节点
    observedTopbar = topbar;
    topbarObserver = new MutationObserver(function () {
      if (topbarRaf) return;                             // 一帧内多批变化只重校一次
      topbarRaf = requestAnimationFrame(function () { topbarRaf = 0; alignTitlebar(); });
    });
    topbarObserver.observe(topbar, { childList: true, subtree: true });
    // r46:侧栏展开/收起会平移 logo(topbar 宽度变化)但不产生 topbar 子树 mutation、也不触发
    // window resize —— 用户实报「侧栏展开态永远不对齐」的根因。ResizeObserver 盯 topbar 自身
    // 尺寸,恰好把这类布局位移全兜住;回调与 MutationObserver 共用 rAF 合帧与幂等守卫,
    // titlebar 不在 topbar 内 → 写 padding 不改 topbar 尺寸,零回环。
    if (window.ResizeObserver) {
      if (topbarRo) topbarRo.disconnect();
      topbarRo = new ResizeObserver(function () {
        if (topbarRaf) return;
        topbarRaf = requestAnimationFrame(function () { topbarRaf = 0; alignTitlebar(); });
      });
      topbarRo.observe(topbar);
    }
  }
  function armAlign() {
    alignTitlebar();
    alignRaf = requestAnimationFrame(alignTitlebar);
    settleTimer = setTimeout(settleTick, 250);
    watchTopbar();
    // 字体加载完成会横移 logo。Promise 撤不回,故卸载后靠 alignTitlebar 首行的
    // titlebar.isConnected 判空转,不留副作用。
    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(alignTitlebar, function () {}); } catch (e) {}
  }
  function disposeAlign() {
    cancelAnimationFrame(alignRaf);
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    settleLeft = 0;
    if (topbarRaf) { cancelAnimationFrame(topbarRaf); topbarRaf = 0; }
    if (topbarObserver) { topbarObserver.disconnect(); topbarObserver = null; }
    if (topbarRo) { topbarRo.disconnect(); topbarRo = null; }
    observedTopbar = null;
  }
  function fitDesk() {
    var z = parseFloat(html.style.zoom) || 1;
    body.style.setProperty('--app-h', (window.innerHeight / z - 56) + 'px');
    body.style.setProperty('--app-w', (window.innerWidth / z - 20) + 'px');
  }
  fitDesk();
  window.addEventListener('resize', fitDesk);
  var deskObserver = new MutationObserver(fitDesk);
  deskObserver.observe(html, { attributes: true, attributeFilter: ['style'] });

  // Luna 标题栏：四色旗 + 标题 + 装饰性 –□×
  var titlebar = document.createElement('div');
  titlebar.className = 'cgui-xp-titlebar';
  var icon = document.createElement('span');
  icon.className = 'cgui-xp-titlebar-icon';
  icon.innerHTML = FLAG_SVG;
  var title = document.createElement('span');
  title.className = 'cgui-xp-titlebar-title';
  title.textContent = SKIN_TITLE;
  titlebar.appendChild(icon);
  titlebar.appendChild(title);
  var glyphs = ['–', '□', '×'];
  for (var i = 0; i < glyphs.length; i++) {
    var btn = document.createElement('span');
    btn.className = glyphs[i] === '×' ? 'cgui-xp-tb-close' : 'cgui-xp-tb-btn';
    btn.setAttribute('aria-hidden', 'true');
    btn.textContent = glyphs[i];
    titlebar.appendChild(btn);
  }

  // 米色状态栏：（弹性）| 就绪 · Claude GUI 在线 | 大写 · 数字 · 滚动（凹陷键位格）
  var statusbar = document.createElement('div');
  statusbar.className = 'cgui-xp-statusbar';
  var spacer = document.createElement('span');
  spacer.className = 'cgui-xp-statusbar-spacer';
  statusbar.appendChild(spacer);
  var cells = [
    { text: '就绪', key: false },
    { text: 'Claude GUI 在线', key: false },
    { text: '大写', key: true },
    { text: '数字', key: true },
    { text: '滚动', key: true }
  ];
  for (var j = 0; j < cells.length; j++) {
    var cell = document.createElement('span');
    cell.className = cells[j].key ? 'cgui-xp-statusbar-key' : 'cgui-xp-statusbar-cell';
    cell.textContent = cells[j].text;
    statusbar.appendChild(cell);
  }

  // 资源管理器选中行：cgui 会话行以 .active 表选中（无 aria-selected），
  // 由观察器同步成皮肤自有标记 .cgui-xp-current 供 skin.css 上深蓝底白字。
  // r39：查询范围收窄到 observedSidebar（会话行只可能在侧栏内）——原来扫全文档，
  // 真实会话上万节点时每次同步都是一次全树遍历。
  function syncCurrentRow() {
    if (!observedSidebar) return;
    var rows = observedSidebar.querySelectorAll('[data-cgui="session-row"]');
    for (var k = 0; k < rows.length; k++) {
      // 状态已一致时必须【零写入】:旧版系统 WebKit(用户机 Sequoia 实锤,sample 栈证)对
      // no-op 的 classList.add/remove 也会重写 class 属性 → 触发本函数所属的 sidebar
      // 观察器 → 再同步一轮 → 微任务无限循环,整页冻死(Chrome/新 WebKit 无此行为,
      // 复现不出)。contains 守卫让稳态轮次不产生任何 mutation,循环自断。
      var wantCurrent = rows[k].classList.contains('active');
      var hasCurrent = rows[k].classList.contains('cgui-xp-current');
      if (wantCurrent && !hasCurrent) rows[k].classList.add('cgui-xp-current');
      else if (!wantCurrent && hasCurrent) rows[k].classList.remove('cgui-xp-current');
    }
  }

  // 侧栏任务栏：找到 [data-cgui="sidebar"] 就在其尾部挂任务栏条 + 绿色「开始」按钮
  // （点击转发到设置入口 [data-cgui="settings-btn"]）；侧栏随路由重建时自动重挂。
  var sidebarObserver = null;
  var observedSidebar = null;
  function installTaskbar() {
    // r39 稳态廉价早退：侧栏还在原处且任务栏已挂 → 什么都不查直接回。rootObserver 盯的是
    // 整个 body，流式输出一秒几十批变化，稳态下不早退就等于每批都全树查一遍（卡死根因）。
    // 侧栏被路由重建（isConnected=false）或任务栏被 React 抹掉时，判据自然落空走重路径。
    if (observedSidebar && observedSidebar.isConnected && observedSidebar.querySelector('.cgui-xp-taskbar')) return;
    var sidebar = document.querySelector('[data-cgui="sidebar"]');
    if (sidebar && !sidebar.querySelector('.cgui-xp-taskbar')) {
      var bar = document.createElement('div');
      bar.className = 'cgui-xp-taskbar';
      var start = document.createElement('button');
      start.type = 'button';
      start.className = 'cgui-xp-start';
      var startIcon = document.createElement('span');
      startIcon.className = 'cgui-xp-start-icon';
      startIcon.innerHTML = FLAG_SVG;
      start.appendChild(startIcon);
      start.appendChild(document.createTextNode('开始'));
      start.addEventListener('click', function () {
        var settings = document.querySelector('[data-cgui="settings-btn"]');
        if (settings) settings.click();
      });
      bar.appendChild(start);
      sidebar.appendChild(bar);
    }
    if (sidebar !== observedSidebar) {
      if (sidebarObserver) { sidebarObserver.disconnect(); sidebarObserver = null; }
      observedSidebar = sidebar;
      if (sidebar) {
        sidebarObserver = new MutationObserver(syncCurrentRow);
        sidebarObserver.observe(sidebar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      }
    }
    syncCurrentRow();
  }
  // r39 合帧：一帧内多批 DOM 变化只跑一次早退检查（原来是每批同步跑一次安装流程）。
  var rootRaf = 0;
  var rootObserver = new MutationObserver(function () {
    if (rootRaf) return;
    rootRaf = requestAnimationFrame(function () { rootRaf = 0; installTaskbar(); });
  });
  rootObserver.observe(body, { childList: true, subtree: true });
  installTaskbar();

  // 四色旗 favicon + 窗口标题
  var favicon = document.createElement('link');
  favicon.rel = 'icon';
  favicon.href = 'data:image/svg+xml;utf8,' + encodeURIComponent(FLAG_SVG);
  document.head.appendChild(favicon);
  document.title = SKIN_TITLE;

  body.appendChild(titlebar);
  body.appendChild(statusbar);
  // r47:用户裁定标题栏【顶格靠左】(基础 padding 即位),对齐 logo 的整套校准机器退役不再武装。

  window.__cguiSkinDispose = function () {
    disposeAlign();
    rootObserver.disconnect();
    if (rootRaf) { cancelAnimationFrame(rootRaf); rootRaf = 0; }
    if (sidebarObserver) sidebarObserver.disconnect();
    deskObserver.disconnect();
    window.removeEventListener('resize', fitDesk);
    body.style.removeProperty('--app-h');
    body.style.removeProperty('--app-w');
    body.removeAttribute('data-cgui-xp');
    titlebar.remove();
    statusbar.remove();
    favicon.remove();
    var bars = document.querySelectorAll('.cgui-xp-taskbar');
    for (var m = 0; m < bars.length; m++) bars[m].remove();
    var marked = document.querySelectorAll('.cgui-xp-current');
    for (var n = 0; n < marked.length; n++) marked[n].classList.remove('cgui-xp-current');
    if (document.title === SKIN_TITLE) document.title = originalTitle;
  };
})();
