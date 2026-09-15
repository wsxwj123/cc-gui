// 服务实例标识(INTERFACE R13「会话流与子代理」)。进程启动时生成一次,同一实例内恒定,
// 后端重启必变 —— 客户端把上次已知的值随 (clientTurnId) 一起上报,后端据此拒绝"上一个
// 实例的旧请求"(409 TURN_SERVER_CHANGED),而不是把它当新 turn 重发。
// 形状:[0-9a-z]+-[0-9a-f]{16} —— 无空白字符,长度 ≤128,可直接进 JSON/日志/URL。
import { randomBytes } from 'node:crypto';

export const SERVER_EPOCH = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
