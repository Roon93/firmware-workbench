import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvidenceStore } from './evidence/store.js'
import type { WorkbenchStore } from './store.js'
import { buildJunitXml, levelRank, listTestCases, summarizeCoverage, type TestCaseRow } from './testing.js'
import { listAcceptanceCriteria } from './requirement.js'
import { listTestRuns } from './workbench.js'
import type { TestLevel, TestResult } from '../types.js'

/**
 * 需求验收(方案 12.2/12.5,附录 D):
 * 独立验收只有全部必选用例执行且通过、证据完整才可 PASS;
 * BLOCKED / INVALID / 未执行不能当成通过。
 */

export interface AcceptanceDecision {
  acceptanceId: string
  requirementId: string
  decision: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'BLOCKED'
  coverage: {
    requiredCases: number
    passed: number
    failed: number
    blocked: number
    invalid: number
    waived: number
    notRun: number
  }
  reasons: string[]
  evidenceBundle?: string
  decidedAt: string
}

export interface AcceptanceBaselines {
  product?: string
  platform?: string
  firmwareSha256?: string
  sourceCommit?: string
  hardwareRevision?: string
}

/**
 * 评估需求验收;opts.maxLevel 限定验收范围(方案 19.4:
 * 模拟闭环阶段以 L1 范围评估,真机层级保持 BLOCKED,不宣称整机验收)。
 */
export function evaluateRequirement(
  store: WorkbenchStore,
  requirementId: string,
  opts: { maxLevel?: TestLevel } = {},
): AcceptanceDecision {
  const allCriteria = listAcceptanceCriteria(store, requirementId)
  const criteria = opts.maxLevel
    ? allCriteria.filter(criterion => levelRank(criterion.maxLevel) <= levelRank(opts.maxLevel as TestLevel))
    : allCriteria
  const scopedIds = new Set(criteria.map(criterion => criterion.id))
  const coverageRows = summarizeCoverage(store, requirementId).filter(
    row => !opts.maxLevel || row.acceptanceRefs.some(ref => scopedIds.has(ref)),
  )
  const reasons: string[] = []
  if (opts.maxLevel) {
    reasons.push(`评估范围:验证层级 <= ${opts.maxLevel}(模拟闭环;更高层级另行真机验收)`)
  }

  let passed = 0
  let failed = 0
  let blocked = 0
  let invalid = 0
  let waived = 0
  let notRun = 0

  for (const row of coverageRows) {
    if (!row.required) continue
    switch (row.latest) {
      case 'PASS':
        passed += 1
        break
      case 'PRODUCT_FAIL':
      case 'TEST_FAIL':
        failed += 1
        reasons.push(`${row.caseId} 失败(${row.latest})`)
        break
      case 'INFRA_FAIL':
        failed += 1
        reasons.push(`${row.caseId} 基础设施失败,需处理后重跑`)
        break
      case 'BLOCKED_RESOURCE':
        blocked += 1
        reasons.push(`${row.caseId} 资源不可用,保持排队`)
        break
      case 'INVALID':
        invalid += 1
        reasons.push(`${row.caseId} 运行无效,需清理后重跑`)
        break
      case 'WAIVED':
        waived += 1
        reasons.push(`${row.caseId} 已获偏差批准`)
        break
      case 'FLAKY':
        invalid += 1
        reasons.push(`${row.caseId} 结果不稳定,已隔离追踪`)
        break
      default:
        notRun += 1
        reasons.push(`${row.caseId} 尚未执行`)
    }
  }

  let decision: AcceptanceDecision['decision']
  if (criteria.length === 0) {
    decision = 'BLOCKED'
    reasons.push('需求尚无验收标准')
  } else if (notRun + blocked + invalid > 0) {
    decision = 'BLOCKED'
  } else if (failed > 0) {
    decision = 'FAIL'
  } else if (passed + waived === coverageRows.filter(row => row.required).length && passed > 0) {
    decision = 'PASS'
  } else {
    decision = 'BLOCKED'
    reasons.push('没有已执行且通过的必选用例')
  }

  const seq = Number(store.getMeta('acceptance.seq') ?? '0') + 1
  store.setMeta('acceptance.seq', String(seq))
  const acceptanceId = `ACCEPT-${requirementId}-${String(seq).padStart(3, '0')}`

  return {
    acceptanceId,
    requirementId,
    decision,
    coverage: {
      requiredCases: coverageRows.filter(row => row.required).length,
      passed,
      failed,
      blocked,
      invalid,
      waived,
      notRun,
    },
    reasons,
    decidedAt: store.now(),
  }
}

export interface GenerateReportInput {
  store: WorkbenchStore
  evidence: EvidenceStore
  requirementId: string
  baselines: AcceptanceBaselines
  /** 验收范围(方案 19.4):模拟闭环阶段传 'L1',缺省全量 */
  maxLevel?: TestLevel
  actor?: string
}

interface RunRowLike {
  id: string
  caseId: string
  result: TestResult
  message?: string
  level: string
}

/** 生成完整 Evidence Bundle(方案 13.1)并登记内容寻址证据;返回决定与 bundle 记录 */
export function generateAcceptanceBundle(
  input: GenerateReportInput,
): { decision: AcceptanceDecision; bundleId: string; bundleDir: string } {
  const { store, evidence, requirementId } = input
  const decision = evaluateRequirement(store, requirementId, { maxLevel: input.maxLevel })
  const seq = decision.acceptanceId.split('-').pop()
  const runId = `RUN-${store.now().slice(0, 10).replaceAll('-', '')}-ACCEPT-${seq}`
  const bundleDir = join(evidence.root, 'bundles', runId)

  const reqRow = store.db.prepare('SELECT * FROM requirements WHERE id = ?').get(requirementId) as
    | Record<string, unknown>
    | undefined
  if (!reqRow) throw new Error(`需求不存在: ${requirementId}`)

  const cases = listTestCases(store, { requirementRef: requirementId })
  const runs = listTestRuns(store).filter(run =>
    cases.some(testCase => testCase.id === run.caseId),
  ) as RunRowLike[]

  // ---- 目录结构(方案 13.1) ----
  const dir = (rel: string): string => {
    const full = join(bundleDir, rel)
    mkdirSync(full, { recursive: true })
    return full
  }
  mkdirSync(bundleDir, { recursive: true })

  // manifest.json:bundle 自描述 + 各基线
  const manifest = {
    runId,
    kind: 'requirement-acceptance',
    requirement: requirementId,
    acceptanceId: decision.acceptanceId,
    decision: decision.decision,
    createdAt: store.now(),
    baselines: {
      requirement: `${requirementId}`,
      product: input.baselines.product ?? store.getMeta('baseline.product') ?? 'PRD-A4-MONO-MFP-v0.1',
      platform: input.baselines.platform ?? store.getMeta('baseline.platform') ?? 'PLAT-RK3588-BSP-unfrozen',
      firmwareSha256: input.baselines.firmwareSha256 ?? store.getMeta('baseline.firmware_sha256') ?? '',
      sourceCommit: input.baselines.sourceCommit ?? '',
      hardwareRevision: input.baselines.hardwareRevision ?? 'simulator',
    },
    highestVerifiedLevel: highestVerifiedLevel(runs as unknown as Array<{ result: TestResult; level: string }>),
    acceptanceScope: input.maxLevel ? `验证层级 <= ${input.maxLevel}(模拟闭环)` : '全部层级',
  }
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // requirement-baseline.yaml(简化 YAML,不引入重依赖)
  writeFileSync(
    join(bundleDir, 'requirement-baseline.yaml'),
    renderRequirementYaml(reqRow, criteriaRows(store, requirementId)),
  )

  // task-plan.yaml:相关任务与状态
  const tasks = store.db.prepare('SELECT id, type, title, status FROM tasks').all() as Array<
    Record<string, string>
  >
  writeFileSync(
    join(bundleDir, 'task-plan.yaml'),
    ['tasks:']
      .concat(tasks.map(task => `  - id: ${task.id}\n    type: ${task.type}\n    title: ${JSON.stringify(task.title)}\n    status: ${task.status}`))
      .join('\n'),
  )

  // source-state.json
  writeFileSync(
    join(bundleDir, 'source-state.json'),
    JSON.stringify(
      {
        note: 'MVP 模拟闭环:任务动作为模拟器执行,无真实固件源码提交',
        sourceCommit: manifest.baselines.sourceCommit || null,
        firmwareSha256: manifest.baselines.firmwareSha256 || null,
      },
      null,
      2,
    ),
  )

  // execution/steps.jsonl:审计事件时间线
  const events = store.listEvents(2000).reverse()
  writeFileSync(
    join(dir('execution'), 'steps.jsonl'),
    events.map(event => JSON.stringify({ ts: event.ts, actor: event.actor, kind: event.kind, payload: event.payload })).join('\n'),
  )

  // results/:JUnit + 汇总断言
  const titleMap = new Map(cases.map(testCase => [testCase.id, testCase.title]))
  writeFileSync(join(dir('results'), 'junit.xml'), buildJunitXml(runs as never, titleMap))
  writeFileSync(
    join(dir('results'), 'assertions.json'),
    JSON.stringify(
      {
        decision: decision.decision,
        coverage: decision.coverage,
        reasons: decision.reasons,
        rule: '方案 12.5:必选用例全部执行且通过;BLOCKED/INVALID/未执行不视为通过',
      },
      null,
      2,
    ),
  )

  // visual/:说明占位(模拟层无真实面板截图;虚拟面板事件在 execution 内)
  writeFileSync(
    join(dir('visual'), 'README.txt'),
    'MVP 模拟闭环:面板画面来自虚拟面板,事件时间线见 execution/steps.jsonl;真实面板截图在真机阶段采集。\n',
  )

  // acceptance/:决定 + 报告
  writeFileSync(join(dir('acceptance'), 'decision.json'), JSON.stringify(decision, null, 2))
  writeFileSync(join(dir('acceptance'), 'report.md'), renderReportMd(manifest, decision, cases, runs as never))

  const bundle = evidence.registerBundle(
    bundleDir,
    `acceptance-${requirementId}`,
    { requirement: requirementId, acceptanceId: decision.acceptanceId },
  )
  store.setMeta(
    'report.latest',
    JSON.stringify({
      acceptanceId: decision.acceptanceId,
      requirementId,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
      bundleId: bundle.id,
      bundleDir,
    }),
  )
  store.appendEvent(input.actor ?? 'acceptor', 'acceptance.bundle_generated', {
    acceptanceId: decision.acceptanceId,
    decision: decision.decision,
    bundle: bundle.id,
  })

  return { decision, bundleId: bundle.id, bundleDir }
}

function highestVerifiedLevel(runs: Array<{ result: TestResult; level: string }>): string {
  const passed = new Set(runs.filter(run => run.result === 'PASS').map(run => run.level))
  const order = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']
  let highest = 'none'
  for (const level of order) {
    if (passed.has(level)) highest = level
  }
  // 模拟闭环的上限是 L1:超出部分仅代表用例设计层级,不是已验证层级
  return highest === 'none' ? 'none(L1 模拟层为本次闭环上限)' : `${highest}(模拟层;真机层级未验证)`
}

function criteriaRows(store: WorkbenchStore, requirementId: string): Array<Record<string, unknown>> {
  return store.db
    .prepare('SELECT id, title, method, threshold, max_level, status FROM acceptance_criteria WHERE requirement_id = ?')
    .all(requirementId) as Array<Record<string, unknown>>
}

function renderRequirementYaml(req: Record<string, unknown>, criteria: Array<Record<string, unknown>>): string {
  const lines: string[] = []
  lines.push(`requirement_id: ${req.id}`)
  lines.push(`title: ${JSON.stringify(String(req.title))}`)
  lines.push(`status: ${req.status}`)
  lines.push(`original_text: ${JSON.stringify(String(req.original_text ?? ''))}`)
  if (req.definition) {
    lines.push('definition:')
    const def = JSON.parse(String(req.definition)) as Record<string, unknown>
    for (const [key, value] of Object.entries(def)) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`)
    }
  }
  lines.push('acceptance_criteria:')
  for (const criterion of criteria) {
    lines.push(`  - id: ${criterion.id}`)
    lines.push(`    title: ${JSON.stringify(String(criterion.title))}`)
    lines.push(`    method: ${criterion.method}`)
    lines.push(`    max_level: ${criterion.max_level}`)
  }
  return lines.join('\n')
}

function renderReportMd(
  manifest: Record<string, unknown>,
  decision: AcceptanceDecision,
  cases: TestCaseRow[],
  runs: RunRowLike[],
): string {
  const lines: string[] = []
  lines.push('# 需求验收报告(模拟闭环)')
  lines.push('')
  lines.push(`- 验收编号:${decision.acceptanceId}`)
  lines.push(`- 结论:**${decision.decision}**`)
  lines.push(`- 需求:${decision.requirementId}`)
  lines.push(`- 产品基线:${String(manifest.baselines && (manifest.baselines as Record<string, unknown>).product)}`)
  lines.push(`- 平台基线:${String(manifest.baselines && (manifest.baselines as Record<string, unknown>).platform)}`)
  lines.push(
    `- 固件哈希:${String(
      (manifest.baselines as Record<string, unknown>).firmwareSha256 || '(模拟层无真实固件)',
    )}`,
  )
  lines.push(`- 最高已验证层级:${String(manifest.highestVerifiedLevel)}`)
  lines.push(`- 生成时间:${decision.decidedAt}`)
  lines.push('')
  lines.push('## 覆盖汇总')
  lines.push('')
  lines.push(`| 必选用例 | 通过 | 失败 | 资源阻塞 | 无效 | 偏差 | 未执行 |`)
  lines.push(`|---|---|---|---|---|---|---|`)
  lines.push(
    `| ${decision.coverage.requiredCases} | ${decision.coverage.passed} | ${decision.coverage.failed} | ${decision.coverage.blocked} | ${decision.coverage.invalid} | ${decision.coverage.waived} | ${decision.coverage.notRun} |`,
  )
  lines.push('')
  lines.push('## 判定理由')
  lines.push('')
  for (const reason of decision.reasons.length > 0 ? decision.reasons : ['全部必选用例通过']) {
    lines.push(`- ${reason}`)
  }
  lines.push('')
  lines.push('## 用例明细')
  lines.push('')
  lines.push('| 用例 | 层级 | 最近结果 | 运行次数 |')
  lines.push('|---|---|---|---|')
  for (const run of runs) {
    const testCase = cases.find(item => item.id === run.caseId)
    lines.push(`| ${run.caseId} ${testCase ? testCase.title : ''} | ${run.level} | ${run.result} | 1 |`)
  }
  lines.push('')
  lines.push('> 本报告由工作台自动生成;模拟闭环不宣称整机验收(方案 19.4)。')
  lines.push('')
  return lines.join('\n')
}

/** 汇总用例与运行记录供报告(供外部复用) */
export function acceptanceCaseInputs(store: WorkbenchStore, requirementId: string): { cases: TestCaseRow[]; runs: RunRowLike[] } {
  const cases = listTestCases(store, { requirementRef: requirementId })
  const runs = listTestRuns(store).filter(run => cases.some(testCase => testCase.id === run.caseId)) as RunRowLike[]
  return { cases, runs }
}
