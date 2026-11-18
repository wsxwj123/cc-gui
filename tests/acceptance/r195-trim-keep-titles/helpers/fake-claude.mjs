#!/usr/bin/env node
// 假 claude:只服务「回退并压缩」预览起的那一次 `claude -p --permission-mode plan --no-session-persistence`:
// 读完标准输入,打印一段固定的、够长的摘要后退出。--version 等其它调用给个短输出。
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

if (argv.includes('-p') || argv.includes('--print')) {
  try { fs.readFileSync(0); } catch { /* 标准输入关闭也算读完 */ }
  process.stdout.write('本段对话里用户先提出了第一个问题并得到回答,随后又追问了第二个问题。这是测试用的固定摘要,长度远超二十个字,用于被写进会话记录。\n');
  process.exit(0);
}
console.log('fake claude: nothing to do');
process.exit(0);
