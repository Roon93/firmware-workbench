/**
 * 复印作业状态模型(方案 6.3 Job Manager / 10.6 作业状态模拟 / 11.6 显式转移表 Oracle)。
 * 转移表同时服务三处:虚拟设备编排、模型测试、验收断言。
 */

export type JobState =
  | 'IDLE'
  | 'SCANNING'
  | 'PROCESSING'
  | 'PRINTING'
  | 'WAITING_FOR_PAPER'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'

export type JobEvent =
  | 'COPY_START'
  | 'SCAN_DONE'
  | 'IMAGE_DONE'
  | 'PRINT_START'
  | 'PAPER_EMPTY'
  | 'PAPER_LOADED'
  | 'PRINT_DONE'
  | 'SCAN_TIMEOUT'
  | 'ENGINE_FATAL'
  | 'CANCEL'
  | 'GIVE_UP'
  | 'RETRY'

/** 显式转移表:任何未列出的 (state, event) 组合都是非法迁移 */
export const JOB_TRANSITIONS: Record<JobState, Partial<Record<JobEvent, JobState>>> = {
  IDLE: {
    COPY_START: 'SCANNING',
  },
  SCANNING: {
    SCAN_DONE: 'PROCESSING',
    SCAN_TIMEOUT: 'FAILED',
    CANCEL: 'CANCELLED',
  },
  PROCESSING: {
    IMAGE_DONE: 'PRINTING',
    CANCEL: 'CANCELLED',
  },
  PRINTING: {
    PAPER_EMPTY: 'WAITING_FOR_PAPER',
    PRINT_DONE: 'COMPLETED',
    CANCEL: 'CANCELLED',
    ENGINE_FATAL: 'FAILED',
  },
  WAITING_FOR_PAPER: {
    PAPER_LOADED: 'PRINTING',
    CANCEL: 'CANCELLED',
    GIVE_UP: 'FAILED',
  },
  COMPLETED: {},
  CANCELLED: {},
  FAILED: {},
}

export function nextJobState(state: JobState, event: JobEvent): JobState {
  const target = JOB_TRANSITIONS[state]?.[event]
  if (!target) {
    throw new Error(`非法作业迁移: ${state} + ${event}(作业状态机无此路径)`)
  }
  return target
}

export function isJobTerminal(state: JobState): boolean {
  return state === 'COMPLETED' || state === 'CANCELLED' || state === 'FAILED'
}

/** 用户可发起取消的状态(方案 19.3:扫描前取消是必选异常) */
export function canCancel(state: JobState): boolean {
  return state === 'SCANNING' || state === 'PROCESSING' || state === 'PRINTING' || state === 'WAITING_FOR_PAPER'
}
