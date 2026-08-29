import { spawn } from 'node:child_process'
import type { Task } from '../../types.js'
import { VirtualDevice, SCENARIO_EXPECTATIONS, type SimScenario } from '../../sim/virtual-device.js'
import { recordTestRun } from '../testing.js'
import type { Workbench } from '../workbench.js'

/**
 * 本地 Runner(方案 5.2 DAG Runner Adapter 的保底实现):
 * 用 SQLite 状态机直接驱动任务动作。Dagu Spike 通过后可替换为 DaguAdapter,
 * 领域模型只依赖 RunnerAdapter 语义,不依赖具体执行内核。
 */

export interface RunTaskOptions {
  actor?: string
  /** 单条 shell 动作超时(分钟),缺省取任务 policy.timeoutMinutes */
  timeoutMinutes?: number
  /** 人工任务自动签收者(MVP 无人工通道,由操作者在 CLI/工具侧签收) */
  humanAutoAccept?: boolean
}

export interface RunTaskResult {
  taskId: string
  ok: boolean
  failureClass?: 'product' | 'test' | 'infra'
  message: string
  /** 执行事件(动作输出),供证据包采集 */
  log: string[]
}

async function runShell(command: string, timeoutMinutes: number): Promise<{ code: number; log: string }> {
  return new Promise(resolve => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      env: process.env,
    })
    let log = ''
    const timer = setTimeout(
      () => {
        child.kill()
        log += `\n[fwctl-runner] 动作超时(${timeoutMinutes}m),已终止\n`
      },
      Math.max(1, timeoutMinutes) * 60_000,
    )
    child.stdout?.on('data', data => {
      log += String(data)
    })
    child.stderr?.on('data', data => {
      log += String(data)
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: -1, log: `${log}\n[fwctl-runner] 启动失败: ${error.message}\n` })
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, log })
    })
  })
}

/** 场景 -> 测试用例:任务执行成功即产生测试证据(方案 4.5/8.8) */
const SCENARIO_TO_CASE: Partial<Record<SimScenario, string>> = {
  success: 'TC-COPY-FUNC-0001',
  'cancel-before-scan': 'TC-COPY-REC-0002',
  'scan-timeout': 'TC-COPY-REC-0003',
  'paper-empty-then-recover': 'TC-COPY-REC-0004',
  'paper-empty-no-recovery': 'TC-COPY-REC-0005',
}

export interface SimExecOptions {
  /** 慢速演示时序(scan 1200/process 700/print 1500 ms),让面板动画可见 */
  slow?: boolean
  /** 交互模式:缺纸场景停在 WAITING_FOR_PAPER 等待外部补纸/放弃 */
  interactive?: boolean
}

async function runSimScenario(
  workbench: Workbench,
  task: Task,
  scenario: string,
  log: string[],
  opts: SimExecOptions = {},
): Promise<{ ok: boolean; failureClass?: 'product' | 'infra'; message: string }> {
  const known = SCENARIO_EXPECTATIONS[scenario as SimScenario]
  if (!known) {
    return { ok: false, failureClass: 'infra', message: `未知模拟场景: ${scenario}` }
  }
  const timing = opts.slow ? { scanMs: 1200, processMs: 700, printMs: 1500 } : { scanMs: 5, processMs: 5, printMs: 5 }
  const jobId = `JOB-${task.id}-${Date.now()}`
  const device = new VirtualDevice(jobId, {
    scenario: scenario as SimScenario,
    interactive: opts.interactive,
    ...timing,
  })
  const result = await device.runCopy()

  for (const event of result.events) {
    workbench.store.appendEvent('virtual-device', 'sim.event', { task: task.id, ...event })
  }
  log.push(`[sim] 场景=${scenario} 终态=${result.finalState} 出纸=${result.pagesOut} ${result.message}`)

  const expectation = SCENARIO_EXPECTATIONS[scenario as SimScenario]
  if (result.finalState !== expectation.finalState || result.pagesOut !== expectation.pagesOut) {
    return {
      ok: false,
      failureClass: 'product',
      message: `模拟场景 ${scenario} 结果偏离状态机预期: 终态 ${result.finalState}/出纸 ${result.pagesOut},预期 ${expectation.finalState}/${expectation.pagesOut}`,
    }
  }
  const caseId = SCENARIO_TO_CASE[scenario as SimScenario]
  if (caseId) {
    try {
      const run = recordTestRun(workbench.store, {
        caseId,
        result: 'PASS',
        message: `${result.message}(终态 ${result.finalState},出纸 ${result.pagesOut})`,
        taskId: task.id,
        actor: 'virtual-device',
      })
      log.push(`[evidence] 用例 ${caseId} 记录 PASS(运行 ${run.id})`)
    } catch {
      // 用例未种子化时跳过证据记录,不影响任务判定
    }
  }
  void known
  return { ok: true, message: result.message }
}

/** 异常恢复套件(方案 19.3 必选异常):全部场景按状态机预期执行 */
export const SIM_SUITE_SCENARIOS: Record<string, SimScenario[]> = {
  'copy-recovery': [
    'cancel-before-scan',
    'scan-timeout',
    'paper-empty-then-recover',
    'paper-empty-no-recovery',
    'engine-recoverable-error',
  ],
}

async function runSimSuite(
  workbench: Workbench,
  task: Task,
  suite: string,
  log: string[],
  opts: SimExecOptions = {},
): Promise<{ ok: boolean; failureClass?: 'product' | 'infra'; message: string }> {
  const scenarios = SIM_SUITE_SCENARIOS[suite]
  if (!scenarios) {
    return { ok: false, failureClass: 'infra', message: `未知模拟套件: ${suite}` }
  }
  for (const scenario of scenarios) {
    const result = await runSimScenario(workbench, task, scenario, log, opts)
    if (!result.ok) return result
  }
  return { ok: true, message: `套件 ${suite} 全部 ${scenarios.length} 个场景通过` }
}

/**
 * 以真实任务路径运行一个 sim 集成任务(演示 P5/P6 用,设计文档 §4.2):
 * acquire -> start -> 慢速场景/套件 -> verify -> complete;失败按产品语义落状态。
 */
export async function runSimTask(
  workbench: Workbench,
  taskId: string,
  kind: { type: 'scenario'; scenario: string } | { type: 'suite'; suite: string },
  opts: SimExecOptions & { actor?: string } = {},
): Promise<RunTaskResult> {
  const actor = opts.actor ?? 'demo'
  const log: string[] = []
  const task = workbench.getTask(taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)

  const acquired = workbench.acquireTask(taskId, actor)
  if (!acquired.ok) {
    return { taskId, ok: false, message: `资源不可得: ${acquired.blockers.join('; ')}`, log }
  }
  workbench.startTask(taskId, actor)

  const execOpts: SimExecOptions = { slow: opts.slow, interactive: opts.interactive }
  const result =
    kind.type === 'scenario'
      ? await runSimScenario(workbench, task, kind.scenario, log, execOpts)
      : await runSimSuite(workbench, task, kind.suite, log, execOpts)

  workbench.beginVerify(taskId, actor)
  if (!result.ok) {
    workbench.failTask(taskId, result.failureClass ?? 'product', result.message, actor)
    return { taskId, ok: false, failureClass: result.failureClass, message: result.message, log }
  }
  workbench.completeTask(taskId, actor)
  log.push(`[runner] 任务完成: ${taskId}`)
  return { taskId, ok: true, message: result.message, log }
}

/**
 * 运行单个任务:acquire -> start -> setup/execute -> verify -> succeeded -> cleanup。
 * 失败按三分类落状态;资源在完成/失败时统一释放。
 */
export async function runTaskLocally(
  workbench: Workbench,
  taskId: string,
  options: RunTaskOptions = {},
): Promise<RunTaskResult> {
  const actor = options.actor ?? 'fwctl-runner'
  const log: string[] = []
  const task = workbench.getTask(taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)

  // 1. 资源
  const acquired = workbench.acquireTask(taskId, actor)
  if (!acquired.ok) {
    return { taskId, ok: false, message: `资源不可得: ${acquired.blockers.join('; ')}`, log }
  }
  log.push(`[runner] 资源租约已建立: ${taskId}`)

  // 2. 启动
  workbench.startTask(taskId, actor)

  const actions = task.actions ?? {}
  const timeoutMinutes = options.timeoutMinutes ?? task.policy?.timeoutMinutes ?? 10

  // 3. setup
  if (actions.setup) {
    const spec = actions.setup
    if (typeof spec === 'string') {
      const result = await runShell(spec, timeoutMinutes)
      log.push(result.log)
      if (result.code !== 0) {
        workbench.failTask(taskId, 'infra', `setup 失败(exit ${result.code})`, actor)
        return { taskId, ok: false, failureClass: 'infra', message: 'setup 失败', log }
      }
    }
  }

  // 4. execute
  const execute = actions.execute
  if (execute) {
    if (typeof execute === 'string') {
      const result = await runShell(execute, timeoutMinutes)
      log.push(result.log)
      if (result.code !== 0) {
        workbench.failTask(taskId, 'product', `execute 失败(exit ${result.code})`, actor)
        return { taskId, ok: false, failureClass: 'product', message: 'execute 失败', log }
      }
    } else if (execute.simScenario) {
      const simResult = await runSimScenario(workbench, task, execute.simScenario, log)
      if (!simResult.ok) {
        workbench.failTask(taskId, simResult.failureClass ?? 'product', simResult.message, actor)
        return { taskId, ok: false, failureClass: simResult.failureClass, message: simResult.message, log }
      }
    } else if (execute.simSuite) {
      const suiteResult = await runSimSuite(workbench, task, execute.simSuite, log)
      if (!suiteResult.ok) {
        workbench.failTask(taskId, suiteResult.failureClass ?? 'product', suiteResult.message, actor)
        return { taskId, ok: false, failureClass: suiteResult.failureClass, message: suiteResult.message, log }
      }
    } else if (execute.humanAction) {
      if (!options.humanAutoAccept) {
        // MVP:人工任务在此暂停等待签收——由 CLI --human-auto-accept 或 DSH 审批代签
        workbench.failTask(taskId, 'infra', `等待人工动作 ${execute.humanAction} 签收`, actor)
        return { taskId, ok: false, failureClass: 'infra', message: `等待人工动作: ${execute.humanAction}`, log }
      }
      workbench.store.appendEvent(actor, 'task.human_action', {
        taskId,
        action: execute.humanAction,
        acceptedBy: 'auto-accept',
      })
      log.push(`[runner] 人工动作已签收: ${execute.humanAction}`)
    }
  }

  // 5. verify(方案 4.5:每项完成都有独立验证)
  workbench.beginVerify(taskId, actor)
  const verify = actions.verify
  if (verify) {
    if (typeof verify === 'string') {
      const result = await runShell(verify, timeoutMinutes)
      log.push(result.log)
      if (result.code !== 0) {
        workbench.failTask(taskId, 'test', `verify 失败(exit ${result.code})`, actor)
        return { taskId, ok: false, failureClass: 'test', message: 'verify 失败', log }
      }
    } else if (verify.evaluateAcceptance) {
      // 验收型任务的验证 = 重新评估决定;由 acceptance 模块生成报告
      log.push('[runner] 验收评估由 fwctl accept evaluate 执行')
    }
  }

  // 6. 完成 + 清理
  workbench.completeTask(taskId, actor)
  if (actions.cleanup && typeof actions.cleanup === 'string') {
    const result = await runShell(actions.cleanup, timeoutMinutes)
    log.push(result.log)
  }
  log.push(`[runner] 任务完成: ${taskId}`)
  return { taskId, ok: true, message: '任务完成', log }
}
