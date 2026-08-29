import type { Context } from '@deepseek-ai/cordis'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { createPrinterTools, PRINTER_MUTATING_TOOLS } from './tools.js'
import { installWorkbenchExactRoutes } from './routes.js'
import { service } from './service.js'

export * from './types.js'
export * from './core/store.js'
export * from './core/workbench.js'
export * from './core/dag.js'
export * from './core/resources.js'
export * from './core/requirement.js'
export * from './core/contract.js'
export * from './core/testing.js'
export * from './core/acceptance.js'
export * from './core/evidence/store.js'
export * from './core/runner/local.js'
export * from './sim/job-model.js'
export * from './sim/virtual-device.js'
export * from './service.js'
export * from './tools.js'
export * from './routes.js'
export * from './demo.js'

export const name = 'dsh-firmware-workbench'
export const inject = ['tools']

type HostContext = Context & { tools: ToolRegistry }

export function apply(ctx: Context): () => Promise<void> {
  const hostCtx = ctx as HostContext
  const { tools, names } = createPrinterTools()
  const definitions = [
    tools.status,
    tools.requirementImport,
    tools.demoSeed,
    tools.taskAcquire,
    tools.taskStart,
    tools.taskUpdate,
    tools.taskRelease,
    tools.taskRun,
    tools.testRecord,
    tools.acceptanceEvaluate,
  ]
  const disposers = definitions.map((definition, index) =>
    ctx.effect(() => hostCtx.tools.register(definition), `dsh-firmware-workbench:${names[index]}`),
  )

  // 变更类工具统一经 DSH 审批(方案 17.2);只读状态查询不拦截
  const disposeApproval = ctx.on('tools/pre-execute', async (execution, next) => {
    if (!PRINTER_MUTATING_TOOLS.has(execution.name)) return next()
    const summary = summarizeMutation(execution.name, execution.arguments)
    return {
      kind: 'ask',
      reason: `工作台变更操作需要确认:\n${summary}`,
    }
  })

  installWorkbenchExactRoutes(ctx)
  ctx.logger.info(
    `dsh-firmware-workbench mounted (${names.length} tools; simulator loop ready; real-device providers pending Phase 0)`,
  )

  return async () => {
    disposeApproval()
    for (const dispose of disposers.reverse()) await dispose()
    await service.dispose()
  }
}

function summarizeMutation(toolName: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>
  switch (toolName) {
    case 'printer_requirement_import':
      return `导入需求「${String(record.title ?? '')}」`
    case 'printer_demo_seed':
      return '装载本机复印 MVP 种子数据(需求/契约/DAG/用例)'
    case 'printer_task_acquire':
      return `为任务 ${String(record.taskId ?? '')} 原子预约全部资源租约`
    case 'printer_task_start':
      return `启动任务 ${String(record.taskId ?? '')}`
    case 'printer_task_update':
      return `任务 ${String(record.taskId ?? '')} -> ${String(record.outcome ?? '')}`
    case 'printer_task_release':
      return `释放任务 ${String(record.taskId ?? '')} 的全部租约`
    case 'printer_task_run':
      return `本地 Runner 端到端运行任务 ${String(record.taskId ?? '')}`
    case 'printer_test_record':
      return `记录用例 ${String(record.caseId ?? '')} 结果: ${String(record.result ?? '')}`
    default:
      return toolName
  }
}
