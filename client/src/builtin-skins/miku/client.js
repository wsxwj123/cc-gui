// 初音未来 · 电子歌姬 — cgui T2 客户端脚本（dsh appearance-gallery miku apply() 移植）。
// 职责：body 挂 data-cgui-miku 作用域标记、注入歌姬标题栏（音符 + 01 徽标 + 渐变）/
// 波形状态栏/漂浮音符装饰层/音符 favicon/窗口标题；--app-h/--app-w 按官方口径实算。
// 全部 DOM 变化经 window.__cguiSkinDispose 注册的卸载器逐项还原（三重卸载第一重）。
(function () {
  // 幂等装载：已有皮肤卸载器先卸（防重复注入叠加 chrome），再装本皮肤
  var prev = window.__cguiSkinDispose;
  if (typeof prev === 'function') { try { prev(); } catch (e) {} }

  var body = document.body;
  var originalTitle = document.title;
  var SKIN_TITLE = '初音未来 · Claude GUI 在线';

  // 卸载器引用计数：每挂一件 chrome/监听 track(+1)，dispose 逐项还原并 -1，归零即卸净。
  // 计数对象挂在 window 上供外部巡检形态（sentinel），卸载后摘走。
  var REF_KEY = '__cguiMikuRefs';
  var refs = { count: 0 };
  window[REF_KEY] = refs;
  var cleanups = [];
  function track(job) { refs.count += 1; cleanups.push(job); }

  // ── 内联 SVG（dsh miku 原版图形，无外部素材）──
  // 八分音符（tint 参数化：标题栏用歌姬蓝，音符层轮换蓝/紫/洋红）
  function noteSvg(size, tint) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 48 48" aria-hidden="true">'
      + '<path d="M32 8v20.6a8 8 0 1 1-4-6.9V13.4L20 16.8v17.8a8 8 0 1 1-4-6.9V12.2c0-.9.6-1.7 1.5-1.9l16-4.4c1-.3 2 .3 2.5 1.1.3.5.5 1 .5 1.5z" fill="' + tint + '"/>'
      + '<ellipse cx="24" cy="44" rx="7.5" ry="2.4" fill="rgba(0,0,0,0.18)"/>'
      + '</svg>';
  }
  // 01 徽标：歌姬机体编号，青色圆角芯片
  var BADGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="18" viewBox="0 0 68 36" aria-hidden="true">'
    + '<rect x="1" y="1" width="66" height="34" rx="8" fill="rgba(57,197,187,0.16)" stroke="#2e9bff" stroke-width="2"/>'
    + '<text x="34" y="25" text-anchor="middle" font-family="Consolas, monospace" font-size="19" font-weight="700" fill="#1e6fd9">01</text>'
    + '</svg>';
  // favicon：蓝底圆角方块 + 白色八分音符
  var FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">'
    + '<rect x="2" y="2" width="60" height="60" rx="14" fill="#2e9bff"/>'
    + '<path d="M42 14v24.6a10 10 0 1 1-5-8.7V20.6l-15 4.1v21.7a10 10 0 1 1-5-8.7V15.4c0-1 .7-2 1.7-2.2l19-5.2c1.2-.3 2.4.4 2.9 1.4.3.6.4 1.1.4 1.6z" fill="#fff"/>'
    + '</svg>';
  // 状态栏音乐波形（dsh mikuStatusbarWave 原路径）
  var WAVE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="12" viewBox="0 0 72 12" aria-hidden="true">'
    + '<path d="M1 6h3l2-4 2 8 2-9 2 6 2-3 2 5 2-7 2 4 2-2 2 3 2-6 2 7 2-5 2 4 2-3 2 2 2-4 2 3 2-2 2 1 2-3 2 2 2-1 2 2 2-4 2 2 2-1 2 1 2-2 2 2 2-1 1 1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

  body.setAttribute('data-cgui-miku', '');
  track(function () { body.removeAttribute('data-cgui-miku'); });

  // ── 悬浮窗尺寸：按 App 官方口径（innerHeight/zoom 的 zoom 不变量 px）写
  // body 作用域的 --app-h/--app-w，扣掉桌面边距(上34+下32=66、左右8+8=16)。
  // 跟踪 resize 与 html style 上的 zoom 变化（字体档切换）；卸载器全清。──
  var html = document.documentElement;

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
    body.style.setProperty('--app-h', (window.innerHeight / z - 66) + 'px');
    body.style.setProperty('--app-w', (window.innerWidth / z - 16) + 'px');
  }
  fitDesk();
  window.addEventListener('resize', fitDesk);
  var deskObserver = new MutationObserver(fitDesk);
  deskObserver.observe(html, { attributes: true, attributeFilter: ['style'] });
  track(function () {
    deskObserver.disconnect();
    window.removeEventListener('resize', fitDesk);
    body.style.removeProperty('--app-h');
    body.style.removeProperty('--app-w');
  });

  // ── 歌姬标题栏：音符 + 01 徽标 + 标题 + 装饰性 –□× ──
  var titlebar = document.createElement('div');
  titlebar.className = 'cgui-miku-titlebar';
  var icon = document.createElement('span');
  icon.className = 'cgui-miku-titlebar-icon';
  icon.innerHTML = noteSvg(18, '#2e9bff');
  var badge = document.createElement('span');
  badge.className = 'cgui-miku-titlebar-badge';
  badge.innerHTML = BADGE_SVG;
  var title = document.createElement('span');
  title.className = 'cgui-miku-titlebar-title';
  title.textContent = SKIN_TITLE;
  titlebar.appendChild(icon);
  titlebar.appendChild(badge);
  titlebar.appendChild(title);
  var glyphs = ['–', '□', '×'];
  for (var i = 0; i < glyphs.length; i++) {
    var btn = document.createElement('span');
    btn.className = 'cgui-miku-titlebar-btn';
    btn.setAttribute('aria-hidden', 'true');
    btn.textContent = glyphs[i];
    titlebar.appendChild(btn);
  }

  // ── 波形状态栏：波形 | （弹性） | MIKU 01 · 声库就绪 · 已连接 · 在线 · VOCALOID 正式版 ──
  var statusbar = document.createElement('div');
  statusbar.className = 'cgui-miku-statusbar';
  var wave = document.createElement('span');
  wave.className = 'cgui-miku-statusbar-wave';
  wave.innerHTML = WAVE_SVG;
  statusbar.appendChild(wave);
  var spacer = document.createElement('span');
  spacer.className = 'cgui-miku-statusbar-spacer';
  statusbar.appendChild(spacer);
  var cells = ['MIKU 01', '声库就绪', '已连接', '在线', 'VOCALOID 正式版'];
  for (var j = 0; j < cells.length; j++) {
    var cell = document.createElement('span');
    cell.className = 'cgui-miku-statusbar-cell';
    cell.textContent = cells[j];
    statusbar.appendChild(cell);
  }

  // ── 漂浮音符装饰层：dsh 背景画里的蓝/紫/洋红音符改写为可卸载 DOM，
  // 压在毛玻璃 #root 之下（skin.css z-index 分层），从半透明面板透出来。──
  var notesLayer = document.createElement('div');
  notesLayer.className = 'cgui-miku-notes';
  notesLayer.setAttribute('aria-hidden', 'true');
  var NOTE_SPOTS = [
    { left: '5%',  top: '14%', size: 22, tint: '#2e9bff', dur: '6.4s', delay: '0s' },
    { left: '13%', top: '62%', size: 16, tint: '#ff4da6', dur: '7.8s', delay: '-2.1s' },
    { left: '80%', top: '12%', size: 26, tint: '#9b5dff', dur: '7.0s', delay: '-1.2s' },
    { left: '90%', top: '58%', size: 18, tint: '#2e9bff', dur: '8.6s', delay: '-3.4s' },
    { left: '66%', top: '84%', size: 20, tint: '#ff4da6', dur: '6.9s', delay: '-4.6s' },
    { left: '38%', top: '6%',  size: 14, tint: '#9b5dff', dur: '9.2s', delay: '-5.5s' }
  ];
  for (var k = 0; k < NOTE_SPOTS.length; k++) {
    var spot = NOTE_SPOTS[k];
    var note = document.createElement('span');
    note.className = 'cgui-miku-note';
    note.style.left = spot.left;
    note.style.top = spot.top;
    note.style.animationDuration = spot.dur;
    note.style.animationDelay = spot.delay;
    note.innerHTML = noteSvg(spot.size, spot.tint);
    notesLayer.appendChild(note);
  }

  // ── favicon + 窗口标题 ──
  var favicon = document.createElement('link');
  favicon.rel = 'icon';
  favicon.href = 'data:image/svg+xml;utf8,' + encodeURIComponent(FAVICON_SVG);
  document.head.appendChild(favicon);
  document.title = SKIN_TITLE;

  body.appendChild(notesLayer);
  body.appendChild(titlebar);
  // r47:用户裁定标题栏【顶格靠左】(基础 padding 即位),对齐 logo 的整套校准机器退役不再武装。
  body.appendChild(statusbar);
  track(disposeAlign);   // 对齐的全部句柄(首帧 rAF/settle 链/topbar 观察器)按计数核销
  track(function () { notesLayer.remove(); });
  track(function () { titlebar.remove(); });
  track(function () { statusbar.remove(); });
  track(function () { favicon.remove(); });
  track(function () { if (document.title === SKIN_TITLE) document.title = originalTitle; });

  // ── 卸载器：按引用计数逐项还原（倒序弹出，单项异常不阻断后续还原）──
  window.__cguiSkinDispose = function () {
    while (cleanups.length) {
      var job = cleanups.pop();
      try { job(); } catch (e) {}
      refs.count -= 1;
    }
    if (window[REF_KEY] === refs) window[REF_KEY] = null;
  };
})();
