// 工作流条目的"补建"判据(纯函数,node 直跑可测)。
//
// 背景:activeAgents 是纯内存 map(store 无 persist),工作流的条目【只由 live 的
// task_started 建】。刷新/重开页面后条目就没了,而之后每 ~10s 一份的进度事件
// (SSE 的 task_progress / WS 兜底的 workflow-progress-bg)原来一律"只更新已存在条目"
// → 进度全落在空处,卡片停在「此运行未提供进度信息」「状态未知」。
//
// 进度事件本身带齐了身份(tool_use_id + task_id + 归属会话),缺条目时按最小形态补一条
// 即可让它重新接上直播。两条投递路径共用这一个判据,免得两处各写一半慢慢漂。
//
// 两条硬要求:
//   ① 归属会话不可缺 —— 条目少了 sessionId 就绕过 resolveOwnedAgent 的会话校验,
//      在一张 fork/别的会话的同名 tool_use_id 卡片上冒出来(本项目在 fork 上踩过串台);
//   ② 最小形态,不编字段 —— name/startedAt 编出来就是"从刷新那刻起算的假耗时"、
//      "拿进度描述冒充工作流名"。taskManaged: true 与 live 建的条目一致,这样回合末
//      的兜底收尾(!turnAborted && taskManaged → 跳过)不会把还在后台跑的工作流猜成已结束。

/**
 * 缺条目时该补出什么(已有条目 / 缺身份 → null,让调用方走原来的"只更新"路径)。
 * @param {{toolUseId?:string, taskId?:string|null, sessionId?:string|null, existing?:object|null}} input
 * @returns {{workflow:true, taskManaged:true, status:'working', taskId:string|null, sessionId:string}|null}
 */
export function rebuildWorkflowEntry(input) {
  const { toolUseId = null, taskId = null, sessionId = null, existing = null } = input || {};
  if (existing) return null;                                        // 在跑的条目是权威值,一个字都不动
  if (typeof toolUseId !== 'string' || !toolUseId) return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;      // 无归属不建(见文件头 ①)
  return {
    workflow: true,
    taskManaged: true,
    status: 'working',
    // taskId 缺失(老会话解析不出)照样建:进度能显示才是主要目的,它只是 task_updated
    // 跨回合反查的一把钥匙。缺就补 null,不编一个假编号。
    taskId: typeof taskId === 'string' && taskId ? taskId : null,
    sessionId,
  };
}
