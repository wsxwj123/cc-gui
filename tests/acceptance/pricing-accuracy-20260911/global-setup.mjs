// 跑任何用例之前的一次性预检：确认 BASE_URL 指的是**本套件自己的**隔离实例。
//
// 为什么要有这一步：这个套件的用例只断言契约（不看实现），所以"实例指错了"不会报成环境错，
// 而是报成一堆像产品缺陷的红（缺 byPeriod/usageCalls、D 项文案还是旧的、派生夹具会话 404……），
// 实测 2026-09-12 的一次全量跑就这么白查了 20 条。这里提前一句话说清。
//
// PA-423…425 自己起一次性实例、不需要 BASE_URL，所以没有 BASE_URL 时直接跳过（保持单跑可用）。
import { getRuntime, assertSuiteInstance } from './helpers/pa-runtime.mjs';

export default async function globalSetup() {
  if (!process.env.BASE_URL) return;
  const { baseURL } = getRuntime({ requireManifest: true });
  const identity = await assertSuiteInstance(baseURL);
  process.stdout.write(
    `[PA] 预检通过：实例 ${baseURL}（version=${identity.version} serverEpoch=${identity.serverEpoch}）\n`,
  );
}
