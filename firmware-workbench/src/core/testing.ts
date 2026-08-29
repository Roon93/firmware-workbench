import type { TestLevel, TestResult, TestRunRecord } from '../types.js'
import type { WorkbenchStore } from './store.js'

/**
 * 测试执行与结果分类(方案 11.4):
 * 产品断言失败不自动重试到通过;只有基础设施类失败允许按策略有限重试。
 */

export interface TestCaseRow {
  id: string
  title: string
  level: TestLevel
  requirementRefs: string[]
  acceptanceRefs: string[]
  preconditions: string[]
  steps: Array<Record<string, string>>
  resources: Array<{ id: string; mode?: string; units?: number; action?: string }>
  cleanup: string[]
  evidence: string[]
}

function rowToCase(row: Record<string, unknown>): TestCaseRow {
  return {
    id: row.id as string,
    title: row.title as string,
    level: row.level as TestLevel,
    requirementRefs: JSON.parse(row.requirement_refs as string),
    acceptanceRefs: JSON.parse(row.acceptance_refs as string),
    preconditions: JSON.parse(row.preconditions as string),
    steps: JSON.parse(row.steps as string),
    resources: JSON.parse(row.resources as string),
    cleanup: JSON.parse(row.cleanup as string),
    evidence: JSON.parse(row.evidence as string),
  }
}

export function insertTestCase(store: WorkbenchStore, testCase: TestCaseRow): void {
  store.db
    .prepare(
      `INSERT INTO test_cases (id, title, level, requirement_refs, acceptance_refs, preconditions, steps, resources, cleanup, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, level = excluded.level,
         requirement_refs = excluded.requirement_refs, acceptance_refs = excluded.acceptance_refs,
         preconditions = excluded.preconditions, steps = excluded.steps, resources = excluded.resources,
         cleanup = excluded.cleanup, evidence = excluded.evidence`,
    )
    .run(
      testCase.id,
      testCase.title,
      testCase.level,
      JSON.stringify(testCase.requirementRefs),
      JSON.stringify(testCase.acceptanceRefs),
      JSON.stringify(testCase.preconditions),
      JSON.stringify(testCase.steps),
      JSON.stringify(testCase.resources),
      JSON.stringify(testCase.cleanup),
      JSON.stringify(testCase.evidence),
    )
}

export function listTestCases(store: WorkbenchStore, filter?: { requirementRef?: string; maxLevel?: TestLevel }): TestCaseRow[] {
  const rows = store.db.prepare('SELECT * FROM test_cases ORDER BY id').all() as Array<Record<string, unknown>>
  const all = rows.map(rowToCase)
  return all.filter(testCase => {
    if (filter?.requirementRef && !testCase.requirementRefs.includes(filter.requirementRef)) return false
    if (filter?.maxLevel && levelRank(testCase.level) > levelRank(filter.maxLevel)) return false
    return true
  })
}

export function getTestCase(store: WorkbenchStore, id: string): TestCaseRow | undefined {
  const row = store.db.prepare('SELECT * FROM test_cases WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToCase(row) : undefined
}

const LEVEL_ORDER: TestLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']
export function levelRank(level: TestLevel): number {
  return LEVEL_ORDER.indexOf(level)
}

export interface RecordRunInput {
  caseId: string
  result: TestResult
  message?: string
  taskId?: string
  firmwareSha?: string
  evidenceId?: string
  actor?: string
}

/** 记录一次测试运行;BLOCKED_RESOURCE 不算失败,保持排队语义(方案 11.4) */
export function recordTestRun(store: WorkbenchStore, input: RecordRunInput): TestRunRecord {
  const testCase = getTestCase(store, input.caseId)
  if (!testCase) throw new Error(`测试用例不存在: ${input.caseId}`)

  const now = store.now()
  const seq = Number(store.getMeta('testrun.seq') ?? '0') + 1
  store.setMeta('testrun.seq', String(seq))
  const runId = `RUN-${now.slice(0, 10).replaceAll('-', '')}-${String(seq).padStart(3, '0')}`

  store.db
    .prepare(
      `INSERT INTO test_runs (id, case_id, task_id, level, firmware_sha, result, message, evidence_id, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      input.caseId,
      input.taskId ?? null,
      testCase.level,
      input.firmwareSha ?? null,
      input.result,
      input.message ?? null,
      input.evidenceId ?? null,
      now,
      now,
    )
  store.appendEvent(input.actor ?? 'tester', 'test.record', {
    runId,
    caseId: input.caseId,
    result: input.result,
  })

  return {
    id: runId,
    caseId: input.caseId,
    taskId: input.taskId,
    level: testCase.level,
    firmwareSha: input.firmwareSha,
    result: input.result,
    message: input.message,
    evidenceId: input.evidenceId,
    startedAt: now,
    finishedAt: now,
  }
}

export interface TestCaseSummary {
  caseId: string
  title: string
  level: TestLevel
  acceptanceRefs: string[]
  required: boolean
  runs: number
  latest?: TestResult
}

/** 需求验收的用例覆盖汇总:每个 AC 至少一条 PASS(方案 12.5) */
export function summarizeCoverage(store: WorkbenchStore, requirementRef: string): TestCaseSummary[] {
  const cases = listTestCases(store, { requirementRef })
  const allRuns = store.db.prepare('SELECT * FROM test_runs ORDER BY started_at').all() as Array<
    Record<string, unknown>
  >
  return cases.map(testCase => {
    const runs = allRuns.filter(row => row.case_id === testCase.id)
    const latest = runs.length > 0 ? (runs[runs.length - 1]!.result as TestResult) : undefined
    return {
      caseId: testCase.id,
      title: testCase.title,
      level: testCase.level,
      acceptanceRefs: testCase.acceptanceRefs,
      required: testCase.acceptanceRefs.length > 0,
      runs: runs.length,
      latest,
    }
  })
}

/** 生成 JUnit XML(方案 13.1 results/junit.xml),供证据包与 CI 使用 */
export function buildJunitXml(runs: TestRunRecord[], caseTitles: Map<string, string>): string {
  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const failures = runs.filter(run => run.result === 'PRODUCT_FAIL' || run.result === 'TEST_FAIL').length
  const errors = runs.filter(run => run.result === 'INFRA_FAIL').length
  const skipped = runs.filter(run => run.result === 'BLOCKED_RESOURCE' || run.result === 'INVALID').length

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<testsuite name="firmware-workbench" tests="${runs.length}" failures="${failures}" errors="${errors}" skipped="${skipped}">`,
  )
  for (const run of runs) {
    const name = caseTitles.get(run.caseId) ?? run.caseId
    const resultTag =
      run.result === 'PASS'
        ? ''
        : run.result === 'BLOCKED_RESOURCE' || run.result === 'INVALID'
          ? `<skipped message="${escape(run.message ?? run.result)}"/>`
          : `<failure message="${escape(run.result)}" type="${escape(run.result)}">${escape(run.message ?? '')}</failure>`
    lines.push(
      `  <testcase classname="${escape(run.caseId)}" name="${escape(name)}" time="0">${resultTag}</testcase>`,
    )
  }
  lines.push('</testsuite>')
  return lines.join('\n')
}
