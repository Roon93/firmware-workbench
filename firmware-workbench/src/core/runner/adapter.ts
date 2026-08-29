import type { Task } from '../../types.js'
import type { Workbench } from '../workbench.js'
import { runTaskLocally, type RunTaskResult } from './local.js'

/**
 * RunnerAdapter 边界(方案 5.2 / 18.1 / 18.3):
 * 领域模型只依赖本接口语义,不依赖具体执行内核。
 * MVP 内核 = LocalRunner(SQLite 状态机);Dagu Spike 结论见 spike/dagu/dagu-spike-report.md,
 * 若未来下放长任务给 Dagu,实现本接口接入,禁止领域代码直接引用 Dagu 文件格式。
 */
export interface RunnerAdapter {
  readonly name: string
  /** 端到端运行单个任务:租约、动作、验证、清理由内核按工作台状态机驱动 */
  run(workbench: Workbench, taskId: string, options?: RunTaskOptions): Promise<RunTaskResult>
  /** 取消运行中任务(内核负责子进程终止与清理;租约释放统一走 Workbench) */
  cancel(taskId: string): Promise<void>
  /** 内核是否支持该任务(如 Dagu 适配器可只接 L3/L4 长任务) */
  supports(task: Task): boolean
}

export interface RunTaskOptions {
  actor?: string
  timeoutMinutes?: number
  humanAutoAccept?: boolean
}

/** 当前内核:LocalRunner(实现于 local.ts;Dagu 适配器待真机阶段按需接入) */
export const localRunner: RunnerAdapter = {
  name: 'local-sqlite',
  run: (workbench, taskId, options) => runTaskLocally(workbench, taskId, options ?? {}),
  cancel: async () => {
    // LocalRunner 为进程内同步驱动;运行中任务经 Workbench 状态机与 DSH 工具取消
  },
  supports: () => true,
}
