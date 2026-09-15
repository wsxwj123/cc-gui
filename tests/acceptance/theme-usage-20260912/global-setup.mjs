// 跑任何用例之前的一次性预检：确认 BASE_URL 指的是**本套件自己的**隔离实例。
//
// 为什么要有这一步：本套件的用例只断言契约（不看实现），"实例指错了"不会报成环境错，
// 而是报成一堆像产品缺陷的红（终端不跟随主题、面板上没有折叠块、订阅卡找不到……）。
// 这里提前一句话说清。
import { ensureFixtureManifest, assertSuiteInstance } from './helpers/tu-runtime.mjs';

export default async function globalSetup() {
  const manifest = ensureFixtureManifest();
  if (!process.env.BASE_URL) return;
  const identity = await assertSuiteInstance(process.env.BASE_URL);
  process.stdout.write(
    `[TU] 预检通过：实例 ${identity.baseURL}（version=${identity.version}）`
    + ` 夹具会话 ${manifest.session.sessionId}\n`,
  );
}
