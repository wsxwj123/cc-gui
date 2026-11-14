# r184-small-fixes 验收套件

运行:在仓库(工作树)根目录执行 `bash tests/acceptance/r184-small-fixes/run.sh`;退出码 0 = 全过,非 0 = 有失败,末尾打印通过 / 失败 / 跳过计数。设 `R184_JUNIT=<文件路径>` 时同时写 junit 报告。
P 组(偏好文件 BOM)与 U 组(用量统计)起真后端 `server/index.js`:临时家目录、端口在 6700–6999 里挑空闲的(避开 6677/6689/6710/8788/8789/8798/8799)、挂断外网预载(`helpers/no-outbound.mjs`)、剥离 ANTHROPIC_* 与代理变量;只按自己记下的 pid 收尾。
I 组只 import `server/routes/version-check.js` 的 `installCmdFor` / `updateCmdFor`,darwin / linux 的安装命令用 bash + 假 npm(`helpers/fake-npm.sh`)在临时沙箱里真执行。
用例名以行为清单编号开头(P1–P7、I1–I5、U1–U2);T1 是 `tests/acceptance/r151b-xsession-p1/x20-ui-sidebar-settings.spec.mjs` 里 X22 的 `NOTICE` 常量同步,不在本套件里。
