import type { JobState } from './job-model.js'
import { VirtualDevice, type SimEvent, type SimRunResult, type SimScenario } from './virtual-device.js'

/**
 * 虚拟设备服务(内存单例):座舱 /sim/* 路由的支撑层。
 * 同一时刻一个作业;终态保留展示,新作业替换。真机接入后由真实 Provider 替换。
 */

export interface SimJobView {
  jobId: string
  scenario: SimScenario
  state: JobState
  finished: boolean
  pass?: boolean
  message?: string
  events: SimEvent[]
  startedAt: string
}

export interface SimStateView {
  device: { state: JobState; paperCount: number; paperCapacity: number; error?: string }
  job: SimJobView | null
}

const PAPER_CAPACITY = 250

class SimService {
  private current?: {
    device: VirtualDevice
    jobId: string
    scenario: SimScenario
    startedAt: string
    finished: boolean
    result?: SimRunResult
    paperCount: number
  }

  isRunning(): boolean {
    return !!this.current && !this.current.finished
  }

  /** 启动场景;slow=true 使用演示时序(动画可见) */
  async run(scenario: SimScenario, opts: { interactive?: boolean; slow?: boolean } = {}): Promise<{ jobId: string }> {
    if (this.isRunning()) throw new Error('虚拟设备正忙,当前作业未结束')
    const timing = opts.slow ? { scanMs: 1200, processMs: 700, printMs: 1500 } : { scanMs: 60, processMs: 40, printMs: 80 }
    const jobId = `JOB-${Date.now().toString(16).toUpperCase()}`
    const paperStart = scenario.startsWith('paper-empty') ? 0 : Math.max(30, PAPER_CAPACITY - 50)
    const device = new VirtualDevice(jobId, {
      scenario,
      interactive: opts.interactive,
      ...timing,
    })
    this.current = {
      device,
      jobId,
      scenario,
      startedAt: new Date().toISOString(),
      finished: false,
      paperCount: paperStart,
    }
    void device
      .runCopy()
      .then(result => {
        if (this.current && this.current.jobId === jobId) {
          this.current.finished = true
          this.current.result = result
          this.current.paperCount = scenario.startsWith('paper-empty')
            ? result.finalState === 'COMPLETED'
              ? 1
              : 0
            : this.current.paperCount
        }
      })
      .catch(() => {
        if (this.current && this.current.jobId === jobId) this.current.finished = true
      })
    return { jobId }
  }

  /** 外部动作:补纸 / 放弃 / 取消 */
  action(action: 'load-paper' | 'give-up' | 'cancel'): { applied: boolean } {
    if (!this.current) return { applied: false }
    const device = this.current.device
    if (action === 'load-paper') return { applied: device.loadPaper() }
    if (action === 'give-up') return { applied: device.giveUp() }
    return { applied: device.cancel() }
  }

  state(): SimStateView {
    if (!this.current) {
      return {
        device: { state: 'IDLE', paperCount: PAPER_CAPACITY - 50, paperCapacity: PAPER_CAPACITY },
        job: null,
      }
    }
    const { device, jobId, scenario, startedAt, finished, result, paperCount } = this.current
    const state = device.getState()
    return {
      device: {
        state,
        paperCount,
        paperCapacity: PAPER_CAPACITY,
        error: state === 'FAILED' ? 'SEE-JOB' : undefined,
      },
      job: {
        jobId,
        scenario,
        state,
        finished,
        pass: result?.pass,
        message: result?.message,
        events: device.getEvents(),
        startedAt,
      },
    }
  }
}

export const simService = new SimService()
