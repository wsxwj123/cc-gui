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
  body.appendChild(statusbar);
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
