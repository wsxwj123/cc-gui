#!/usr/bin/env node
// CC-GUI npm 启动器薄壳。唯一职责:确认 Node 版本达标,再加载主体 lib/main.js。
// 本文件必须保持 ES5 语法 -- 老 Node 按整文件解析,出现任何新语法都会先抛
// SyntaxError,用户就永远看不到下面这句升级提示了(单测有 ES5 纯度断言)。
'use strict';
var nodeMajor = parseInt(process.versions.node, 10);
if (nodeMajor < 20) {
  process.stderr.write(
    'CC-GUI 需要 Node.js 20 或更高版本，当前是 v' + process.versions.node + '。\n' +
    '请升级 Node.js 后重试：https://nodejs.org/en/download\n'
  );
  process.exit(3);
}
require('../lib/main.js');
