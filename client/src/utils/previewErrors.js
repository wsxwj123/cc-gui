// F2 preview 开发者模式:采集 AI 生成的 HTML artifact 在沙箱 iframe 里的运行时报错,
// 一键格式化后经 cgui:composer-fill 填进输入框喂给 AI 自查。
// 纯逻辑(注入脚本字符串 + 记录规整 + 摘要格式化)集中在此,便于 node 单测,不依赖 React/DOM。

// iframe → 父页的 postMessage 载荷键。sandbox 无 allow-same-origin(opaque origin),
// 只能靠这个约定键 + event.source 比对识别自己 iframe 的采集消息。
export const PREVIEW_ERR_KEY = '__cguiPreviewErr';

// 摘要里各类型的中文标签(客观陈述)。
export const PREVIEW_ERR_LABEL = {
  error: '运行时错误',
  reject: '未处理拒绝',
  console: 'console.error',
  net: '网络请求',
};

const MAX_MSG = 300;      // 单条消息截断(防超长堆栈爆屏)
const MAX_URL = 200;      // 单条 url 截断
export const MAX_PREVIEW_ERRORS = 50;   // buffer 上限
const MAX_SUMMARY = 4000; // 摘要总量截断

function clamp(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 注入进 srcDoc <head> 的采集脚本:onerror / unhandledrejection / console.error(保留原行为)
// / fetch 失败(status>=400 或网络错)→ postMessage 穿透 sandbox 发给父页。全程 try/catch,
// 采集脚本自身绝不影响 artifact 运行。用 addEventListener('error') 而非覆盖 window.onerror,
// 避免踩掉 artifact 自己的错误处理。
export const ERROR_COLLECTOR = `<script>
(function(){
  var K=${JSON.stringify(PREVIEW_ERR_KEY)};
  function send(o){try{var m={};m[K]=o;parent.postMessage(m,'*');}catch(e){}}
  window.addEventListener('error',function(e){try{send({type:'error',msg:(e&&e.message)||'脚本错误',line:e&&e.lineno,col:e&&e.colno});}catch(x){}});
  window.addEventListener('unhandledrejection',function(e){try{var r=e&&e.reason;send({type:'reject',msg:''+((r&&(r.message||r.toString&&r.toString()))||r)});}catch(x){}});
  try{var _e=console.error;console.error=function(){try{send({type:'console',msg:Array.prototype.map.call(arguments,String).join(' ')});}catch(x){}return _e.apply(console,arguments);};}catch(x){}
  try{if(window.fetch){var _f=window.fetch;window.fetch=function(){var a=arguments;var u=(a[0]&&a[0].url)||a[0];return _f.apply(window,a).then(function(r){if(r&&!r.ok)send({type:'net',url:u,status:r.status});return r;}).catch(function(err){send({type:'net',url:u,err:''+err});throw err;});};}}catch(x){}
})();
</script>`;

// 把原始采集记录规整成 {type, text, sig}:text 供展示/摘要,sig 供去重。非法输入返回 null。
export function normalizePreviewErr(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const type = PREVIEW_ERR_LABEL[rec.type] ? String(rec.type) : 'error';
  let text;
  if (type === 'net') {
    const head = rec.status ? `HTTP ${rec.status}` : `请求失败${rec.err ? ': ' + clamp(rec.err, MAX_MSG) : ''}`;
    text = head + (rec.url ? ` ${clamp(rec.url, MAX_URL)}` : '');
  } else if (type === 'error') {
    text = clamp(rec.msg || '脚本错误', MAX_MSG);
    if (rec.line != null) text += ` (行 ${rec.line}${rec.col != null ? ':' + rec.col : ''})`;
  } else {
    text = clamp(rec.msg, MAX_MSG);
  }
  return { type, text, sig: type + '|' + text };
}

// 把已采集的错误列表格式化成简洁文本(每条 类型+消息+行号),供填进输入框。空列表返回 ''。
export function formatPreviewErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const lines = errors.map((e, i) => `${i + 1}. [${PREVIEW_ERR_LABEL[e.type] || e.type}] ${e.text}`);
  let body = lines.join('\n');
  if (body.length > MAX_SUMMARY) body = body.slice(0, MAX_SUMMARY) + '\n…(已截断)';
  return `预览运行时捕获到 ${errors.length} 条报错,请排查并修正上面的 HTML:\n\n\`\`\`\n${body}\n\`\`\``;
}
