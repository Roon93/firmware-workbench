#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WorkbenchStore } from './core/store.js'
import { Workbench } from './core/workbench.js'
import { seedResources, listResources, listLeases, releaseTaskLeases, quarantineResource, completeMaintenance } from './core/resources.js'
import { importRequirement } from './core/requirement.js'
import { createContract, freezeContract } from './core/contract.js'
import { validateDag } from './core/dag.js'
import { EvidenceStore } from './core/evidence/store.js'
import { evaluateRequirement, generateAcceptanceBundle } from './core/acceptance.js'
import { getTestCase, recordTestRun, buildJunitXml, listTestCases, type TestCaseRow } from './core/testing.js'
import { seedDemo, DEMO_REQUIREMENT_ID } from './demo.js'
import { runTaskLocally } from './core/runner/local.js'
import { VirtualDevice, SCENARIO_EXPECTATIONS, type SimScenario } from './sim/virtual-device.js'
import { JOB_TRANSITIONS } from './sim/job-model.js'
import type { TestLevel, TestResult } from './types.js'

/**
 * fwctl —— 工作台确定性命令面(方案 4.2/5.4):
 * 构建、部署、资源、测试、验收和证据由工具执行;AI 通过 DSH 工具调用同一实现。
 */

interface CliContext {
  store: WorkbenchStore
  workbench: Workbench
  evidence: EvidenceStore
}

function openContext(dbPath?: string): CliContext {
  const path = resolve(dbPath ?? WorkbenchStore.defaultPath())
  const store = new WorkbenchStore(path)
  seedResources(store)
  return {
    store,
    workbench: new Workbench(store),
    evidence: new EvidenceStore(store, EvidenceStore.defaultRoot(path)),
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function fail(message: string): never {
  console.error(`fwctl: ${message}`)
  process.exit(1)
}

// ---------- 模拟层用例 -> 场景映射(方案 19.3) ----------

const CASE_SCENARIOS: Record<string, SimScenario> = {
  'TC-COPY-FUNC-0001': 'success',
  'TC-COPY-REC-0002': 'cancel-before-scan',
  'TC-COPY-REC-0003': 'scan-timeout',
  'TC-COPY-REC-0004': 'paper-empty-then-recover',
  'TC-COPY-REC-0005': 'paper-empty-no-recovery',
}

const L4_CASES = new Set(['TC-COPY-REC-0006', 'TC-COPY-REC-0007'])

function deviceAvailable(ctx: CliContext): boolean {
  const res = listResources(ctx.store).find(item => item.id === 'device/printer-01')
  return !!res && res.state === 'available' && res.busyUnits === 0
}

async function executeSimCase(ctx: CliContext, testCase: TestCaseRow): Promise<{ result: TestResult; message: string }> {
  if (L4_CASES.has(testCase.id)) {
    return deviceAvailable(ctx)
      ? { result: 'PRODUCT_FAIL', message: '真机 Provider 未接入(Phase 0 事实待冻结),不能模拟 L4 结论' }
      : { result: 'BLOCKED_RESOURCE', message: '真机用例:Printer-01 不可用,保持排队(方案 11.4)' }
  }
  const scenario = CASE_SCENARIOS[testCase.id]
  if (!scenario) {
    return { result: 'INVALID', message: '用例未绑定模拟场景' }
  }
  const device = new VirtualDevice(`JOB-${testCase.id}-${Date.now()}`, {
    scenario,
    scanMs: 5,
    processMs: 5,
    printMs: 5,
  })
  const summary = await device.runCopy()
  ctx.store.appendEvent('fwctl', 'test.sim_event', {
    caseId: testCase.id,
    events: summary.events.map(event => `${event.kind}: ${event.detail ?? ''}`),
  })
  const expectation = SCENARIO_EXPECTATIONS[scenario]
  const ok = summary.finalState === expectation.finalState && summary.pagesOut === expectation.pagesOut
  return ok
    ? { result: 'PASS', message: `${summary.message}(终态 ${summary.finalState},出纸 ${summary.pagesOut})` }
    : { result: 'PRODUCT_FAIL', message: `偏离状态机预期: ${summary.finalState}/${summary.pagesOut}` }
}

// ---------- 命令实现 ----------

function cmdDemoSeed(ctx: CliContext): void {
  const seeded = seedDemo(ctx.store, 'fwctl')
  ctx.workbench.refreshStates('fwctl')
  printJson({
    ok: true,
    requirement: seeded.requirementId,
    tasks: seeded.taskIds.length,
    db: ctx.store.path,
    hint: 'fwctl ready 查看可运行队列;fwctl demo-verify 跑模拟闭环',
  })
}

function cmdReady(ctx: CliContext): void {
  ctx.workbench.refreshStates('fwctl')
  const ready = ctx.workbench.readyQueue()
  const path = ctx.workbench.criticalPath()
  printJson({
    readyQueue: ready,
    criticalPath: path,
    blocked: ctx.workbench
      .listTasks()
      .filter(task => task.status.startsWith('blocked_'))
      .map(task => ({ id: task.id, status: task.status, reason: task.blockedReason })),
  })
}

function cmdStatus(ctx: CliContext): void {
  printJson(ctx.workbench.statusSnapshot())
}

function cmdRequirementImport(ctx: CliContext, args: { title?: string; text?: string }): void {
  const title = args.title
  const text = args.text
  if (!title || !text) fail('requirement import 需要 --title 与 --text')
  const requirement = importRequirement(ctx.store, { title, originalText: text, actor: 'fwctl' })
  printJson({ ok: true, id: requirement.id, status: requirement.status })
}

function cmdContractFreeze(ctx: CliContext, args: { name?: string; version?: string }): void {
  const name = args.name
  const version = args.version ?? 'v1'
  if (!name) fail('contract freeze 需要 --name')
  const existing = ctx.store.db.prepare('SELECT id FROM contracts WHERE name = ? AND version = ?').get(name, version) as
    | { id: string }
    | undefined
  const contract = existing ?? createContract(ctx.store, { name, version, body: { source: 'fwctl' }, actor: 'fwctl' })
  const frozen = freezeContract(ctx.store, contract.id, 'fwctl')
  printJson({ ok: true, id: frozen.id, status: frozen.status })
}

function cmdTaskAcquire(ctx: CliContext, args: { task?: string; ttl?: string }): void {
  const taskId = args.task
  if (!taskId) fail('task acquire 需要 --task')
  const outcome = ctx.workbench.acquireTask(taskId, 'fwctl', Number(args.ttl ?? 60))
  printJson({ ok: outcome.ok, taskId, blockers: outcome.blockers, status: outcome.task.status })
}

function cmdTaskStart(ctx: CliContext, args: { task?: string }): void {
  const taskId = args.task
  if (!taskId) fail('task start 需要 --task')
  printJson(ctx.workbench.startTask(taskId, 'fwctl'))
}

function cmdTaskComplete(ctx: CliContext, args: { task?: string }): void {
  const taskId = args.task
  if (!taskId) fail('task complete 需要 --task')
  const task = ctx.workbench.getTask(taskId)
  if (!task) fail(`任务不存在: ${taskId}`)
  if (task.status === 'ready' || task.status === 'blocked_resource' || task.status === 'planned') {
    ctx.workbench.acquireTask(taskId, 'fwctl')
    ctx.workbench.startTask(taskId, 'fwctl')
  }
  if (task.status === 'running') ctx.workbench.beginVerify(taskId, 'fwctl')
  printJson(ctx.workbench.completeTask(taskId, 'fwctl'))
}

function cmdTaskFail(ctx: CliContext, args: { task?: string; class?: string; message?: string }): void {
  const taskId = args.task
  const failureClass = (args.class ?? 'product') as 'product' | 'test' | 'infra'
  if (!taskId) fail('task fail 需要 --task')
  const task = ctx.workbench.getTask(taskId)
  if (!task) fail(`任务不存在: ${taskId}`)
  if (task.status === 'ready' || task.status === 'reserved') {
    ctx.workbench.startTask(taskId, 'fwctl')
  }
  printJson(ctx.workbench.failTask(taskId, failureClass, args.message ?? 'fwctl 手工标记失败', 'fwctl'))
}

function cmdTaskRelease(ctx: CliContext, args: { task?: string }): void {
  const taskId = args.task
  if (!taskId) fail('task release 需要 --task')
  const leases = releaseTaskLeases(ctx.store, taskId, 'fwctl')
  printJson({ ok: true, taskId, released: leases.length })
}

function cmdRun(ctx: CliContext, args: { task?: string; 'human-auto-accept'?: boolean }): Promise<void> {
  const taskId = args.task
  if (!taskId) fail('run 需要 --task')
  return runTaskLocally(ctx.workbench, taskId, { actor: 'fwctl', humanAutoAccept: args['human-auto-accept'] })
    .then(result => {
      printJson(result)
      if (!result.ok) process.exitCode = 2
    })
    .catch(error => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
}

function cmdRunAll(ctx: CliContext): Promise<void> {
  ctx.workbench.refreshStates('fwctl')
  const results: Array<{ taskId: string; ok: boolean; message: string }> = []
  const runNext = (): Promise<void> => {
    ctx.workbench.refreshStates('fwctl')
    const queue = ctx.workbench.readyQueue()
    if (queue.length === 0) return Promise.resolve()
    const next = queue[0]!
    return runTaskLocally(ctx.workbench, next.id, { actor: 'fwctl', humanAutoAccept: true }).then(result => {
      results.push({ taskId: result.taskId, ok: result.ok, message: result.message })
      if (result.ok) return runNext()
    })
  }
  return runNext()
    .then(() => {
      printJson({ ok: true, executed: results.length, results })
      const blocked = ctx.workbench
        .listTasks()
        .filter(task => task.status.startsWith('blocked_'))
        .map(task => ({ id: task.id, status: task.status, reason: task.blockedReason }))
      console.error(`\n剩余阻塞(预期行为):\n${JSON.stringify(blocked, null, 2)}`)
    })
    .catch(error => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
}

function cmdDemoVerify(ctx: CliContext): Promise<void> {
  // 模拟闭环一条龙:种子 -> 跑全部模拟任务 -> L1 范围验收 -> 证据包
  seedDemo(ctx.store, 'demo-verify', { reset: true, autoGate: true })
  ctx.workbench.refreshStates('demo-verify')
  const results: Array<{ taskId: string; ok: boolean; message: string }> = []
  const runNext = (): Promise<void> => {
    ctx.workbench.refreshStates('demo-verify')
    const queue = ctx.workbench.readyQueue()
    if (queue.length === 0) return Promise.resolve()
    const next = queue[0]!
    return runTaskLocally(ctx.workbench, next.id, { actor: 'demo-verify', humanAutoAccept: true }).then(result => {
      results.push({ taskId: result.taskId, ok: result.ok, message: result.message })
      if (result.ok) return runNext()
    })
  }
  return runNext()
    .then(() => {
      const evaluation = generateAcceptanceBundle({
        store: ctx.store,
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
        actor: 'fwctl',
      })
      const runs = ctx.workbench.listTestRuns()
      const titleMap = new Map(listTestCases(ctx.store).map(testCase => [testCase.id, testCase.title]))
      const junit = buildJunitXml(runs as never, titleMap)
      writeFileSync(join(evaluation.bundleDir, 'results', 'junit.xml'), junit)
      const fullDecision = evaluateRequirement(ctx.store, DEMO_REQUIREMENT_ID)
      writeFileSync(
        join(evaluation.bundleDir, 'acceptance', 'decision-scope-all.json'),
        JSON.stringify(fullDecision, null, 2),
      )

      printJson({
        ok: true,
        executed: results,
        l1Acceptance: evaluation.decision,
        bundle: evaluation.bundleId,
        bundleDir: evaluation.bundleDir,
        fullScopeDecision: fullDecision.decision,
        fullScopeReasons: fullDecision.reasons,
      })
    })
    .catch(error => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
}

function cmdTestSelect(ctx: CliContext, args: { req?: string }): void {
  const cases = listTestCases(ctx.store, args.req ? { requirementRef: args.req } : undefined)
  printJson(cases.map(testCase => ({ id: testCase.id, level: testCase.level, title: testCase.title })))
}

function cmdTestRun(ctx: CliContext, args: { case?: string }): Promise<void> {
  const caseId = args.case
  if (!caseId) fail('test run 需要 --case')
  const testCase = getTestCase(ctx.store, caseId)
  if (!testCase) fail(`用例不存在: ${caseId}`)
  return executeSimCase(ctx, testCase)
    .then(outcome => {
      const run = recordTestRun(ctx.store, {
        caseId,
        result: outcome.result,
        message: outcome.message,
        actor: 'fwctl',
      })
      printJson({ ok: outcome.result === 'PASS', run })
    })
    .catch(error => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
}

function cmdTestRecord(ctx: CliContext, args: { case?: string; result?: string; message?: string }): void {
  const caseId = args.case
  const result = args.result as TestResult | undefined
  if (!caseId || !result)
    fail('test record 需要 --case 与 --result(PASS|PRODUCT_FAIL|TEST_FAIL|INFRA_FAIL|BLOCKED_RESOURCE|INVALID|FLAKY|WAIVED)')
  const run = recordTestRun(ctx.store, { caseId, result, message: args.message, actor: 'fwctl' })
  printJson({ ok: true, run })
}

function cmdAcceptEvaluate(ctx: CliContext, args: { req?: string; scope?: string; out?: string }): void {
  const req = args.req ?? DEMO_REQUIREMENT_ID
  const scope = args.scope ?? 'all'
  const maxLevel: TestLevel | undefined = scope === 'sim' ? 'L1' : undefined
  const decision = evaluateRequirement(ctx.store, req, { maxLevel })
  if (args.out) {
    mkdirSync(resolve(args.out, '..'), { recursive: true })
    writeFileSync(resolve(args.out), JSON.stringify(decision, null, 2))
  }
  printJson(decision)
}

function cmdAcceptReport(ctx: CliContext, args: { req?: string }): void {
  const req = args.req ?? DEMO_REQUIREMENT_ID
  const generated = generateAcceptanceBundle({
    store: ctx.store,
    evidence: ctx.evidence,
    requirementId: req,
    baselines: {},
    actor: 'fwctl',
  })
  printJson({ decision: generated.decision, bundle: generated.bundleId, dir: generated.bundleDir })
}

function cmdEvidenceList(ctx: CliContext): void {
  printJson(ctx.evidence.list())
}

function cmdEvidenceExport(ctx: CliContext, args: { id?: string; out?: string }): void {
  const records = args.id ? [ctx.evidence.get(args.id)] : ctx.evidence.list()
  const payload = records
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map(record => ({ ...record, verified: ctx.evidence.verify(record) }))
  if (args.out) {
    mkdirSync(resolve(args.out), { recursive: true })
    writeFileSync(join(resolve(args.out), 'evidence-index.json'), JSON.stringify(payload, null, 2))
  }
  printJson(payload)
}

function cmdSimRun(_ctx: CliContext, args: { scenario?: string; 'task-id'?: string }): Promise<void> {
  const scenario = (args.scenario ?? 'success') as SimScenario
  if (!SCENARIO_EXPECTATIONS[scenario])
    fail(`未知场景: ${scenario}(可选: ${Object.keys(SCENARIO_EXPECTATIONS).join(', ')})`)
  const device = new VirtualDevice(`JOB-${args['task-id'] ?? 'cli'}-${Date.now()}`, { scenario })
  return device
    .runCopy()
    .then(summary => {
      printJson(summary)
      const expectation = SCENARIO_EXPECTATIONS[scenario]
      process.exitCode =
        summary.finalState === expectation.finalState && summary.pagesOut === expectation.pagesOut ? 0 : 2
    })
    .catch(error => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
}

function cmdSimComponent(args: { name?: string }): void {
  const name = args.name ?? 'component'
  // 组件级模拟(L0):确定性的构建-自测记录;Phase 0 后由容器内真实工具链替换
  console.log(`[sim-component] ${name}: L0 构建 + 契约自测通过(模拟工具链)`)
  console.log(`[sim-component] ${name}: 输出产物 ${name}.sim-artifact`)
  printJson({ ok: true, component: name, level: 'L0' })
}

function cmdSimStates(): void {
  printJson(JOB_TRANSITIONS)
}

function cmdDeviceAcquire(ctx: CliContext, args: { task?: string }): void {
  const taskId = args.task ?? 'interactive'
  const outcome = ctx.workbench.acquireTask(taskId, 'fwctl-interactive', 30)
  printJson({ ok: outcome.ok, blockers: outcome.blockers })
}

function cmdDeviceQuarantine(ctx: CliContext, args: { resource?: string; reason?: string }): void {
  const resourceId = args.resource
  if (!resourceId) fail('device quarantine 需要 --resource')
  quarantineResource(ctx.store, resourceId, args.reason ?? 'fwctl 手工隔离', 'fwctl')
  printJson({ ok: true, resourceId })
}

function cmdDeviceMaintain(ctx: CliContext, args: { resource?: string }): void {
  const resourceId = args.resource
  if (!resourceId) fail('device maintain 需要 --resource')
  completeMaintenance(ctx.store, resourceId, 'fwctl')
  printJson({ ok: true, resourceId, state: 'available' })
}

function cmdResources(ctx: CliContext): void {
  printJson({
    resources: listResources(ctx.store),
    activeLeases: listLeases(ctx.store, { activeOnly: true }),
  })
}

function cmdBuild(ctx: CliContext): void {
  // 演示构建:无 BSP 时输出确定性占位清单(Phase 0 后接入容器构建)
  const manifest = {
    builtAt: ctx.store.now(),
    platform: 'rk3588',
    note: '演示构建:RK3588 Platform Pack 待 Phase 0 BSP 事实冻结后接入真实工具链容器',
    artifacts: [{ name: 'fw-demo.bin', sha256: '0'.repeat(64) }],
  }
  printJson(manifest)
  ctx.store.appendEvent('fwctl', 'build.demo', { note: manifest.note })
}

function cmdPlanValidate(ctx: CliContext): void {
  const tasks = ctx.workbench.listTasks()
  const errors = validateDag(tasks)
  printJson({ ok: errors.length === 0, errors, tasks: tasks.length })
}

// ---------- 入口 ----------

const HELP = `
fwctl —— 打印机固件工作台确定性命令面

用法: fwctl <command> [options] [--db <path>]

常用命令:
  demo-seed                        装载本机复印 MVP(需求/契约/DAG/用例/资源)
  demo-verify                      模拟闭环一条龙:跑全部模拟任务并生成验收证据包
  run --task <id>                  本地 Runner 执行单个任务
  run all                          按 Ready 队列连续执行全部可运行任务
  ready                            查看 Ready 队列、关键路径与阻塞
  status                           工作台总览快照
  resources                        资源目录与活动租约
  requirement import --title T --text X
  contract freeze --name IF-X [--version v1]
  plan validate                    校验任务 DAG(循环/引用)
  task acquire|start|complete|fail|release --task <id>
  device acquire --task <id>
  device quarantine --resource <id> --reason R
  device maintain --resource <id>
  sim run --scenario <name>        虚拟设备场景(success/cancel-before-scan/scan-timeout/paper-empty-*/engine-recoverable-error)
  sim states                       打印作业状态机转移表
  sim component --name <x>         组件级模拟构建(L0)
  test select [--req REQ]          列出测试用例
  test run --case <TC-ID>          执行用例(模拟层;L4 用例在无真机时 BLOCKED_RESOURCE)
  test record --case <TC> --result R --message M
  accept evaluate [--req REQ] [--scope sim|all]
  accept report [--req REQ]        生成验收证据包(Evidence Bundle)
  evidence list | export [--id ID] [--out DIR]
  build                            演示构建清单(真机阶段接入容器构建)
`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      db: { type: 'string' },
      task: { type: 'string' },
      case: { type: 'string' },
      req: { type: 'string' },
      name: { type: 'string' },
      version: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      scenario: { type: 'string' },
      'task-id': { type: 'string' },
      result: { type: 'string' },
      message: { type: 'string' },
      scope: { type: 'string' },
      out: { type: 'string' },
      id: { type: 'string' },
      resource: { type: 'string' },
      reason: { type: 'string' },
      ttl: { type: 'string' },
      class: { type: 'string' },
      'human-auto-accept': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  const command = positionals[0]
  if (!command || values.help) {
    console.log(HELP)
    return
  }

  const ctx = openContext(values.db)
  try {
    switch (command) {
      case 'demo-seed':
        await cmdDemoSeed(ctx)
        break
      case 'demo-verify':
        await cmdDemoVerify(ctx)
        break
      case 'ready':
        await cmdReady(ctx)
        break
      case 'status':
        await cmdStatus(ctx)
        break
      case 'resources':
        await cmdResources(ctx)
        break
      case 'requirement':
        if (positionals[1] === 'import') await cmdRequirementImport(ctx, values)
        else fail(`未知子命令: requirement ${positionals[1] ?? ''}`)
        break
      case 'contract':
        if (positionals[1] === 'freeze') await cmdContractFreeze(ctx, values)
        else fail(`未知子命令: contract ${positionals[1] ?? ''}`)
        break
      case 'plan':
        if (positionals[1] === 'validate') await cmdPlanValidate(ctx)
        else fail(`未知子命令: plan ${positionals[1] ?? ''}`)
        break
      case 'task': {
        const sub = positionals[1]
        if (sub === 'acquire') cmdTaskAcquire(ctx, values)
        else if (sub === 'start') cmdTaskStart(ctx, values)
        else if (sub === 'complete') cmdTaskComplete(ctx, values)
        else if (sub === 'fail') cmdTaskFail(ctx, values)
        else if (sub === 'release') await cmdTaskRelease(ctx, values)
        else fail(`未知子命令: task ${sub ?? ''}`)
        break
      }
      case 'device': {
        const sub = positionals[1]
        if (sub === 'acquire') await cmdDeviceAcquire(ctx, values)
        else if (sub === 'release') await cmdTaskRelease(ctx, values)
        else if (sub === 'quarantine') await cmdDeviceQuarantine(ctx, values)
        else if (sub === 'maintain') await cmdDeviceMaintain(ctx, values)
        else fail(`未知子命令: device ${sub ?? ''}`)
        break
      }
      case 'run':
        if (positionals[1] === 'all') cmdRunAll(ctx)
        else cmdRun(ctx, values)
        break
      case 'sim': {
        const sub = positionals[1]
        if (sub === 'run') await cmdSimRun(ctx, values)
        else if (sub === 'states') await cmdSimStates()
        else if (sub === 'component') await cmdSimComponent(values)
        else fail(`未知子命令: sim ${sub ?? ''}`)
        break
      }
      case 'test': {
        const sub = positionals[1]
        if (sub === 'select') cmdTestSelect(ctx, values)
        else if (sub === 'run') await cmdTestRun(ctx, values)
        else if (sub === 'record') cmdTestRecord(ctx, values)
        else fail(`未知子命令: test ${sub ?? ''}`)
        break
      }
      case 'accept':
        if (positionals[1] === 'evaluate') await cmdAcceptEvaluate(ctx, values)
        else if (positionals[1] === 'report') await cmdAcceptReport(ctx, values)
        else fail(`未知子命令: accept ${positionals[1] ?? ''}`)
        break
      case 'evidence':
        if (positionals[1] === 'list') await cmdEvidenceList(ctx)
        else if (positionals[1] === 'export') await cmdEvidenceExport(ctx, values)
        else fail(`未知子命令: evidence ${positionals[1] ?? ''}`)
        break
      case 'build':
        await cmdBuild(ctx)
        break
      default:
        fail(`未知命令: ${command}(fwctl --help 查看帮助)`)
    }
  } finally {
    ctx.store.close()
  }
}

void main()
