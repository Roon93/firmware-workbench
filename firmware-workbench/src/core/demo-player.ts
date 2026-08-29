import type { Workbench } from './workbench.js'
import type { EvidenceStore } from './evidence/store.js'
import { seedDemo, resetDemoState, autoAlignRequirement, freezeContractGate, DEMO_REQUIREMENT_ID } from '../demo.js'
import { runTaskLocally, runSimTask } from './runner/local.js'
import { generateAcceptanceBundle } from './acceptance.js'

/**
 * DemoDirector(设计文档 §4):演示剧本由后端编排,前端只是播放器。
 * 阶段动作全部复用真实工程路径(seedDemo / runTaskLocally / runSimTask / generateAcceptanceBundle),
 * 保证"演示的"与"日常用的"是同一条链路,零漂移。
 */

export type DemoStatus = 'idle' | 'running' | 'awaiting_next' | 'done'
export type DemoPhaseStatus = 'pending' | 'active' | 'done'

export interface DemoPhase {
  id: string
  title: string
  narrative: string
  action?: string
  verify?: string
  status: DemoPhaseStatus
  startedAt?: string
  finishedAt?: string
}

export interface DemoLogLine {
  ts: string
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface DemoStateView {
  runId?: string
  mode: 'auto' | 'step'
  status: DemoStatus
  speedMs: number
  phaseIndex: number
  phases: DemoPhase[]
  logCursor: number
  log: DemoLogLine[]
  startedAt?: string
  finishedAt?: string
}

interface ScriptEntry {
  id: string
  title: string
  narrative: string
  action?: string
  verify?: string
}

const SCRIPT: ScriptEntry[] = [
  {
    id: 'P0',
    title: '装载工程种子',
    narrative:
      '一条命令装载完整工程语境:1 条需求、5 份接口契约、19 个任务、7 个用例、12 类资源——这就是开工前的工程骨架。',
    action: 'seedDemo(reset: true)',
  },
  {
    id: 'P1',
    title: '需求 Define',
    narrative: "先把'复印'翻译成工程语言:主流程、异常流、验收标准——评审通过才允许写代码。",
    action: 'TASK-COPY-0001',
    verify: 'Define 基线 approved(G1)',
  },
  {
    id: 'P2',
    title: '契约冻结 + 门禁',
    narrative: '五个模块先签接口契约再并行开发,谁也不等谁、谁也不改谁的接口。',
    action: 'TASK-COPY-0002 + G3-CONTRACT-BASELINE',
    verify: 'IF-JOB-MANAGER 等 5 契约 v1 冻结',
  },
  {
    id: 'P3',
    title: '五路并行开发',
    narrative:
      '面板、作业、扫描、图像、引擎五个工作包同时开工,共享构建资源 build/rk3588——资源租约保证不打架。',
    action: 'TASK-COPY-0010..0014',
  },
  {
    id: 'P4',
    title: '组件自测',
    narrative: '交付即自测:每个包在 L1 层验证契约不变式,问题不上溯到集成。',
    action: 'TASK-COPY-0010-T..0014-T',
  },
  {
    id: 'P5',
    title: '模拟集成:虚拟复印',
    narrative: "五件套合体:虚拟设备完整跑一遍'扫描 → 图像处理 → 出纸'——这就是没有真机时的整机。",
    action: 'TASK-COPY-0030(success,慢速)',
    verify: '终态 COMPLETED,出纸 1 页',
  },
  {
    id: 'P6',
    title: '异常恢复套件',
    narrative:
      "必选异常一个不落:取消、扫描超时、缺纸恢复、缺纸终止、引擎错误——失败场景也要'正确地失败',这才是固件质量。",
    action: 'TASK-COPY-0031(copy-recovery,6 场景)',
  },
  {
    id: 'P7',
    title: '验收评估 + 证据包',
    narrative: '独立验收:必选用例全部执行且通过才给 PASS,全过程证据打包留痕、可审计。',
    action: 'TASK-COPY-0040 + Evidence Bundle(L1)',
  },
  {
    id: 'P8',
    title: '真机队列(预期停顿)',
    narrative:
      '真机任务诚实排队:整机资源已隔离,等待 Phase 0 事实冻结——系统不会假装验证过它没验证的东西。',
    action: '展示 TASK-COPY-0050/0051/0052 排队',
  },
  {
    id: 'P9',
    title: '演示完成',
    narrative: '从一句话需求到 PASS L1 验收报告,全程有证据,每一步可审计。',
  },
]

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface DemoContext {
  workbench: Workbench
  evidence: EvidenceStore
}

class DemoDirector {
  private runId?: string
  private mode: 'auto' | 'step' = 'auto'
  private status: DemoStatus = 'idle'
  private speedMs = 1500
  private phaseIndex = 0
  private phases: DemoPhase[] = []
  private logLines: DemoLogLine[] = []
  private startedAt?: string
  private finishedAt?: string
  private timer?: NodeJS.Timeout
  private seq = 0

  private resetInternal(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.seq += 1
    this.runId = `DEMO-${new Date().toISOString().slice(11, 19).replaceAll(':', '')}-${this.seq}`
    this.mode = this.mode
    this.status = 'running'
    this.speedMs = this.speedMs
    this.phaseIndex = 0
    this.phases = SCRIPT.map(entry => ({
      id: entry.id,
      title: entry.title,
      narrative: entry.narrative,
      action: entry.action,
      verify: entry.verify,
      status: 'pending',
    }))
    this.logLines = []
    this.startedAt = new Date().toISOString()
    this.finishedAt = undefined
  }

  /** 启动/热更演示。运行中调用仅热更 mode/speedMs(幂等) */
  play(ctx: DemoContext, input: { mode?: 'auto' | 'step'; reset?: boolean; speedMs?: number }): DemoStateView {
    if (input.speedMs && input.speedMs > 0) this.speedMs = input.speedMs
    if (input.mode) this.mode = input.mode

    if (this.status === 'running') {
      return this.getState() // 已在运行:参数已热更
    }
    if (this.status === 'awaiting_next' && input.mode) {
      // 从暂停恢复
      this.resume(ctx)
      return this.getState()
    }
    this.resetInternal()
    void this.advance(ctx)
    return this.getState()
  }

  /** 单步推进(awaiting_next -> 下一阶段) */
  step(ctx: DemoContext): DemoStateView {
    if (this.status !== 'awaiting_next') return this.getState()
    this.resume(ctx)
    return this.getState()
  }

  /** 暂停(auto -> awaiting_next) */
  pause(): DemoStateView {
    if (this.status !== 'running') return this.getState()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.status = 'awaiting_next'
    this.log('warn', '⏸ 演示已暂停:点击"下一步"继续')
    return this.getState()
  }

  /** 复位(idle)并清空任务状态(DAG 复灰) */
  reset(ctx: DemoContext): DemoStateView {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.status = 'idle'
    this.phases = []
    this.logLines = []
    this.runId = undefined
    this.phaseIndex = 0
    this.startedAt = undefined
    this.finishedAt = undefined
    try {
      resetDemoState(ctx.workbench.store)
      ctx.workbench.refreshStates('demo')
    } catch {
      // 库未种子化时忽略
    }
    return this.getState()
  }

  private resume(ctx: DemoContext): void {
    this.status = 'running'
    this.phaseIndex += 1
    void this.advance(ctx)
  }

  getState(logCursor = 0): DemoStateView {
    return {
      runId: this.runId,
      mode: this.mode,
      status: this.status,
      speedMs: this.speedMs,
      phaseIndex: this.phaseIndex,
      phases: this.phases,
      logCursor: this.logLines.length,
      log: this.logLines.slice(logCursor),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    }
  }

  private log(level: DemoLogLine['level'], text: string): void {
    this.logLines.push({ ts: new Date().toISOString(), level, text })
    if (this.logLines.length > 600) this.logLines = this.logLines.slice(-400)
  }

  private async advance(ctx: DemoContext): Promise<void> {
    if (this.status !== 'running') return
    const index = this.phaseIndex
    if (index >= this.phases.length) {
      this.status = 'done'
      this.finishedAt = new Date().toISOString()
      return
    }
    const phase = this.phases[index]!
    phase.status = 'active'
    phase.startedAt = new Date().toISOString()
    this.log('info', `▶ 阶段 ${index + 1}/${this.phases.length}:${phase.title}`)

    try {
      await this.executePhase(ctx, index)
      phase.status = 'done'
      phase.finishedAt = new Date().toISOString()
      this.log('info', `✓ ${phase.title}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log('error', `✗ ${phase.title} 执行失败: ${message}`)
      phase.status = 'pending'
      this.status = 'awaiting_next'
      return
    }

    if (index === this.phases.length - 1) {
      this.status = 'done'
      this.finishedAt = new Date().toISOString()
      this.log('info', `■ 演示完成(${this.runId})`)
      return
    }
    if (this.mode === 'auto') {
      const gap = index === 7 ? 3000 : this.speedMs // P8 真机队列预期停顿
      this.timer = setTimeout(() => {
        if (this.status !== 'running') return
        this.phaseIndex = index + 1
        void this.advance(ctx)
      }, gap)
    } else {
      this.status = 'awaiting_next'
      this.log('warn', '⏸ 单步模式:点击"下一步"继续')
    }
  }

  private async executePhase(ctx: DemoContext, index: number): Promise<void> {
    const { workbench } = ctx
    const run = async (taskId: string): Promise<void> => {
      const result = await runTaskLocally(workbench, taskId, { actor: 'demo', humanAutoAccept: true })
      if (!result.ok) throw new Error(`${taskId}: ${result.message}`)
      for (const line of result.log.slice(-2)) this.log('info', line)
      workbench.refreshStates('demo')
    }
    const interlude = async (ms: number): Promise<void> => {
      if (this.mode === 'auto') await sleep(Math.min(ms, this.speedMs))
    }

    switch (index) {
      case 0: {
        seedDemo(workbench.store, 'demo', { reset: true, autoGate: false })
        workbench.refreshStates('demo')
        this.log('info', '种子完成:19 任务 / 7 用例 / 5 契约 / 12 类资源')
        return
      }
      case 1: {
        const aligned = autoAlignRequirement(workbench.store, DEMO_REQUIREMENT_ID, 'demo')
        this.log('info', `澄清 ${aligned.questionsAnswered} 题 · 条目 ${aligned.items.length} 条 · Define ${aligned.defineId} ${aligned.decision}`)
        this.log('info', 'G1 定义完成门禁:需求评审批准')
        return run('TASK-COPY-0001')
      }
      case 2: {
        const gate = freezeContractGate(workbench.store, 'demo')
        this.log('info', `G3 契约基线:${gate.contracts.length} 份契约冻结 + 门禁批准`)
        return run('TASK-COPY-0002')
      }
      case 3:
        for (const id of ['TASK-COPY-0010', 'TASK-COPY-0011', 'TASK-COPY-0012', 'TASK-COPY-0013', 'TASK-COPY-0014']) {
          await run(id)
          await interlude(600)
        }
        return
      case 4:
        for (const id of ['TASK-COPY-0010-T', 'TASK-COPY-0011-T', 'TASK-COPY-0012-T', 'TASK-COPY-0013-T', 'TASK-COPY-0014-T']) {
          await run(id)
          await interlude(500)
        }
        return
      case 5: {
        const result = await runSimTask(workbench, 'TASK-COPY-0030', { type: 'scenario', scenario: 'success' }, {
          slow: true,
          actor: 'demo',
        })
        if (!result.ok) throw new Error(result.message)
        for (const line of result.log) this.log('info', line)
        workbench.refreshStates('demo')
        return
      }
      case 6: {
        const result = await runSimTask(workbench, 'TASK-COPY-0031', { type: 'suite', suite: 'copy-recovery' }, {
          actor: 'demo',
        })
        if (!result.ok) throw new Error(result.message)
        for (const line of result.log) this.log('info', line)
        workbench.refreshStates('demo')
        return
      }
      case 7: {
        await run('TASK-COPY-0040')
        const generated = generateAcceptanceBundle({
          store: workbench.store,
          evidence: ctx.evidence,
          requirementId: DEMO_REQUIREMENT_ID,
          baselines: {
            product: 'PRD-A4-MONO-MFP-v0.1',
            platform: 'PLAT-RK3588-BSP-unfrozen(Phase 0 待冻结)',
            firmwareSha256: 'sim-loop-no-real-firmware',
            sourceCommit: 'simulator-loop',
            hardwareRevision: 'virtual-device',
          },
          maxLevel: 'L1',
          actor: 'demo',
        })
        this.log('info', `验收决定:${generated.decision.decision} · 证据包 ${generated.bundleId}`)
        return
      }
      case 8: {
        const queued = ['TASK-COPY-0050', 'TASK-COPY-0051', 'TASK-COPY-0052'].map(id => {
          const task = workbench.getTask(id)
          return `${id} ${task?.status ?? '?'}`
        })
        this.log('warn', `真机任务排队:${queued.join(' · ')}`)
        await sleep(2500)
        return
      }
      default:
        return
    }
  }
}

export const demoDirector = new DemoDirector()
