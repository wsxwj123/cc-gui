// r13-p2-20:更新渠道(npm / 原生 两项,与安装方式一一对应)。
// 背景纠错:R8-1 把 npm 安装的更新一律导向原生 `claude update`,理由"npm 慢源"。
// 用户实测反驳并复测:慢的是 registry 元数据重定向(660 B/s),真正拉包的
// cdn.npmmirror 达 2.23 MB/s,比原生二进制源经代理(1.04 MB/s)快一倍。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UPDATE_CHANNELS, resolveUpdateMethod, effectiveChannel, updateCmdFor } from '../../server/routes/version-check.js';

// t1 只有两项(不设第三种"自动"状态占 UI 格子)
{
  assert.deepEqual(UPDATE_CHANNELS, ['npm', 'native'], 't1: 两项与安装方式一一对应');
}

// t2 未选过 = 跟随安装方式
{
  assert.equal(effectiveChannel(null, 'npm'), 'npm', 't2: npm 装的默认走 npm');
  assert.equal(effectiveChannel(null, 'native'), 'native', 't2: 原生装的默认走原生');
  assert.equal(effectiveChannel(null, 'brew'), 'native', 't2: 其它方式回落原生');
  assert.equal(effectiveChannel('native', 'npm'), 'native', 't2: 显式选择优先于安装方式');
}

// t3 解析为实际更新方式
{
  // (r26-C1) 换锚:跨渠道(显式 npm 渠道 × 非 npm 安装)裸解析必须回 null,不再静默
  // 回 'npm-registry'(防装到另一份安装、自检命中 PATH 旧版假成功);显式确认回执
  // allowCrossChannel 才放行。
  assert.equal(resolveUpdateMethod('npm', 'native'), null, 't3: 跨渠道(npm×native)裸解析回 null(r26-C1)');
  assert.equal(resolveUpdateMethod('npm', 'native', { allowCrossChannel: true }), 'npm-registry', 't3: 显式确认回执放行 npm 装(r26-C1)');
  assert.equal(resolveUpdateMethod('native', 'npm'), 'native', 't3: 选原生 → 走原生自更新');
  assert.equal(resolveUpdateMethod(null, 'npm'), 'npm-registry', 't3: 未选 + npm 安装 → npm');
  assert.equal(resolveUpdateMethod(null, 'native'), 'native', 't3: 未选 + 原生安装 → 原生');
}

// t4 命令形态:npm 渠道必须真的走 npm 且装完自检版本(防只拉到引导壳)
{
  const cmd = updateCmdFor('npm-registry', '/x/claude');
  assert.match(cmd, /npm install -g @anthropic-ai\/claude-code@latest/, 't4: 真的走 npm');
  // (r26-C1) 换锚:自检钉到 npm 前缀里的新安装(posix);win 分支仍为 call claude --version。
  assert.match(cmd, /("\$\(npm prefix -g\)\/bin\/claude"|call claude) --version/, 't4: 装完自检钉到刚装的安装(壳包不会自检通过)(r26-C1)');
  const native = updateCmdFor('native', '/x/claude');
  assert.doesNotMatch(native, /npm install/, 't4: 原生渠道不碰 npm');
}

// t5 接线守卫:三个消费点都按渠道解析,不再写死安装方式
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  // (r26-C1) 换锚:三处调用现带第三参回执/局部 channel 变量,锚放宽为两种实参形态。
  const hits = (src.match(/resolveUpdateMethod\((readUpdateChannel\(\)|channel), method/g) || []).length;
  assert.equal(hits, 3, 't5: version-check / update / update-stream 三处齐(哨兵锚)');
  assert.match(src, /router\.(get|put)\('\/claude-update-channel'/, 't5: 渠道端点在位');
}

console.log('check-update-channel: all passed (r13-p2-20)');

// t6(r13-p2-21):更新改服务端后台任务 —— 关面板/断连不得杀进程。
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const stream = src.slice(src.indexOf("router.post('/claude-update/stream'"), src.indexOf("router.get('/claude-update/status'"));
  // 断连处理必须只摘监听,绝不 killTree(哨兵锚:改回 killUpdateTree 即红)
  assert.match(stream, /req\.on\('close', \(\) => \{ updateTask\.listeners\.delete\(res\); \}\)/, 't6: 断连只摘监听');
  assert.ok(!/req\.on\('close'[^)]*kill/i.test(stream), 't6: 断连不得杀进程(用户实报"关面板更新就停")');
  // 已在跑 → 挂上去续看,不重复起进程
  assert.match(stream, /if \(updateTask\.status === 'running'\)/, 't6: 复用在跑的任务');
  assert.match(stream, /attached: true/, 't6: 续看标记');
  // r34:8 分钟【不再杀】—— `npm i -g` 非原子,强杀落在"旧包已删、新包没解压完"的窗口
  // 会直接毁掉用户的安装(Windows 实报)。改为 8 分钟只提示、60 分钟极限兜底才杀。
  assert.match(stream, /const clearUpdateTimers = startUpdateTimers\(\)/, 't6: 定时器走 startUpdateTimers');
  assert.ok(!/8 \* 60 \* 1000/.test(stream), 't6: stream 里不得再有 8 分钟强杀定时器(哨兵锚:改回即红)');
  // 更硬的锚:整个 stream 路由里不得出现任何杀进程调用 —— 只挡 8 分钟那个字面量的话,
  // 后人另加一条 setTimeout(kill, N) 照样溜过去。终止只许发生在 cancel 端点与兜底定时器。
  assert.ok(!/kill(UpdateTree)?\(/.test(stream), 't6: stream 路由内不得直接杀进程');
  // 对账与主动取消端点
  assert.match(src, /router\.get\('\/claude-update\/status'/, 't6: 状态对账端点');
  assert.match(src, /router\.post\('\/claude-update\/cancel'/, 't6: 主动取消端点(关面板不再等于取消)');
  // r34:取消是超时不再自动杀之后【唯一】的终止口,必须真的杀(此前零覆盖)
  assert.match(src, /router\.post\('\/claude-update\/cancel'[\s\S]{0,600}killUpdateTree\(\)/, 't6: cancel 端点真杀进程树');
  // r34-③:正向计数锚 —— 三个"把代理喂给子进程/终端脚本"的注入点都必须走探活版本。
  // 反向断言(不许出现 detectLocalProxy().catch)挡不住换名/换写法的回退。
  assert.equal((src.match(/detectLiveProxy\(\)/g) || []).length, 3 + 1, 't6: 三个注入点 + 一处定义,全走探活代理');
  // 前端:挂载对账 + 续看复用同一流函数
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /fetch\('\/api\/claude-update\/status'\)/, 't6: 前端挂载对账');
  assert.match(ui, /doUpdateStream\(\{ attach: true \}\)/, 't6: 还在跑则自动续看');
}
