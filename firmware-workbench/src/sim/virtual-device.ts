import { nextJobState, isJobTerminal, type JobEvent, type JobState } from './job-model.js'

/**
 * 虚拟设备(方案 10.6 接口级模拟器):
 * 虚拟扫描器 + 图像流水线 + 虚拟打印引擎按复印作业编排,
 * 与真实适配器共享同一作业状态机与事件语义,避免模拟器与真实设备行为漂移。
 */

export interface SimEvent {
  ts: string
  jobId: string
  kind: string
  detail?: string
}

export interface SimDeviceConfig {
  /** 各阶段模拟时延(毫秒),测试可置 0 */
  scanMs?: number
  processMs?: number
  printMs?: number
  /** 注入的故障场景(方案 19.3 必选异常) */
  scenario?: SimScenario
  /** 交互模式:paper-empty-then-recover 停在 WAITING_FOR_PAPER,等待 loadPaper()/giveUp() 外部驱动 */
  interactive?: boolean
}

export type SimScenario =
  | 'success'
  | 'cancel-before-scan'
  | 'scan-timeout'
  | 'paper-empty-then-recover'
  | 'paper-empty-no-recovery'
  | 'engine-recoverable-error'

export interface SimRunResult {
  jobId: string
  scenario: SimScenario
  finalState: JobState
  pagesOut: number
  events: SimEvent[]
  /** true = 执行结果符合该场景的产品语义预期(失败型场景正确失败也算 pass) */
  pass: boolean
  message: string
}

export class VirtualDevice {
  private state: JobState = 'IDLE'
  private pagesOut = 0
  private readonly events: SimEvent[] = []
  private readonly timers: NodeJS.Timeout[] = []
  private resumeResolver?: () => void

  constructor(
    readonly jobId: string,
    private readonly config: SimDeviceConfig = {},
  ) {}

  getState(): JobState {
    return this.state
  }

  getEvents(): SimEvent[] {
    return [...this.events]
  }

  private now(): string {
    return new Date().toISOString()
  }

  private log(kind: string, detail?: string): void {
    this.events.push({ ts: this.now(), jobId: this.jobId, kind, detail })
  }

  private fire(event: JobEvent): void {
    this.state = nextJobState(this.state, event)
    this.log('job.state', `${event} -> ${this.state}`)
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      this.timers.push(timer)
    })
  }

  /** 交互模式挂起:等待外部 loadPaper()/giveUp() 驱动(设计文档 §6.2 手动交互模式) */
  private async waitForExternal(): Promise<void> {
    await new Promise<void>(resolve => {
      this.resumeResolver = resolve
    })
    this.resumeResolver = undefined
    await this.sleep(400)
  }

  private resolveExternal(): void {
    this.resumeResolver?.()
  }

  /** 取消(方案 19.3:扫描前取消)。仅当状态机允许时生效 */
  cancel(): boolean {
    if (isJobTerminal(this.state)) return false
    try {
      this.fire('CANCEL')
      this.log('panel.input', '用户取消作业')
      if (this.state === 'CANCELLED') this.resolveExternal()
      return true
    } catch {
      return false
    }
  }

  /** 补纸后继续(方案 19.3:缺纸恢复) */
  loadPaper(): boolean {
    if (this.state !== 'WAITING_FOR_PAPER') return false
    this.fire('PAPER_LOADED')
    this.log('panel.input', '人工装纸')
    this.resolveExternal()
    return true
  }

  /** 放弃等待(缺纸且不恢复 -> 作业失败) */
  giveUp(): boolean {
    if (this.state !== 'WAITING_FOR_PAPER') return false
    this.fire('GIVE_UP')
    this.log('device', '等待补纸超时,作业终止')
    this.resolveExternal()
    return true
  }

  /** 完整跑一遍单页黑白复印(方案 19.1:A4 平板、300dpi、单份) */
  async runCopy(): Promise<SimRunResult> {
    const scenario = this.config.scenario ?? 'success'
    const scanMs = this.config.scanMs ?? 30
    const processMs = this.config.processMs ?? 20
    const printMs = this.config.printMs ?? 40

    try {
      this.log('device', `虚拟设备就绪,场景=${scenario}`)
      this.fire('COPY_START')
      this.log('panel.input', '面板发起单页黑白复印(A4 平板 300dpi 单份)')

      if (scenario === 'cancel-before-scan') {
        this.cancel()
        return this.finish(true, '扫描前取消,作业回到 CANCELLED,设备就绪')
      }

      // ---- 扫描 ----
      this.log('scanner', '平板扫描开始')
      await this.sleep(scanMs)
      if (scenario === 'scan-timeout') {
        this.fire('SCAN_TIMEOUT')
        this.log('scanner.error', '扫描超时(模拟),作业进入 FAILED,错误码 SCAN-TIMEOUT')
        return this.finish(true, '扫描超时场景:作业按产品语义正确进入 FAILED')
      }
      this.fire('SCAN_DONE')
      this.log('scanner', '扫描完成:2480x3508 8bit 灰度')

      // ---- 图像 ----
      this.log('image', '图像处理:校正/半色调/压缩')
      await this.sleep(processMs)
      this.fire('IMAGE_DONE')

      // ---- 打印 ----
      // IMAGE_DONE 已使作业进入 PRINTING(方案 6.3:引擎输出阶段)
      this.log('engine', '引擎预热并开始输出')
      await this.sleep(printMs)

      if (scenario === 'paper-empty-then-recover' || scenario === 'paper-empty-no-recovery') {
        this.fire('PAPER_EMPTY')
        this.log('engine.error', '缺纸:面板提示 PAPER_EMPTY,作业 WAITING_FOR_PAPER')
        if (scenario === 'paper-empty-then-recover' && this.config.interactive) {
          this.log('panel.input', '等待人工补纸(交互模式)')
          await this.waitForExternal()
          if (this.state === 'WAITING_FOR_PAPER') {
            // 外部未成功驱动(如取消场景外保留),按放弃处理
            this.giveUp()
            return this.finish(true, '缺纸未恢复:作业按产品语义正确进入 FAILED,需人工清理')
          }
          this.log('engine', '补纸完成,继续输出')
          await this.sleep(printMs)
        } else if (scenario === 'paper-empty-then-recover') {
          this.loadPaper()
          this.log('engine', '补纸完成,继续输出')
          await this.sleep(printMs)
        } else {
          this.giveUp()
          return this.finish(true, '缺纸未恢复:作业按产品语义正确进入 FAILED,需人工清理')
        }
      }

      if (scenario === 'engine-recoverable-error') {
        this.log('engine.error', '引擎可恢复错误:自动重试一次')
        await this.sleep(printMs)
      }

      this.fire('PRINT_DONE')
      this.pagesOut += 1
      this.log('engine', '出纸完成:1 页黑白 A4')
      return this.finish(true, '单页黑白复印完成')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log('device.error', message)
      return {
        jobId: this.jobId,
        scenario,
        finalState: this.state,
        pagesOut: this.pagesOut,
        events: this.getEvents(),
        pass: false,
        message: `虚拟设备异常: ${message}`,
      }
    } finally {
      for (const timer of this.timers) clearTimeout(timer)
      this.resumeResolver = undefined
    }
  }

  private finish(pass: boolean, message: string): SimRunResult {
    this.log('device', message)
    return {
      jobId: this.jobId,
      scenario: this.config.scenario ?? 'success',
      finalState: this.state,
      pagesOut: this.pagesOut,
      events: this.getEvents(),
      pass,
      message,
    }
  }
}

/** 场景 -> 预期终态(验收 Oracle,方案 11.6) */
export const SCENARIO_EXPECTATIONS: Record<SimScenario, { finalState: JobState; pass: boolean; pagesOut: number }> = {
  success: { finalState: 'COMPLETED', pass: true, pagesOut: 1 },
  'cancel-before-scan': { finalState: 'CANCELLED', pass: true, pagesOut: 0 },
  'scan-timeout': { finalState: 'FAILED', pass: true, pagesOut: 0 },
  'paper-empty-then-recover': { finalState: 'COMPLETED', pass: true, pagesOut: 1 },
  'paper-empty-no-recovery': { finalState: 'FAILED', pass: true, pagesOut: 0 },
  'engine-recoverable-error': { finalState: 'COMPLETED', pass: true, pagesOut: 1 },
}

/** 慢速演示时序(设计文档 §6.3:动画可见;测试路径不受影响) */
export const DEMO_TIMING = { scanMs: 1200, processMs: 700, printMs: 1500 }
