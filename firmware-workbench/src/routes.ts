import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { service } from './service.js'
import { seedDemo, importUserRequirement, autoAlignRequirement, freezeContractGate } from './demo.js'
import { runTaskLocally } from './core/runner/local.js'
import { releaseTaskLeases, quarantineResource, completeMaintenance, listLeases } from './core/resources.js'
import { evaluateRequirement, generateAcceptanceBundle } from './core/acceptance.js'
import { listTestCases, getTestCase, recordTestRun } from './core/testing.js'
import { demoDirector, type DemoStateView } from './core/demo-player.js'
import { changeItem } from './core/align.js'
import { aiClarifyQuestions, aiDraftDefine } from './core/ai-orchestrator.js'
import {
  listRequirements,
  listQuestions,
  addQuestion,
  answerQuestion,
  listItems,
  proposeItem,
  draftDefine,
  listDefineVersions,
  submitDefine,
  reviewDefine,
  laneSummary,
} from './core/align.js'
import { simService } from './sim/sim-service.js'
import { SCENARIO_EXPECTATIONS, type SimScenario } from './sim/virtual-device.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestResult } from './types.js'
import type { Workbench } from './core/workbench.js'

/**
 * 座舱 API(方案 14):仅本机同源可访问;读接口开放,写接口最小化
 * (变更经 DSH 工具审批链路,HTTP 侧只保留运行队列与演示动作)。
 */

export const ROUTE_PREFIX = '/_dsh/dsh-firmware-workbench'

export const ROUTES = {
  snapshot: `${ROUTE_PREFIX}/snapshot`,
  tasks: `${ROUTE_PREFIX}/tasks`,
  resources: `${ROUTE_PREFIX}/resources`,
  events: `${ROUTE_PREFIX}/events`,
  cases: `${ROUTE_PREFIX}/cases`,
  demoSeed: `${ROUTE_PREFIX}/demo-seed`,
  runTask: `${ROUTE_PREFIX}/run-task`,
  releaseTask: `${ROUTE_PREFIX}/release-task`,
  resourceAction: `${ROUTE_PREFIX}/resource-action`,
  acceptance: `${ROUTE_PREFIX}/acceptance`,
  demoState: `${ROUTE_PREFIX}/demo/state`,
  demoPlay: `${ROUTE_PREFIX}/demo/play`,
  demoStep: `${ROUTE_PREFIX}/demo/step`,
  demoPause: `${ROUTE_PREFIX}/demo/pause`,
  demoReset: `${ROUTE_PREFIX}/demo/reset`,
  reportLatest: `${ROUTE_PREFIX}/report/latest`,
  reportLatestMd: `${ROUTE_PREFIX}/report/latest.md`,
  reportList: `${ROUTE_PREFIX}/report/list`,
  simState: `${ROUTE_PREFIX}/sim/state`,
  simRun: `${ROUTE_PREFIX}/sim/run`,
  simAction: `${ROUTE_PREFIX}/sim/action`,
  caseRun: `${ROUTE_PREFIX}/case-run`,
  requirements: `${ROUTE_PREFIX}/requirements`,
  clarify: `${ROUTE_PREFIX}/clarify`,
  clarifyAnswer: `${ROUTE_PREFIX}/clarify/answer`,
  clarifyAdd: `${ROUTE_PREFIX}/clarify/add`,
  items: `${ROUTE_PREFIX}/items`,
  itemPropose: `${ROUTE_PREFIX}/items/propose`,
  itemChange: `${ROUTE_PREFIX}/items/change`,
  aiClarify: `${ROUTE_PREFIX}/ai/clarify`,
  aiDefine: `${ROUTE_PREFIX}/ai/define`,
  defineDraft: `${ROUTE_PREFIX}/define/draft`,
  defineSubmit: `${ROUTE_PREFIX}/define/submit`,
  defineReview: `${ROUTE_PREFIX}/define/review`,
  lane: `${ROUTE_PREFIX}/lane`,
  requirementImport: `${ROUTE_PREFIX}/requirement/import`,
  defineApprove: `${ROUTE_PREFIX}/define/approve`,
  contractsFreeze: `${ROUTE_PREFIX}/contracts/freeze`,
  runs: `${ROUTE_PREFIX}/runs`,
} as const

const MAX_BODY_BYTES = 64 * 1_024

interface RouteMount {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function isLoopback(address: string | undefined): boolean {
  const normalized = address?.toLowerCase().replace(/^::ffff:/u, '')
  return normalized === '::1' || normalized === '127.0.0.1' || (normalized?.startsWith('127.') ?? false)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = (req.method ?? 'GET').toUpperCase()

  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: '座舱 API 仅允许本机访问' })
    return
  }

  const workbench = service.workbench

  if (method === 'GET') {
    switch (path) {
      case ROUTES.snapshot: {
        // 座舱轮询入口:顺带做状态刷新(幂等),保证阻塞原因与 Ready 队列最新
        workbench.sweep('web')
        const snapshot = workbench.statusSnapshot() as Record<string, unknown>
        const gates = service.store.db
          .prepare('SELECT id, decision FROM gates ORDER BY id')
          .all() as Array<{ id: string; decision: string }>
        const reportMeta = readLatestReportMeta(service.store)
        snapshot.requirements = listRequirements(service.store).map(req => ({
          ...req,
          questions: listQuestions(service.store, req.id),
          items: listItems(service.store, req.id),
          defines: listDefineVersions(service.store, req.id),
          openQuestions: listQuestions(service.store, req.id).filter(q => q.status === 'open').length,
          itemCount: listItems(service.store, req.id).length,
        }))
        snapshot.lane = laneSummary(service.store)
        snapshot.gates = gates
        snapshot.acceptance = reportMeta
          ? { acceptanceId: reportMeta.acceptanceId, decision: reportMeta.decision, decidedAt: reportMeta.decidedAt }
          : null
        sendJson(res, 200, snapshot)
        return
      }
      case ROUTES.tasks:
        sendJson(res, 200, workbench.listTasks())
        return
      case ROUTES.resources:
        sendJson(res, 200, { resources: workbench.listAllResources(), activeLeases: listLeases(service.store, { activeOnly: true }) })
        return
      case ROUTES.events: {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const after = Number(url.searchParams.get('after') ?? '0')
        const all = service.store.listEvents(400).reverse()
        const events = after > 0 ? all.filter(event => event.id > after) : all.slice(-100)
        sendJson(res, 200, { events, cursor: all.length > 0 ? all[all.length - 1]!.id : after })
        return
      }
      case ROUTES.cases:
        sendJson(res, 200, listTestCases(service.store))
        return
      case ROUTES.requirements: {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const reqId = url.searchParams.get('id')
        const all = listRequirements(service.store)
        const result = reqId
          ? all.filter(req => req.id === reqId).map(req => ({
              ...req,
              questions: listQuestions(service.store, req.id),
              items: listItems(service.store, req.id),
              defines: listDefineVersions(service.store, req.id),
            }))
          : all.map(req => ({
              ...req,
              openQuestions: listQuestions(service.store, req.id).filter(q => q.status === 'open').length,
              itemCount: listItems(service.store, req.id).length,
            }))
        sendJson(res, 200, result)
        return
      }
      case ROUTES.clarify: {
        const url = new URL(req.url ?? '/', 'http://localhost')
        sendJson(res, 200, listQuestions(service.store, url.searchParams.get('req') ?? undefined))
        return
      }
      case ROUTES.items: {
        const url = new URL(req.url ?? '/', 'http://localhost')
        sendJson(res, 200, listItems(service.store, url.searchParams.get('req') ?? undefined))
        return
      }
      case ROUTES.lane:
        sendJson(res, 200, laneSummary(service.store))
        return
      case ROUTES.demoState: {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const logCursor = Number(url.searchParams.get('logCursor') ?? '0')
        sendJson(res, 200, demoDirector.getState(Number.isFinite(logCursor) ? logCursor : 0))
        return
      }
      case ROUTES.reportLatest: {
        const report = buildLatestReport(service.store, service.evidence)
        if (!report) {
          sendJson(res, 404, { error: '尚未生成验收报告' })
          return
        }
        sendJson(res, 200, report)
        return
      }
      case ROUTES.reportLatestMd: {
        const report = buildLatestReport(service.store, service.evidence)
        if (!report) {
          sendJson(res, 404, { error: '尚未生成验收报告' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${report.acceptanceId}.md"`,
        })
        res.end(report.markdown)
        return
      }
      case ROUTES.reportList: {
        const rows = service.store.db
          .prepare("SELECT id FROM evidence WHERE kind = 'bundle' ORDER BY created_at DESC LIMIT 20")
          .all() as Array<{ id: string }>
        const list = rows
          .map(row => service.evidence.get(row.id))
          .filter(Boolean)
          .map(record => ({
            acceptanceId: (record as unknown as { refs: Record<string, string> }).refs?.acceptanceId ?? record!.name,
            bundleId: record!.id,
            createdAt: record!.createdAt,
          }))
        sendJson(res, 200, list)
        return
      }
      case ROUTES.simState:
        sendJson(res, 200, simService.state())
        return
      case ROUTES.runs: {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const caseId = url.searchParams.get('caseId') ?? undefined
        const limit = Math.min(100, Number(url.searchParams.get('limit') ?? '50'))
        const runs = workbench.listTestRuns().filter(run => !caseId || run.caseId === caseId).slice(0, limit)
        sendJson(res, 200, runs)
        return
      }
      default:
        sendJson(res, 404, { error: `未知路径: ${path}` })
        return
    }
  }

  if (method === 'POST') {
    let body: Record<string, unknown> = {}
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 400, { error: errorMessage(error) })
      return
    }

    try {
      switch (path) {
        case ROUTES.demoSeed: {
          const seeded = seedDemo(service.store, 'web')
          workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, ...seeded })
          return
        }
        case ROUTES.runTask: {
          const taskId = String(body.taskId ?? '')
          if (!taskId) throw new Error('缺少 taskId')
          const result = await runTaskLocally(workbench, taskId, {
            actor: 'web',
            humanAutoAccept: body.humanAutoAccept === true,
          })
          workbench.refreshStates('web')
          sendJson(res, result.ok ? 200 : 409, result)
          return
        }
        case ROUTES.releaseTask: {
          const taskId = String(body.taskId ?? '')
          const released = releaseTaskLeases(service.store, taskId, 'web')
          sendJson(res, 200, { ok: true, taskId, released: released.length })
          return
        }
        case ROUTES.resourceAction: {
          const resourceId = String(body.resourceId ?? '')
          const action = String(body.action ?? '')
          if (action === 'quarantine') {
            quarantineResource(service.store, resourceId, String(body.reason ?? 'web 手工隔离'), 'web')
          } else if (action === 'maintain') {
            completeMaintenance(service.store, resourceId, 'web')
          } else {
            throw new Error(`不支持的动作: ${action}`)
          }
          sendJson(res, 200, { ok: true, resourceId, action })
          return
        }
        case ROUTES.acceptance: {
          const requirementId = String(body.requirementId ?? '')
          if (!requirementId) throw new Error('缺少 requirementId')
          const scope = body.scope === 'sim' ? ('L1' as const) : undefined
          if (body.generateReport === true) {
            const generated = generateAcceptanceBundle({
              store: service.store,
              evidence: service.evidence,
              requirementId,
              baselines: {
                product: 'PRD-A4-MONO-MFP-v0.1',
                platform: 'PLAT-RK3588-BSP-unfrozen(Phase 0 待冻结)',
                firmwareSha256: 'sim-loop-no-real-firmware',
                sourceCommit: 'simulator-loop',
                hardwareRevision: 'virtual-device',
              },
              maxLevel: 'L1',
              actor: 'web',
            })
            sendJson(res, 200, generated.decision)
            return
          }
          sendJson(res, 200, evaluateRequirement(service.store, requirementId, { maxLevel: scope }))
          return
        }
        case ROUTES.requirementImport: {
          const title = String(body.title ?? '').trim()
          const text = String(body.text ?? '').trim()
          if (!title || !text) throw new Error('需要 title 与 text')
          const result = importUserRequirement(service.store, { title, text }, 'web')
          service.workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        case ROUTES.defineApprove: {
          // 兼容路由:答问题+条目+Define 起草+批准一步完成(引导 UI v2 已拆分为逐步接口)
          const requirementId = String(body.requirementId ?? 'REQ-COPY-0001')
          const result = autoAlignRequirement(service.store, requirementId, 'web')
          service.workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        case ROUTES.contractsFreeze: {
          const result = freezeContractGate(service.store, 'web')
          service.workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        case ROUTES.demoPlay: {
          const state = demoDirector.play(
            { workbench, evidence: service.evidence },
            {
              mode: body.mode === 'step' ? 'step' : 'auto',
              reset: body.reset === true,
              speedMs: Number(body.speedMs ?? 0) || undefined,
            },
          )
          sendJson(res, 200, { ok: true, state })
          return
        }
        case ROUTES.demoStep: {
          const state: DemoStateView = demoDirector.step({ workbench, evidence: service.evidence })
          sendJson(res, 200, { ok: true, state })
          return
        }
        case ROUTES.demoPause: {
          sendJson(res, 200, { ok: true, state: demoDirector.pause() })
          return
        }
        case ROUTES.demoReset: {
          sendJson(res, 200, { ok: true, state: demoDirector.reset({ workbench, evidence: service.evidence }) })
          return
        }
        case ROUTES.simRun: {
          const scenario = String(body.scenario ?? 'success') as SimScenario
          if (!SCENARIO_EXPECTATIONS[scenario]) throw new Error(`未知场景: ${scenario}`)
          const { jobId } = await simService.run(scenario, {
            interactive: body.interactive === true,
            slow: body.slow === true,
          })
          service.store.appendEvent('web', 'sim.run', { jobId, scenario })
          sendJson(res, 200, { ok: true, jobId })
          return
        }
        case ROUTES.simAction: {
          const action = String(body.action ?? '') as 'load-paper' | 'give-up' | 'cancel'
          if (!['load-paper', 'give-up', 'cancel'].includes(action)) throw new Error(`不支持的动作: ${action}`)
          sendJson(res, 200, { ok: true, ...simService.action(action), state: simService.state() })
          return
        }
        case ROUTES.clarifyAnswer: {
          const questionId = String(body.questionId ?? '')
          const answer = String(body.answer ?? '').trim()
          if (!questionId || !answer) throw new Error('需要 questionId 与 answer')
          const question = answerQuestion(service.store, questionId, answer, 'web')
          sendJson(res, 200, { ok: true, question })
          return
        }
        case ROUTES.clarifyAdd: {
          const requirementId = String(body.requirementId ?? '')
          const question = String(body.question ?? '').trim()
          if (!requirementId || !question) throw new Error('需要 requirementId 与 question')
          const added = addQuestion(service.store, {
            requirementId,
            question,
            why: body.why ? String(body.why) : undefined,
            origin: 'manual',
          }, 'web')
          sendJson(res, 200, { ok: true, question: added })
          return
        }
        case ROUTES.itemPropose: {
          const requirementId = String(body.requirementId ?? '')
          const content = String(body.content ?? '').trim()
          if (!requirementId || !content) throw new Error('需要 requirementId 与 content')
          const item = proposeItem(service.store, {
            requirementId,
            content,
            acceptance: Array.isArray(body.acceptance) ? (body.acceptance as never[]) : [],
            priority: body.priority === 'high' ? 'high' : body.priority === 'low' ? 'low' : 'medium',
            origin: String(body.origin ?? 'manual'),
          }, 'web')
          sendJson(res, 200, { ok: true, item })
          return
        }
        case ROUTES.itemChange: {
          const itemId = String(body.itemId ?? '')
          if (!itemId) throw new Error('需要 itemId')
          const outcome = changeItem(service.store, {
            itemId,
            content: body.content ? String(body.content) : undefined,
            acceptance: Array.isArray(body.acceptance) ? (body.acceptance as never[]) : undefined,
            source: ['customer', 'implementation-finding', 'test-finding'].includes(String(body.source))
              ? (String(body.source) as 'customer' | 'implementation-finding' | 'test-finding')
              : 'customer',
            summary: String(body.summary ?? '需求变更'),
            detail: body.detail ? String(body.detail) : undefined,
          }, 'web')
          service.workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, ...outcome })
          return
        }
        case ROUTES.aiClarify: {
          const requirementId = String(body.requirementId ?? '')
          if (!requirementId) throw new Error('需要 requirementId')
          service.store.appendEvent('web', 'ai.clarify_start', { requirementId })
          const result = await aiClarifyQuestions(service.store, requirementId, 'web')
          sendJson(res, result.ok ? 200 : 502, result)
          return
        }
        case ROUTES.aiDefine: {
          const requirementId = String(body.requirementId ?? '')
          if (!requirementId) throw new Error('需要 requirementId')
          service.store.appendEvent('web', 'ai.define_start', { requirementId })
          const result = await aiDraftDefine(service.store, requirementId, 'web')
          sendJson(res, result.ok ? 200 : 502, result)
          return
        }
        case ROUTES.defineDraft: {
          const requirementId = String(body.requirementId ?? '')
          const define = draftDefine(service.store, requirementId, (body.body as Record<string, unknown>) ?? {}, 'web')
          sendJson(res, 200, { ok: true, define })
          return
        }
        case ROUTES.defineSubmit: {
          const define = submitDefine(service.store, String(body.defineId ?? ''), 'web')
          sendJson(res, 200, { ok: true, define })
          return
        }
        case ROUTES.defineReview: {
          const result = reviewDefine(service.store, {
            defineId: String(body.defineId ?? ''),
            decision: body.decision === 'approve' ? 'approve' : body.decision === 'comment' ? 'comment' : 'request-changes',
            reviewer: String(body.reviewer ?? 'web'),
            comments: Array.isArray(body.comments) ? (body.comments as Array<{ itemId?: string; section?: string; text: string }>) : [],
          })
          service.workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, define: result.define, requirement: result.requirement })
          return
        }
        case ROUTES.caseRun: {
          const caseId = String(body.caseId ?? '')
          const testCase = getTestCase(service.store, caseId)
          if (!testCase) throw new Error(`用例不存在: ${caseId}`)
          const outcome = await executeCaseAgainstSim(workbench, caseId)
          const run = recordTestRun(service.store, {
            caseId,
            result: outcome.result,
            message: outcome.message,
            actor: 'web',
          })
          sendJson(res, 200, { ok: outcome.result === 'PASS', run })
          return
        }
        default:
          sendJson(res, 404, { error: `未知路径: ${path}` })
      }
    } catch (error) {
      sendJson(res, 400, { error: errorMessage(error) })
    }
    return
  }

  sendJson(res, 405, { error: '方法不支持' })
}

/** L4 真机用例:无真机时记录 BLOCKED_RESOURCE(方案 11.4,不装作验证过) */
async function executeCaseAgainstSim(
  workbench: Workbench,
  caseId: string,
): Promise<{ result: TestResult; message: string }> {
  const L4_CASES = new Set(['TC-COPY-REC-0006', 'TC-COPY-REC-0007'])
  if (L4_CASES.has(caseId)) {
    const device = workbench.listAllResources().find(item => item.id === 'device/printer-01')
    const available = device && device.state === 'available' && device.busyUnits === 0
    if (!available) {
      return { result: 'BLOCKED_RESOURCE', message: '真机用例:Printer-01 不可用,保持排队(方案 11.4)' }
    }
    return { result: 'PRODUCT_FAIL', message: '真机 Provider 未接入,不能模拟 L4 结论' }
  }
  const scenarioMap: Record<string, SimScenario> = {
    'TC-COPY-FUNC-0001': 'success',
    'TC-COPY-REC-0002': 'cancel-before-scan',
    'TC-COPY-REC-0003': 'scan-timeout',
    'TC-COPY-REC-0004': 'paper-empty-then-recover',
    'TC-COPY-REC-0005': 'paper-empty-no-recovery',
  }
  const scenario = scenarioMap[caseId] as SimScenario | undefined
  if (!scenario) return { result: 'INVALID', message: '用例未绑定模拟场景' }
  const { VirtualDevice, SCENARIO_EXPECTATIONS } = await import('./sim/virtual-device.js')
  const device = new VirtualDevice(`JOB-${caseId}-${Date.now()}`, { scenario, scanMs: 60, processMs: 40, printMs: 80 })
  const summary = await device.runCopy()
  const expectation = SCENARIO_EXPECTATIONS[scenario]
  const ok = summary.finalState === expectation.finalState && summary.pagesOut === expectation.pagesOut
  return ok
    ? { result: 'PASS', message: `${summary.message}(终态 ${summary.finalState},出纸 ${summary.pagesOut})` }
    : { result: 'PRODUCT_FAIL', message: `偏离状态机预期: ${summary.finalState}/${summary.pagesOut}` }
}

function readLatestReportMeta(store: import('./core/store.js').WorkbenchStore):
  | { acceptanceId: string; requirementId: string; decision: string; decidedAt: string; bundleId: string; bundleDir: string }
  | null {
  const raw = store.getMeta('report.latest')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function buildLatestReport(
  store: import('./core/store.js').WorkbenchStore,
  evidence: import('./core/evidence/store.js').EvidenceStore,
):
  | {
      acceptanceId: string
      requirementId: string
      decision: string
      decidedAt: string
      coverage: Record<string, number>
      reasons: string[]
      highestVerifiedLevel: string
      baselines: Record<string, string>
      bundle: { id: string; dir: string; files: Array<{ path: string; bytes: number }> }
      markdown: string
    }
  | null {
  const meta = readLatestReportMeta(store)
  if (!meta) return null
  let decisionJson: Record<string, unknown> = {}
  let markdown = ''
  const files: Array<{ path: string; bytes: number }> = []
  const bundleRecord = evidence.get(meta.bundleId)
  if (bundleRecord?.entries) {
    for (const entry of bundleRecord.entries) {
      files.push({ path: entry.path, bytes: entry.bytes })
    }
  }
  try {
    decisionJson = JSON.parse(readFileSync(join(meta.bundleDir, 'acceptance', 'decision.json'), 'utf8'))
    markdown = readFileSync(join(meta.bundleDir, 'acceptance', 'report.md'), 'utf8')
    const manifest = JSON.parse(readFileSync(join(meta.bundleDir, 'manifest.json'), 'utf8')) as {
      highestVerifiedLevel?: string
      baselines?: Record<string, string>
    }
    decisionJson.highestVerifiedLevel = manifest.highestVerifiedLevel
    decisionJson.baselines = manifest.baselines
  } catch {
    // bundle 目录缺失时返回 meta 级信息
  }
  return {
    acceptanceId: meta.acceptanceId,
    requirementId: meta.requirementId,
    decision: meta.decision,
    decidedAt: meta.decidedAt,
    coverage: (decisionJson.coverage as Record<string, number>) ?? {},
    reasons: (decisionJson.reasons as string[]) ?? [],
    highestVerifiedLevel: (decisionJson.highestVerifiedLevel as string) ?? 'L1(模拟层)',
    baselines: (decisionJson.baselines as Record<string, string>) ?? {},
    bundle: { id: meta.bundleId, dir: meta.bundleDir, files },
    markdown,
  }
}

export function installWorkbenchRoutes(ctx: Context): void {
  ctx.inject(['webServer'], webCtx => {
    const webServer = (webCtx as Context & { webServer: RouteMount }).webServer
    return webServer.register({ kind: 'prefix', path: `${ROUTE_PREFIX}/`, handler: handle })
  })
}

/** 逐条注册 exact 路由(host-webserver 的 GET/POST 分流由 handler 内处理) */
export function installWorkbenchExactRoutes(ctx: Context): void {
  ctx.inject(['webServer'], webCtx => {
    const webServer = (webCtx as Context & { webServer: RouteMount }).webServer
    const disposers = Object.values(ROUTES).map(path =>
      webServer.register({ kind: 'exact', path, handler: handle }),
    )
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}
