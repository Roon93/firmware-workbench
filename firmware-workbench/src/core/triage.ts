import type { WorkbenchStore } from './store.js'
import { changeItem, listItems } from './align.js'

/**
 * 推进层(工作流提案 v2.2 §3.2/§8 G1/G3):
 * 失败归因四分类(product/test/infra/spec —— spec 类回流需求变更),
 * 缺陷工作流(open→fixing→fixed→verified→closed,severity+waiver),
 * critical 缺陷阻塞验收门禁,AI triager 归因建议(DSH headless)。
 */

export type Attribution = 'product' | 'test' | 'infra' | 'spec'
export type DefectStatus = 'open' | 'fixing' | 'fixed' | 'verified' | 'closed' | 'waived'
export type Severity = 'critical' | 'major' | 'minor'

export interface Defect {
  id: string
  title: string
  severity: Severity
  status: DefectStatus
  requirementId?: string
  sourceCase?: string
  failureRun?: string
  attribution?: Attribution
  rootCause?: string
  assignee?: string
  waiverUntil?: string
  waiverReason?: string
  createdAt: string
  updatedAt: string
}

function parse<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text)) as T
  } catch {
    return fallback
  }
}

function rowToDefect(row: Record<string, unknown>): Defect {
  return {
    id: row.id as string,
    title: row.title as string,
    severity: row.severity as Severity,
    status: row.status as DefectStatus,
    requirementId: (row.requirement_id as string) ?? undefined,
    sourceCase: (row.source_case as string) ?? undefined,
    failureRun: (row.failure_run as string) ?? undefined,
    attribution: (row.attribution as Attribution) ?? undefined,
    rootCause: (row.root_cause as string) ?? undefined,
    assignee: (row.assignee as string) ?? undefined,
    waiverUntil: (row.waiver_until as string) ?? undefined,
    waiverReason: (row.waiver_reason as string) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export function listDefects(store: WorkbenchStore, filter?: { status?: string[]; requirementId?: string }): Defect[] {
  const conditions: string[] = []
  const params: Array<string> = []
  if (filter?.status && filter.status.length > 0) {
    conditions.push(`status IN (${filter.status.map(() => '?').join(',')})`)
    params.push(...filter.status)
  }
  if (filter?.requirementId) {
    conditions.push('requirement_id = ?')
    params.push(filter.requirementId)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = store.db
    .prepare(`SELECT * FROM defects ${where} ORDER BY created_at DESC`)
    .all(...params) as Array<Record<string, unknown>>
  return rows.map(rowToDefect)
}

export function getDefect(store: WorkbenchStore, id: string): Defect | undefined {
  const row = store.db.prepare('SELECT * FROM defects WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToDefect(row) : undefined
}

/**
 * 归因确认(方案 11.4 四分类 + G1 spec 回流):
 * product → 建 critical/major 缺陷;spec → 回流为需求变更(test-finding);
 * test → 用例标 FLAKY 语义(事件留痕);infra → 事件留痕待基础设施处理。
 */
export function confirmAttribution(
  store: WorkbenchStore,
  input: {
    caseId: string
    runId?: string
    attribution: Attribution
    note: string
    severity?: Severity
    actor?: string
  },
): { defect?: Defect; changeId?: number; message: string } {
  const actor = input.actor ?? 'web'
  const caseRow = store.db.prepare('SELECT title, requirement_refs FROM test_cases WHERE id = ?').get(input.caseId) as
    | { title: string; requirement_refs: string }
    | undefined
  const caseTitle = caseRow?.title ?? input.caseId
  const requirementId = parse<string[]>(caseRow?.requirement_refs ?? '[]', [])[0]

  if (input.attribution === 'product') {
    const defect = createDefect(
      store,
      {
        title: `${input.caseId} ${caseTitle}:归因 product`,
        severity: input.severity ?? 'major',
        requirementId,
        sourceCase: input.caseId,
        failureRun: input.runId,
        attribution: 'product',
        rootCause: input.note,
        actor,
      },
    )
    return { defect, message: `缺陷 ${defect.id} 已创建${defect.severity === 'critical' ? ',验收门禁已阻塞' : ''}` }
  }
  if (input.attribution === 'spec') {
    if (!requirementId) return { message: 'spec 归因但用例未关联需求,仅记录' }
    const items = listItems(store, requirementId)
    if (items.length === 0) return { message: 'spec 归因但需求无条目,仅记录' }
    const outcome = changeItem(
      store,
      {
        itemId: items[0]!.id,
        source: 'test-finding',
        summary: `spec 修正(来自 ${input.caseId} 失败):${input.note}`,
        detail: `归因 spec:验收标准/需求本身与实现认知不一致,失败证据见 run ${input.runId ?? ''}`,
      },
      actor,
    )
    return { changeId: outcome.changeId, message: `已回流为需求变更(条目 ${items[0]!.id} 标 changed,下游 ${outcome.staleTasks.length} 个任务打回)` }
  }
  // test / infra:事件留痕
  store.appendEvent(actor, `triage.${input.attribution}`, {
    caseId: input.caseId,
    runId: input.runId,
    note: input.note,
    sourceRefs: [`case:${input.caseId}`, `run:${input.runId ?? ''}`],
  })
  return {
    message:
      input.attribution === 'test'
        ? '归因 test:用例问题,不计产品失败;建议隔离或修复用例'
        : '归因 infra:环境/基础设施问题,处理后按策略重跑',
  }
}

export function createDefect(
  store: WorkbenchStore,
  input: {
    title: string
    severity: Severity
    requirementId?: string
    sourceCase?: string
    failureRun?: string
    attribution?: Attribution
    rootCause?: string
    actor?: string
  },
): Defect {
  const now = store.now()
  const seq = Number(store.getMeta('defect.seq') ?? '0') + 1
  store.setMeta('defect.seq', String(seq))
  const id = `DEFECT-${String(seq).padStart(4, '0')}`
  store.db
    .prepare(
      `INSERT INTO defects (id, title, severity, status, requirement_id, source_case, failure_run, attribution, root_cause, source_refs, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      input.severity,
      input.requirementId ?? null,
      input.sourceCase ?? null,
      input.failureRun ?? null,
      input.attribution ?? null,
      input.rootCause ?? null,
      JSON.stringify([input.sourceCase, input.failureRun].filter(Boolean).map(ref => `run-or-case:${ref}`)),
      now,
      now,
    )
  store.appendEvent(input.actor ?? 'web', 'defect.create', { id, severity: input.severity, sourceRefs: [`case:${input.sourceCase ?? ''}`] })
  return getDefect(store, id) as Defect
}

const STATUS_FLOW: Record<DefectStatus, DefectStatus[]> = {
  open: ['fixing', 'waived', 'closed'],
  fixing: ['fixed', 'open', 'closed'],
  fixed: ['verified', 'fixing'],
  verified: ['closed'],
  closed: [],
  waived: ['open'], // waiver 到期自动回开(G3)
}

export function transitionDefect(
  store: WorkbenchStore,
  input: { id: string; status: DefectStatus; note?: string; actor?: string },
): Defect {
  const defect = getDefect(store, input.id)
  if (!defect) throw new Error(`缺陷不存在: ${input.id}`)
  if (!STATUS_FLOW[defect.status].includes(input.status)) {
    throw new Error(`非法缺陷状态迁移: ${defect.status} -> ${input.status}`)
  }
  if (input.status === 'verified') {
    // verified 要求关联用例最近一次运行 PASS(证据优先,方案 4.7)
    const caseId = defect.sourceCase
    if (caseId) {
      const lastRun = store.db
        .prepare('SELECT result FROM test_runs WHERE case_id = ? ORDER BY started_at DESC LIMIT 1')
        .get(caseId) as { result: string } | undefined
      if (!lastRun || lastRun.result !== 'PASS') {
        throw new Error(`缺陷 ${input.id} 不能 verified:用例 ${caseId} 最近一次运行不是 PASS(先回归)`)
      }
    }
  }
  store.db
    .prepare('UPDATE defects SET status = ?, updated_at = ? WHERE id = ?')
    .run(input.status, store.now(), input.id)
  store.appendEvent(input.actor ?? 'web', 'defect.status', {
    id: input.id,
    from: defect.status,
    to: input.status,
    note: input.note,
    sourceRefs: [`defect:${input.id}`],
  })
  return getDefect(store, input.id) as Defect
}

/** waiver 批准(minor/major 可走;critical 不允许,方案 G3) */
export function proposeWaiver(
  store: WorkbenchStore,
  input: { id: string; until: string; reason: string; approver: string },
): Defect {
  const defect = getDefect(store, input.id)
  if (!defect) throw new Error(`缺陷不存在: ${input.id}`)
  if (defect.severity === 'critical') throw new Error('critical 缺陷不允许 waiver,必须修复')
  store.db
    .prepare("UPDATE defects SET status = 'waived', waiver_until = ?, waiver_reason = ?, updated_at = ? WHERE id = ?")
    .run(input.until, input.reason, store.now(), input.id)
  store.appendEvent(input.approver, 'defect.waiver', {
    id: input.id,
    until: input.until,
    reason: input.reason,
    sourceRefs: [`defect:${input.id}`],
  })
  return getDefect(store, input.id) as Defect
}

/** waiver 到期回开(车道提醒) */
export function sweepWaivers(store: WorkbenchStore): string[] {
  const now = store.now()
  const rows = store.db
    .prepare("SELECT id FROM defects WHERE status = 'waived' AND waiver_until IS NOT NULL AND waiver_until < ?")
    .all(now) as Array<{ id: string }>
  for (const row of rows) {
    store.db.prepare("UPDATE defects SET status = 'open', updated_at = ? WHERE id = ?").run(now, row.id)
    store.appendEvent('system', 'defect.waiver_expired', { id: row.id, sourceRefs: [`defect:${row.id}`] })
  }
  return rows.map(row => row.id)
}

/** 验收门禁挂载:需求下存在 open/fixing 的 critical 缺陷 → 验收必须 BLOCKED(方案 12.5) */
export function blockingDefects(store: WorkbenchStore, requirementId: string): Defect[] {
  return listDefects(store, { requirementId }).filter(
    defect => defect.severity === 'critical' && ['open', 'fixing'].includes(defect.status),
  )
}

// ---------- AI triager(DSH headless 归因建议) ----------

export interface TriageSuggestion {
  attribution: Attribution
  confidence: 'high' | 'medium' | 'low'
  rationale: string
}

export async function aiTriageSuggest(
  store: WorkbenchStore,
  input: { caseId: string; failureMessage: string },
): Promise<{ ok: boolean; suggestion?: TriageSuggestion; error?: string; raw?: string }> {
  const caseRow = store.db.prepare('SELECT title, steps FROM test_cases WHERE id = ?').get(input.caseId) as
    | { title: string; steps: string }
    | undefined
  const history = store.db
    .prepare('SELECT id, title, attribution, root_cause FROM defects ORDER BY created_at DESC LIMIT 5')
    .all() as Array<{ id: string; title: string; attribution: string; root_cause: string }>

  const contextPack = [
    '你是打印机固件的测试失败归因专家。对下面的测试失败给出归因建议。',
    '归因四分类:product(产品代码缺陷)/ test(用例或脚本问题)/ infra(环境与基础设施)/ spec(验收标准或需求本身有误)。',
    '',
    `【失败用例】${input.caseId} ${caseRow?.title ?? ''}`,
    `【失败信息】${input.failureMessage}`,
    history.length > 0
      ? `【历史缺陷参考】\n${history.map(defect => `- ${defect.id}(${defect.attribution}):${defect.root_cause ?? defect.title}`).join('\n')}`
      : '【历史缺陷参考】暂无',
    '',
    '【输出要求】只输出 JSON:{"attribution":"product|test|infra|spec","confidence":"high|medium|low","rationale":"判断理由(引用证据)"}',
  ].join('\n')

  const { runHeadless, extractJson } = await import('./ai-orchestrator.js')
  const result = await runHeadless(store, contextPack)
  if (!result.ok) return { ok: false, error: result.error, raw: result.raw }
  const suggestion = extractJson<TriageSuggestion>(result.output ?? '')
  if (!suggestion || !['product', 'test', 'infra', 'spec'].includes(suggestion.attribution)) {
    return { ok: false, error: '模型输出无法解析为归因建议(原文见 raw)', raw: result.output }
  }
  return { ok: true, suggestion }
}
