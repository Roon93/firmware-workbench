/** 全站数据模型与轮询调度(设计文档 §3.3 / §9.3)。视图组件只读本 context。 */

import { createContext, useContext, useEffect, useRef, useState } from 'react'

export const ROUTE_PREFIX = '/_dsh/dsh-firmware-workbench'

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const value = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

// ---------- 类型 ----------

export interface TaskView {
  id: string
  type: string
  title: string
  status: string
  blockedReason?: string
  staleReason?: string
  requirementRefs: string[]
  acceptanceRefs: string[]
  dependencies: Array<{ kind: string; ref: string }>
  inputs: string[]
  outputs: string[]
  resources: Array<{ id: string; mode?: string; units?: number; action?: string }>
  actions: Record<string, unknown>
  policy: Record<string, unknown>
  estimateMinutes?: number
  note?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  attempts: number
}

export interface RequirementView {
  id: string
  kind: string
  title: string
  originalText?: string
  status: string
  priority: string
  dependsOn?: string
  openQuestions?: number
  itemCount?: number
  questions?: ClarifyQuestionView[]
  items?: ItemView[]
  defines?: DefineVersionView[]
}

export interface ClarifyQuestionView {
  id: string
  requirementId: string
  question: string
  why?: string
  options: string[]
  status: 'open' | 'answered' | 'skipped'
  answer?: string
  origin: string
  createdAt: string
}

export interface ItemView {
  id: string
  requirementId: string
  seq: number
  content: string
  acceptance: Array<{ title: string; method: string; threshold?: string; maxLevel: string }>
  status: string
  origin?: string
  version: number
}

export interface DefineVersionView {
  id: string
  requirementId: string
  version: number
  body: Record<string, unknown>
  status: 'draft' | 'in-review' | 'approved' | 'rejected' | 'superseded'
  submittedAt?: string
  decidedAt?: string
}

export interface LaneSummary {
  openQuestions: Array<{ id: string; requirementId: string; question: string }>
  definesInReview: Array<{ id: string; requirementId: string; version: number }>
  changedRequirements: Array<{ id: string; title: string }>
  staleTasks: Array<{ id: string; title: string; staleReason?: string }>
  openDefects?: DefectView[]
  waived?: DefectView[]
}

export interface DefectView {
  id: string
  title: string
  severity: 'critical' | 'major' | 'minor'
  status: string
  requirementId?: string
  sourceCase?: string
  rootCause?: string
  waiverUntil?: string
  waiverReason?: string
  createdAt: string
  updatedAt: string
}

export interface Snapshot {
  now: string
  requirements?: RequirementView[]
  acceptance?: { acceptanceId: string; decision: string; decidedAt: string } | null
  gates?: Array<{ id: string; decision: string }>
  lane?: LaneSummary
  tasks: { total: number; byStatus: Record<string, number>; blocked: Array<{ id: string; status: string; reason: string }> }
  ready: Array<{ id: string; title: string; score: number; onCriticalPath: boolean }>
  criticalPath: { ids: string[]; totalMinutes: number }
  resources: { total: number; quarantined: string[]; busy: number }
  activeLeases: number
}

export interface ResourceView {
  id: string
  kind: string
  mode: string
  units: number
  description?: string
  state: string
  health: string
  busyUnits: number
  quarantineReason?: string
  currentFirmware?: string
}

export interface LeaseView {
  id: string
  resourceId: string
  taskId: string
  owner: string
  purpose: string
  mode: string
  units: number
  state: string
  acquiredAt: string
  expiresAt: string
}

export interface EventView {
  id: number
  ts: string
  actor: string
  kind: string
  payload: Record<string, unknown>
}

export interface CaseView {
  id: string
  title: string
  level: string
  requirementRefs: string[]
  acceptanceRefs: string[]
  preconditions: string[]
  steps: Array<{ action?: string; expect?: string; human?: string }>
  resources: Array<{ id: string; mode?: string; units?: number; action?: string }>
  cleanup: string[]
  evidence: string[]
}

export interface RunRecord {
  id: string
  caseId: string
  taskId?: string
  level: string
  result: string
  message?: string
  startedAt: string
  finishedAt: string
}

export interface DemoPhase {
  id: string
  title: string
  narrative: string
  action?: string
  verify?: string
  status: 'pending' | 'active' | 'done'
  startedAt?: string
  finishedAt?: string
}

export interface DemoLogLine {
  ts: string
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface DemoState {
  runId?: string
  mode: 'auto' | 'step'
  status: 'idle' | 'running' | 'awaiting_next' | 'done'
  speedMs: number
  phaseIndex: number
  phases: DemoPhase[]
  logCursor: number
  log: DemoLogLine[]
  startedAt?: string
  finishedAt?: string
}

export interface SimEvent {
  ts: string
  jobId: string
  kind: string
  detail?: string
}

export interface SimState {
  device: { state: string; paperCount: number; paperCapacity: number; error?: string }
  job: {
    jobId: string
    scenario: string
    state: string
    finished: boolean
    pass?: boolean
    message?: string
    events: SimEvent[]
    startedAt: string
  } | null
}

export interface LatestReport {
  acceptanceId: string
  requirementId: string
  decision: string
  decidedAt: string
  coverage: { requiredCases: number; passed: number; failed: number; blocked: number; invalid: number; waived: number; notRun: number }
  reasons: string[]
  highestVerifiedLevel: string
  baselines: Record<string, string>
  bundle: { id: string; dir: string; files: Array<{ path: string; bytes: number }> }
  markdown: string
}

export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  planned: '已规划',
  blocked_dependency: '等待依赖',
  blocked_gate: '等待门禁',
  blocked_resource: '等待资源',
  ready: '可运行',
  reserved: '已预约',
  running: '运行中',
  verifying: '验证中',
  succeeded: '已完成',
  failed_product: '产品失败',
  failed_test: '测试失败',
  failed_infra: '基础设施失败',
  invalid: '无效',
  cancelled: '已取消',
  quarantined: '已隔离',
  available: '可用',
  reserved_state: '已预约',
  busy: '占用',
  maintenance: '维护中',
  PASS: '通过',
  PRODUCT_FAIL: '产品失败',
  TEST_FAIL: '测试失败',
  INFRA_FAIL: '基础设施失败',
  BLOCKED_RESOURCE: '资源等待',
  INVALID: '无效',
  FLAKY: '不稳定',
  WAIVED: '偏差批准',
}

// ---------- 数据 hook ----------

export interface WbData {
  snapshot: Snapshot | null
  tasks: TaskView[]
  resources: ResourceView[]
  leases: LeaseView[]
  events: EventView[]
  cases: CaseView[]
  runs: RunRecord[]
  demo: DemoState | null
  sim: SimState | null
  report: LatestReport | null
  apiOk: boolean
  apiError: string | null
  refresh: () => Promise<void>
  refreshSim: () => Promise<void>
  reloadReport: () => Promise<void>
}

const WbContext = createContext<WbData>({
  snapshot: null,
  tasks: [],
  resources: [],
  leases: [],
  events: [],
  cases: [],
  runs: [],
  demo: null,
  sim: null,
  report: null,
  apiOk: false,
  apiError: null,
  refresh: async () => {},
  refreshSim: async () => {},
  reloadReport: async () => {},
})

export function useWb(): WbData {
  return useContext(WbContext)
}

export function useWorkbenchData(): WbData {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [resources, setResources] = useState<ResourceView[]>([])
  const [leases, setLeases] = useState<LeaseView[]>([])
  const [events, setEvents] = useState<EventView[]>([])
  const [cases, setCases] = useState<CaseView[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [demo, setDemo] = useState<DemoState | null>(null)
  const [sim, setSim] = useState<SimState | null>(null)
  const [report, setReport] = useState<LatestReport | null>(null)
  const [apiOk, setApiOk] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const cursorRef = useRef(0)
  const failRef = useRef(0)
  const simRef = useRef<SimState | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const [snap, taskList, res, caseList, demoState] = await Promise.all([
        fetchJson<Snapshot>('/snapshot'),
        fetchJson<TaskView[]>('/tasks'),
        fetchJson<{ resources: ResourceView[]; activeLeases: LeaseView[] }>('/resources'),
        fetchJson<CaseView[]>('/cases'),
        fetchJson<DemoState>('/demo/state'),
      ])
      setSnapshot(snap)
      setTasks(taskList)
      setResources(res.resources)
      setLeases(res.activeLeases)
      setCases(caseList)
      setDemo(demoState)
      setApiOk(true)
      setApiError(null)
      failRef.current = 0

      // 事件增量
      const feed = await fetchJson<{ events: EventView[]; cursor: number }>(`/events?after=${cursorRef.current}`)
      if (feed.events.length > 0 || cursorRef.current === 0) {
        setEvents(prev => {
          const merged = cursorRef.current === 0 ? feed.events : [...prev, ...feed.events]
          return merged.slice(-300)
        })
        cursorRef.current = feed.cursor
      }

      // sim:仅在有活跃作业或设备非空闲时高频拉取
      const busyJob = simRef.current?.job && !simRef.current.job.finished
      if (busyJob || demoState.status === 'running') {
        const simState = await fetchJson<SimState>('/sim/state')
        setSim(simState)
        simRef.current = simState
      }
    } catch (error) {
      failRef.current += 1
      setApiOk(false)
      setApiError(error instanceof Error ? error.message : String(error))
    }
  }

  const runsRef = useRef(0)

  const refreshSim = async (): Promise<void> => {
    try {
      const simState = await fetchJson<SimState>('/sim/state')
      setSim(simState)
      simRef.current = simState
    } catch {
      // 忽略瞬时错误,由主循环重试
    }
  }

  const reloadReport = async (): Promise<void> => {
    try {
      const latest = await fetchJson<LatestReport>('/report/latest')
      setReport(latest)
      const runList = await fetchJson<RunRecord[]>('/runs?limit=100')
      setRuns(runList)
      runsRef.current += 1
    } catch {
      setReport(null)
    }
  }

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const loop = async (): Promise<void> => {
      await refresh()
      void reloadReport()
      if (stopped) return
      // 最小间隔档位:演示运行或任务运行中 → 800ms;否则 4s(设计 §9.3)
      const active =
        (demo && (demo.status === 'running' || demo.status === 'awaiting_next')) ||
        tasks.some(task => ['running', 'verifying', 'reserved'].includes(task.status))
      const gap = active ? 800 : 4000
      timer = setTimeout(loop, gap)
    }
    void loop()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // eslint 依赖刻意收敛:轮询循环读取的是 ref 外的最新闭包,每次渲染重建循环代价高
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    snapshot,
    tasks,
    resources,
    leases,
    events,
    cases,
    runs,
    demo,
    sim,
    report,
    apiOk,
    apiError,
    refresh,
    refreshSim,
    reloadReport,
  }
}

export function WbProvider(props: { value: WbData; children: React.ReactNode }): React.JSX.Element {
  return <WbContext.Provider value={props.value}>{props.children}</WbContext.Provider>
}

export function timeShort(iso: string | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}
