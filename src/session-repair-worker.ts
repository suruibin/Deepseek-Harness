/**
 * 会话日志修复的 worker 线程入口。
 *
 * repairSessionLogs 的 fs 扫描、zstd 解压/压缩与 JSONL 解析全部是同步
 * CPU 密集操作，直接在主进程执行会阻塞事件循环——启动修复期间所有 IPC
 * 与窗口交互都停摆。挪到 worker 线程后主进程只等一条报告消息。
 * 主进程侧入口见 session-repair.ts 的 repairSessionLogsAsync()。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { repairSessionLogs } from './session-repair.ts'

const data = workerData as { root?: unknown } | undefined
const root = typeof data?.root === 'string' && data.root !== '' ? data.root : undefined
const report = repairSessionLogs(root)
parentPort?.postMessage(report)
