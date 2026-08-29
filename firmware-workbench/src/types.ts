/**
 * 领域类型定义 —— 对应总体方案第 8/9/11/12/15 章。
 * 任务、依赖、资源、租约、测试与验收的统一词汇表。
 */

// ---------- 任务(方案 8.1/8.2/8.5) ----------

export type TaskType =
  | 'decision'
  | 'define'
  | 'spike'
  | 'contract'
  | 'design'
  | 'implementation'
  | 'self-test'
  | 'independent-verification'
  | 'integration'
  | 'acceptance'
  | 'human'
  | 'maintenance'

export type TaskStatus =
  | 'draft'
  | 'planned'
  | 'blocked_dependency'
  | 'blocked_gate'
  | 'blocked_resource'
  | 'ready'
  | 'reserved'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed_product'
  | 'failed_test'
  | 'failed_infra'
  | 'invalid'
  | 'cancelled'
  | 'quarantined'

/** 终态:不再参与调度 */
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed_product',
  'failed_test',
  'failed_infra',
  'invalid',
  'cancelled',
  'quarantined',
]

/** 失败三分类:产品缺陷、测试问题、基础设施问题(方案 8.5/11.4) */
export type TaskFailureClass = 'product' | 'test' | 'infra'

// ---------- 依赖(方案 8.3) ----------

export type DependencyKind =
  | 'hard_after'
  | 'artifact_requires'
  | 'contract_requires'
  | 'gate_requires'
  | 'data_requires'
  | 'soft_after'

export interface Dependency {
  kind: DependencyKind
  /** hard_after/soft_after: 前置任务 id;artifact_requires: 产物名;contract_requires: 契约名@版本;gate_requires: 门禁 id;data_requires: 数据标识 */
  ref: string
}

// ---------- 资源与租约(方案 9.2/9.3) ----------

export type ResourceKind =
  | 'build'           // build/rk3588 构建容器(容量型)
  | 'simulator'       // sim/scanner、sim/engine(容量型)
  | 'device'          // device/printer-01 真实整机(独占)
  | 'serial'          // device/printer-01/serial(共享读/独占写)
  | 'vnc-view'        // 显示(共享读)
  | 'vnc-input'       // 输入(独占)
  | 'subsystem'       // device/printer-01/scanner、/engine(独占)
  | 'fixture'         // fixture/power-relay-01 工装(独占)
  | 'instrument'      // instrument/image-meter 仪器(独占/预约)
  | 'consumable'      // consumable/a4-paper(库存)
  | 'human'           // human/operator(人工任务)

export type LockMode = 'exclusive' | 'shared-read' | 'capacity'

export type ResourceState =
  | 'discovered'
  | 'healthchecking'
  | 'available'
  | 'reserved'
  | 'busy'
  | 'cleaning'
  | 'quarantined'
  | 'maintenance'

export interface ResourceSpec {
  id: string
  kind: ResourceKind
  mode: LockMode
  /** capacity 模式的并发单元数;其他模式为 1 */
  units: number
  description?: string
}

export interface Resource extends ResourceSpec {
  state: ResourceState
  health: 'unknown' | 'healthy' | 'unhealthy'
  busyUnits: number
  quarantineReason?: string
  currentFirmware?: string
}

export interface LeaseRequirement {
  id: string
  mode?: LockMode
  units?: number
  /** 人工资源要求的具体动作,如 load-a4-paper */
  action?: string
}

export interface Lease {
  id: string
  resourceId: string
  taskId: string
  owner: string
  purpose: string
  mode: LockMode
  units: number
  state: 'active' | 'released' | 'expired'
  acquiredAt: string
  expiresAt: string
  heartbeatAt: string
}

// ---------- 需求与验收(方案 12.2/15.1,附录 C) ----------

export type RequirementKind = 'source' | 'atomic'

export interface Requirement {
  id: string
  kind: RequirementKind
  title: string
  originalText?: string
  /** Define 主体(附录 C 模板),JSON 序列化存储 */
  definition?: DefineDocument
  status: 'imported' | 'defined' | 'approved' | 'changed'
  priority: 'high' | 'medium' | 'low'
  createdAt: string
  updatedAt: string
}

export interface AcceptanceCriterion {
  id: string
  requirementId: string
  title: string
  /** 测量方法:manual / automated / instrument */
  method: 'manual' | 'automated' | 'instrument'
  threshold?: string
  /** 允许的最高验证层级(方案 11.1):L0-L5 */
  maxLevel: TestLevel
  status: 'draft' | 'approved'
}

export interface DefineDocument {
  actors?: string[]
  preconditions?: string[]
  normalFlow?: string[]
  alternativeFlows?: string[]
  errorFlows?: string[]
  recoveryRules?: string[]
  functionalRequirements?: string[]
  nonFunctionalRequirements?: {
    performance?: string[]
    resource?: string[]
    reliability?: string[]
    security?: string[]
    maintainability?: string[]
  }
  outOfScope?: string[]
  dependencies?: string[]
  openQuestions?: string[]
  risks?: string[]
}

// ---------- 接口契约(方案 4.3/15.1) ----------

export interface InterfaceContract {
  id: string
  name: string
  version: string
  status: 'draft' | 'frozen'
  body: unknown
  frozenAt?: string
  createdAt: string
}

// ---------- 门禁(方案 7.2) ----------

export interface GateDecision {
  id: string
  scope: string
  decision: 'approved' | 'rejected' | 'pending'
  signer?: string
  decidedAt?: string
  conditions?: string[]
}

// ---------- 测试(方案 11.1/11.4) ----------

export type TestLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'

export type TestResult =
  | 'PASS'
  | 'PRODUCT_FAIL'
  | 'TEST_FAIL'
  | 'INFRA_FAIL'
  | 'BLOCKED_RESOURCE'
  | 'INVALID'
  | 'FLAKY'
  | 'WAIVED'

export interface TestCase {
  id: string
  title: string
  level: TestLevel
  requirementRefs: string[]
  acceptanceRefs: string[]
  preconditions: string[]
  steps: TestCaseStep[]
  resources: LeaseRequirement[]
  cleanup: string[]
  evidence: string[]
}

export interface TestCaseStep {
  action?: string
  expect?: string
  human?: string
}

export interface TestRunRecord {
  id: string
  caseId: string
  taskId?: string
  level: TestLevel
  firmwareSha?: string
  result: TestResult
  message?: string
  evidenceId?: string
  startedAt: string
  finishedAt: string
}

// ---------- 证据(方案 13.1/13.2) ----------

export interface EvidenceRecord {
  id: string
  kind: 'file' | 'bundle'
  name: string
  sha256: string
  path: string
  bytes: number
  refs: Record<string, string>
  createdAt: string
  /** bundle 的组成部分清单 */
  entries?: Array<{ path: string; sha256: string; bytes: number }>
}

// ---------- 任务定义(创建入口) ----------

/**
 * 动作规格:字符串 = shell 命令;结构化对象 = 内建执行器。
 * { simScenario } 由虚拟设备执行单场景;{ simSuite } 执行场景套件(异常恢复组);
 * { humanAction } 为人工任务;{ evaluateAcceptance } 触发验收评估。
 */
export type ActionSpec =
  | string
  | { simScenario?: string; simSuite?: string; humanAction?: string; evaluateAcceptance?: boolean; note?: string }

export interface TaskDefinition {
  id?: string
  type: TaskType
  title: string
  requirementRefs?: string[]
  acceptanceRefs?: string[]
  dependencies?: Dependency[]
  inputs?: string[]
  outputs?: string[]
  resources?: LeaseRequirement[]
  /** 动作命令:set up / execute / verify / cleanup */
  actions?: { setup?: ActionSpec; execute?: ActionSpec; verify?: ActionSpec; cleanup?: ActionSpec }
  /** 执行策略 */
  policy?: { timeoutMinutes?: number; retryInfraOnly?: boolean; maxAttempts?: number }
  evidence?: string[]
  owner?: string
  estimateMinutes?: number
  /** 调度优先级(方案 8.6):发布阻塞/安全缺陷为 high */
  priority?: 'high' | 'medium' | 'low'
  note?: string
}

export interface Task extends TaskDefinition {
  id: string
  status: TaskStatus
  blockedReason?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  attempts: number
  lastResult?: TaskFailureClass
}
