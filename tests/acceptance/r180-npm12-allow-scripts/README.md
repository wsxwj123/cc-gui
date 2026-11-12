# r180-npm12-allow-scripts 验收用例

验证「npm 安装 / 更新 Claude Code 的命令」会放行 `@anthropic-ai/claude-code` 的安装后脚本,装完自检,失败时给出补救命令。

## 一条命令跑全套

在仓库根目录执行(退出码 0 = 全过,非 0 = 有失败;逐条打印用例名与 ✔ / ✖):

```sh
node --test --test-force-exit --test-reporter=spec tests/acceptance/r180-npm12-allow-scripts/r180.acceptance.mjs
```

## 说明

- 只调用 `server/routes/version-check.js` 导出的 `installCmdFor` / `updateCmdFor`。
- 其他平台(darwin)的命令用 `bash -c` 真执行,`PATH` 最前面是假 npm(`fake-npm.sh`,三种模式 `strict` / `legacy` / `broken`,由环境变量 `FAKE_NPM_MODE` 切换,参数记到 `FAKE_NPM_LOG`)。
- Windows 的命令只核对返回的字符串,不执行。
- 每条用例自建临时目录并在结束时删除;导入模块前 `HOME` 与 `USERPROFILE` 已指向临时目录。
- 不联网、不启动应用、不运行真实 npm。

## 用例清单

| 编号 | 场景 |
| --- | --- |
| I1 | strict、默认前缀可写:装完 claude 能运行,输出 `9.9.9 (Claude Code)` |
| I2 | strict:install 调用的放行名单只有 `@anthropic-ai/claude-code` |
| I3 | legacy:装完 claude 能运行 |
| I4 | broken:退出码非零,提示「没有装完整」,给出补救命令,无成功话术 |
| I5 | 默认前缀不可写:改装到 `~/.npm-global`,放行名单同 I2 |
| I6 | 写 `~/.zshrc` 的 PATH 行:首次恰好一行,前缀已在 PATH 时不再追加 |
| I7 | 不改用户 npm 配置:无 `.npmrc`,无 `config set` 调用 |
| U1 | npm-registry 更新(strict):退出码 0,输出含版本号 |
| U2 | npm-registry 更新:包说明符 `@latest`,放行名单只有该包 |
| U3 | npm / native 更新命令不含 `npm install`、`allow-scripts` |
| W1 | Windows 安装命令:`call npm install -g` 开头,含放行参数,保留 PowerShell 写 PATH 部分 |
| W2 | Windows 安装命令含装后自检(PowerShell 段内 `claude.cmd` + `--version`)与失败说明 |
| W3 | Windows npm-registry 更新命令:含放行参数与 `@latest`,以 `call claude --version` 结尾 |
| N1 | 原生安装命令(darwin / win32)不含 `npm install`、`allow-scripts` |
