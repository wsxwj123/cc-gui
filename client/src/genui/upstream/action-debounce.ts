/**
 * CGUI-PATCH(PLAN §1.2.6):在飞的去抖定时器,**移出组件、放模块级 Map、卸载不清理**。
 *
 * 上游把定时器挂在组件里、unmount 时 `clearTimeout` 全部在飞定时器(是 clear 不是
 * flush)。而回合末围栏子树连挂两次,正撞 300ms 去抖窗口:用户在回合结束前 300ms 内
 * 点的按钮 —— 消息既没发也没入队,且完全静默。这恰是最常触发的时间窗(用户看模型
 * 快写完了才去点)。定时器留在模块级则天然只有一份,重挂不吞;比"unmount 时 flush"
 * 更简单 —— flush 要处理"两次重挂 = 两次 flush"的重复发送。
 *
 * 单独成文件不是分层洁癖:GenuiBlock 是 .tsx,裸 node 加载不了(仓内单测惯例只能做
 * 源码文本锁);这里是纯 .ts,假时钟单测能真跑它的**行为**。
 * @module genui/action-debounce
 */

export const GENUI_ACTION_DEBOUNCE_MS = 300

const pending = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 同键排期:后一次取消前一次,只跑最后一次(尾去抖)。
 *
 * ponytail: 条目触发后自删,峰值 = 同时在飞的点击数(个位数),不做淘汰。
 * `setTimeout` 走全局解析(不在模块加载期捕获),测试替换 globalThis 即可注入假时钟。
 */
export function scheduleAction(key: string, run: () => void): void {
  const existing = pending.get(key)
  if (existing !== undefined) clearTimeout(existing)
  pending.set(key, setTimeout(() => {
    pending.delete(key)
    run()
  }, GENUI_ACTION_DEBOUNCE_MS))
}

/** 在飞条目数。只给单测用 —— "触发后自删"在行为上不可观测,不暴露就只能靠文本锁。 */
export function pendingActionCount(): number {
  return pending.size
}
