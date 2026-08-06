// 白盒:isLocalReq 三信号判定(socket ∧ 无CF四件套 ∧ Host缺省或本机集)与
// getTunnelHostname 配置校验的全部边界。依据:.devflow/INTERFACE-tunnel.md §4。
// node tests/unit/check-tunnel-auth.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离 HOME:auth.js 在模块加载期用 homedir() 定住 network.json 路径,
// 必须在 import 前改,且只能动态 import。
const home = mkdtempSync(join(tmpdir(), 'cgui-tunnel-auth-'));
mkdirSync(join(home, '.claude-gui'), { recursive: true });
const confPath = join(home, '.claude-gui', 'network.json');
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows

const { isLocalReq, getTunnelHostname, requestHostname } = await import('../../server/services/auth.js');

// ── 造 req:socket + headers(node 的 header 名已是小写)─────────────
const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });

// ── 1) requestHostname(剥端口,[v6] 归一化)────────────────────────
assert.equal(requestHostname(req('1.2.3.4', { host: 'localhost:6677' })), 'localhost');
assert.equal(requestHostname(req('1.2.3.4', { host: '127.0.0.1:6677' })), '127.0.0.1');
assert.equal(requestHostname(req('1.2.3.4', { host: '[::1]:6677' })), '::1', '[v6]:port 必须正确剥括号与端口');
assert.equal(requestHostname(req('1.2.3.4', {})), '', 'Host 缺失 → 空串');
assert.equal(requestHostname(req('1.2.3.4')), '', 'headers 整体缺失 → 空串');

// ── 2) isLocalReq:本机全形态必须免密(改错把本机锁死=高危)──────────
assert.equal(isLocalReq(req('127.0.0.1')), true, '127.0.0.1 无头');
assert.equal(isLocalReq(req('::1')), true, '::1 无头');
assert.equal(isLocalReq(req('::ffff:127.0.0.1')), true, 'v4-mapped v6 回环');
assert.equal(isLocalReq(req('127.0.0.1', { host: 'localhost:6677' })), true, 'Host=localhost:6677');
assert.equal(isLocalReq(req('127.0.0.1', { host: '127.0.0.1:6677' })), true, 'Host=127.0.0.1:6677');
assert.equal(isLocalReq(req('::1', { host: '[::1]:6677' })), true, 'Host=[::1]:6677');
assert.equal(isLocalReq(req('127.0.0.1', { host: 'localhost' })), true, 'Host=localhost 无端口');

// ── 3) isLocalReq:CF 四件套任一存在即外部(隧道流量带全四件)─────────
for (const h of ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cf-ipcountry']) {
  assert.equal(isLocalReq(req('127.0.0.1', { [h]: 'x' })), false, `回环+${h} → 外部`);
}
// 四件套之外的 cf-* 不参与判定(INTERFACE 枚举口径)
assert.equal(isLocalReq(req('127.0.0.1', { 'cdn-loop': 'cloudflare' })), true, 'cdn-loop 不在判定集');
assert.equal(isLocalReq(req('127.0.0.1', { 'cf-cache-status': 'HIT' })), true, 'cf-cache-status 不在判定集');
// 隧道全形态:回环 socket + 四件套 + Host=隧道域名 → 外部(双否决)
assert.equal(
  isLocalReq(req('::ffff:127.0.0.1', {
    host: 'tunnel.example.com',
    'cf-ray': 'r', 'cf-connecting-ip': '203.0.113.9', 'cf-visitor': 'v', 'cf-ipcountry': 'US',
  })),
  false, '隧道正常流量绝不免密',
);
// 伪造 Host: localhost 冒充本机:CF 否决兜住
assert.equal(
  isLocalReq(req('127.0.0.1', { host: 'localhost', 'cf-ray': 'r', 'cf-connecting-ip': '203.0.113.9' })),
  false, '伪造 Host:localhost + CF 头 → 外部',
);

// ── 4) isLocalReq:无 CF 头但 Host 非本机集 → 外部(Host 独立否决)───
assert.equal(isLocalReq(req('127.0.0.1', { host: 'tunnel.example.com' })), false, 'Host=隧道域名无CF头 → 外部');
assert.equal(isLocalReq(req('127.0.0.1', { host: 'evil.com' })), false, 'Host=evil.com → 外部');
assert.equal(isLocalReq(req('127.0.0.1', { host: '127.0.0.1.evil.com' })), false, '本机名前缀域名 → 外部');

// ── 5) isLocalReq:非回环 socket 一律外部(LAN,伪造什么都救不回来)────
assert.equal(isLocalReq(req('192.168.1.5')), false, 'LAN socket');
assert.equal(isLocalReq(req('192.168.1.5', { host: 'localhost' })), false, 'LAN socket + Host:localhost');
assert.equal(isLocalReq(req('10.0.0.2', { host: '127.0.0.1:6677' })), false, 'LAN socket + Host:127.0.0.1');
assert.equal(isLocalReq(req('203.0.113.9')), false, '公网 socket');
// 拿不准一律外部
assert.equal(isLocalReq(req('')), false, '空 socket');
assert.equal(isLocalReq(req(undefined)), false, 'socket 缺失');
assert.equal(isLocalReq(null), false, 'req 为 null');
assert.equal(isLocalReq(undefined), false, 'req 缺失');

// ── 6) getTunnelHostname:缺省/非法 → ''(=不放行,写错不炸)─────────
const writeConf = (obj) => writeFileSync(confPath, JSON.stringify(obj));

assert.equal(getTunnelHostname(), '', '配置文件不存在 → 未配置');
writeConf({ host: '0.0.0.0', port: 6677 });
assert.equal(getTunnelHostname(), '', '无 tunnelHostname 键 → 未配置');
writeConf({ tunnelHostname: '' });
assert.equal(getTunnelHostname(), '', '空串 → 未配置');
writeConf({ tunnelHostname: 12345 });
assert.equal(getTunnelHostname(), '', '非 string → 未配置');
writeConf({ tunnelHostname: 'https://tunnel.example.com' });
assert.equal(getTunnelHostname(), '', '带 scheme → 非法');
writeConf({ tunnelHostname: 'tunnel.example.com:443' });
assert.equal(getTunnelHostname(), '', '带端口 → 非法');
writeConf({ tunnelHostname: 'tunnel.example.com/path' });
assert.equal(getTunnelHostname(), '', '带路径 → 非法');
writeConf({ tunnelHostname: '-bad.example.com' });
assert.equal(getTunnelHostname(), '', '连字符开头 → 非法');
writeConf({ tunnelHostname: 'bad.example.com-' });
assert.equal(getTunnelHostname(), '', '连字符结尾 → 非法');

// ── 7) getTunnelHostname:合法值放行并小写化;每请求现读(改文件即生效)──
writeConf({ tunnelHostname: 'tunnel.example.com' });
assert.equal(getTunnelHostname(), 'tunnel.example.com');
writeConf({ tunnelHostname: 'TUNNEL.Example.COM' });
assert.equal(getTunnelHostname(), 'tunnel.example.com', '大写必须归一到小写(Host 头比较口径)');
writeConf({ tunnelHostname: 'a' });
assert.equal(getTunnelHostname(), 'a', '单字符主机名合法');
writeConf({ tunnelHostname: '6677.wsxwj123.top' });
assert.equal(getTunnelHostname(), '6677.wsxwj123.top');

console.log('check-tunnel-auth: all assertions passed');
