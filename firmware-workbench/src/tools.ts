import { defineTool, type JsonValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { service } from './service.js'
import { seedDemo } from './demo.js'
import { runTaskLocally } from './core/runner/local.js'
import { importRawRequirement, listQuestions } from './core/align.js'
import { releaseTaskLeases } from './core/resources.js'
import { evaluateRequirement, generateAcceptanceBundle } from './core/acceptance.js'
import { recordTestRun } from './core/testing.js'
import type { TestLevel, TestResult } from './types.js'

/**
 * DSH 模型工具(方案 17.2:优先语义化工具,变更类操作经 Harness 审批)。
 */

export const PRINTER_TOOL_NAMES = [
  'printer_workbench_status',
  'printer_requirement_import',
  'printer_demo_seed',
  'printer_task_acquire',
  'printer_task_start',
  'printer_task_update',
  'printer_task_release',
  'printer_task_run',
  'printer_test_record',
  'printer_acceptance_evaluate',
] as const

/** 会改变工作台状态的工具,统一经 DSH pre-execute 审批 */
export const PRINTER_MUTATING_TOOLS = new Set<string>([
  'printer_requirement_import',
  'printer_demo_seed',
  'printer_task_acquire',
  'printer_task_start',
  'printer_task_update',
  'printer_task_release',
  'printer_task_run',
  'printer_test_record',
])

function renderJson(_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const permissiveObjectSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {},
}

export interface PrinterTools {
  status: ToolDefinition
  requirementImport: ToolDefinition
  demoSeed: ToolDefinition
  taskAcquire: ToolDefinition
  taskStart: ToolDefinition
  taskUpdate: ToolDefinition
  taskRelease: ToolDefinition
  taskRun: ToolDefinition
  testRecord: ToolDefinition
  acceptanceEvaluate: ToolDefinition
}

export function createPrinterTools(): { tools: PrinterTools; names: string[] } {
  const status = defineTool({
    name: 'printer_workbench_status',
    description:
      'Read-only snapshot of the printer firmware workbench: task DAG states, ready queue, critical path, resource leases and blocked reasons. Use it before planning any workbench action.',
    parameters: {},
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute() {
      return service.workbench.statusSnapshot()
    },
    presentCall: () => ({ card: 'generic', title: '查看工作台总览' }),
  })

  const requirementImport = defineTool({
    name: 'printer_requirement_import',
    description:
      'Import a raw printer requirement into the workbench (P0). Returns the new requirement id; follow up with Define work before any implementation task.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short requirement title.' },
      text: { type: 'string', required: true, description: 'Original requirement text from the product side.' },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 15_000,
    async execute(args: { title: string; text: string }) {
      const requirement = importRawRequirement(service.store, { title: args.title, text: args.text }, 'dsh-tool')
      return {
        requirementId: requirement.id,
        status: requirement.status,
        questions: listQuestions(service.store, requirement.id).length,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: '导入需求',
      detail: String((args as { title?: string }).title ?? ''),
    }),
  })

  const demoSeed = defineTool({
    name: 'printer_demo_seed',
    description:
      'Load the local-copy MVP seed: requirement REQ-COPY-0001, frozen contracts, full task DAG, test cases and the resource catalog. Idempotent helper for the simulator demo loop.',
    parameters: {},
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 30_000,
    async execute() {
      const workbench = service.workbench
      const seeded = seedDemo(service.store, 'dsh-tool')
      workbench.refreshStates('dsh-tool')
      return seeded
    },
    presentCall: () => ({ card: 'generic', title: '装载本机复印 MVP 种子' }),
  })

  const taskAcquire = defineTool({
    name: 'printer_task_acquire',
    description:
      'Atomically acquire every resource lease a task declares (device, serial, VNC input, simulators, human operator). On success the task becomes reserved; otherwise it stays blocked_resource with reasons.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id such as TASK-COPY-0030.' },
      ttlMinutes: { type: 'integer', description: 'Lease TTL in minutes. Default 60.' },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 15_000,
    async execute(args: { taskId: string; ttlMinutes?: number }) {
      return service.workbench.acquireTask(args.taskId, 'dsh-tool', args.ttlMinutes ?? 60)
    },
    presentCall: args => ({
      card: 'generic',
      title: '预约任务资源',
      detail: String((args as { taskId?: string }).taskId ?? ''),
    }),
  })

  const taskStart = defineTool({
    name: 'printer_task_start',
    description: 'Start a reserved task (reserved -> running) in the local runner state machine.',
    parameters: {
      taskId: { type: 'string', required: true },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 15_000,
    async execute(args: { taskId: string }) {
      return service.workbench.startTask(args.taskId, 'dsh-tool')
    },
    presentCall: args => ({
      card: 'generic',
      title: '启动任务',
      detail: String((args as { taskId?: string }).taskId ?? ''),
    }),
  })

  const taskUpdate = defineTool({
    name: 'printer_task_update',
    description:
      'Finish a running task: complete it (verifying -> succeeded, registers artifacts and releases leases) or fail it with an explicit class product|test|infra (never auto-retry product failures).',
    parameters: {
      taskId: { type: 'string', required: true },
      outcome: { type: 'string', required: true, enum: ['complete', 'fail_product', 'fail_test', 'fail_infra', 'cancel'] },
      message: { type: 'string', description: 'Failure reason or completion note.' },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 15_000,
    async execute(args: { taskId: string; outcome: string; message?: string }) {
      const workbench = service.workbench
      switch (args.outcome) {
        case 'complete':
          return workbench.completeTask(args.taskId, 'dsh-tool')
        case 'fail_product':
          return workbench.failTask(args.taskId, 'product', args.message ?? 'product failure', 'dsh-tool')
        case 'fail_test':
          return workbench.failTask(args.taskId, 'test', args.message ?? 'test failure', 'dsh-tool')
        case 'fail_infra':
          return workbench.failTask(args.taskId, 'infra', args.message ?? 'infra failure', 'dsh-tool')
        case 'cancel':
          return workbench.cancelTask(args.taskId, args.message ?? 'cancelled via DSH tool', 'dsh-tool')
        default:
          throw new Error(`未知 outcome: ${args.outcome}`)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: '更新任务结果',
      detail: `${String((args as { taskId?: string }).taskId ?? '')} -> ${String((args as { outcome?: string }).outcome ?? '')}`,
    }),
  })

  const taskRelease = defineTool({
    name: 'printer_task_release',
    description: 'Release all active leases held by a task so the device and channels return to available.',
    parameters: {
      taskId: { type: 'string', required: true },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 15_000,
    async execute(args: { taskId: string }) {
      const leases = releaseTaskLeases(service.store, args.taskId, 'dsh-tool')
      return { taskId: args.taskId, released: leases.length }
    },
    presentCall: args => ({
      card: 'generic',
      title: '释放任务租约',
      detail: String((args as { taskId?: string }).taskId ?? ''),
    }),
  })

  const taskRun = defineTool({
    name: 'printer_task_run',
    description:
      'Run one task end-to-end in the local runner: acquire leases, execute actions (simulator scenarios or shell), verify and release. This is how simulator-loop tasks are driven.',
    parameters: {
      taskId: { type: 'string', required: true },
      humanAutoAccept: { type: 'boolean', description: 'Auto-accept human actions in the simulator loop. Default false.' },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 120_000,
    async execute(args: { taskId: string; humanAutoAccept?: boolean }) {
      return runTaskLocally(service.workbench, args.taskId, {
        actor: 'dsh-tool',
        humanAutoAccept: args.humanAutoAccept ?? false,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: '运行任务',
      detail: String((args as { taskId?: string }).taskId ?? ''),
    }),
  })

  const testRecord = defineTool({
    name: 'printer_test_record',
    description:
      'Record a test run result for a case with the 8-way classification (PASS/PRODUCT_FAIL/TEST_FAIL/INFRA_FAIL/BLOCKED_RESOURCE/INVALID/FLAKY/WAIVED). Evidence-first: never record PASS without a real run.',
    parameters: {
      caseId: { type: 'string', required: true },
      result: { type: 'string', required: true, enum: ['PASS', 'PRODUCT_FAIL', 'TEST_FAIL', 'INFRA_FAIL', 'BLOCKED_RESOURCE', 'INVALID', 'FLAKY', 'WAIVED'] },
      message: { type: 'string' },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 15_000,
    async execute(args: { caseId: string; result: string; message?: string }) {
      return recordTestRun(service.store, {
        caseId: args.caseId,
        result: args.result as TestResult,
        message: args.message,
        actor: 'dsh-tool',
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: '记录测试结果',
      detail: `${String((args as { caseId?: string }).caseId ?? '')}: ${String((args as { result?: string }).result ?? '')}`,
    }),
  })

  const acceptanceEvaluate = defineTool({
    name: 'printer_acceptance_evaluate',
    description:
      'Evaluate requirement acceptance (scope=sim limits verification level to L1 simulator loop; scope=all includes real-device criteria). Optionally generate the immutable evidence bundle.',
    parameters: {
      requirementId: { type: 'string', required: true },
      scope: { type: 'string', enum: ['sim', 'all'], description: 'Default all.' },
      generateReport: { type: 'boolean', description: 'Generate the acceptance evidence bundle. Default false.' },
    },
    output: { schema: permissiveObjectSchema, render: renderJson },
    timeoutMs: 60_000,
    async execute(args: { requirementId: string; scope?: string; generateReport?: boolean }) {
      const maxLevel: TestLevel | undefined = args.scope === 'sim' ? 'L1' : undefined
      if (args.generateReport) {
        const generated = generateAcceptanceBundle({
          store: service.store,
          evidence: service.evidence,
          requirementId: args.requirementId,
          baselines: {},
          actor: 'dsh-tool',
        })
        return { decision: generated.decision, bundle: generated.bundleId, dir: generated.bundleDir }
      }
      return { decision: evaluateRequirement(service.store, args.requirementId, { maxLevel }) }
    },
    presentCall: args => ({
      card: 'generic',
      title: '评估需求验收',
      detail: `${String((args as { requirementId?: string }).requirementId ?? '')} scope=${String((args as { scope?: string }).scope ?? 'all')}`,
    }),
  })

  const tools: PrinterTools = {
    status,
    requirementImport,
    demoSeed,
    taskAcquire,
    taskStart,
    taskUpdate,
    taskRelease,
    taskRun,
    testRecord,
    acceptanceEvaluate,
  }

  return { tools, names: [...PRINTER_TOOL_NAMES] }
}
