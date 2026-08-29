import type { WorkbenchStore } from './core/store.js'
import { seedResources } from './core/resources.js'
import { Workbench } from './core/workbench.js'
import { applyDefine, approveRequirement, importRequirement } from './core/requirement.js'
import { createContract, freezeContract, setGateDecision } from './core/contract.js'
import { insertTestCase } from './core/testing.js'
import type { TestCaseRow } from './core/testing.js'

/**
 * 本机复印 MVP 种子(方案 8.7 示例 DAG / 19 章 MVP 纵向切片 / 附录 B 用例)。
 * 一条命令装载完整的需求、契约基线、任务 DAG、测试用例与资源目录,
 * 模拟闭环完成后真机任务停留在 BLOCKED_RESOURCE 队列。
 */

export const DEMO_REQUIREMENT_ID = 'REQ-COPY-0001'

const CONTRACTS: Array<{ name: string; version: string; summary: string }> = [
  { name: 'IF-JOB-MANAGER', version: 'v1', summary: '作业创建/取消/状态订阅;job_id 全链路透传' },
  { name: 'IF-SCANNER', version: 'v1', summary: '平板扫描:分辨率/尺寸/超时/错误码语义' },
  { name: 'IF-IMAGE-BUFFER', version: 'v1', summary: '页面缓冲:格式/行宽/压缩参数' },
  { name: 'IF-ENGINE', version: 'v1', summary: '引擎:预热/进纸/出纸/缺纸/卡纸/恢复语义' },
  { name: 'IF-PANEL-UI', version: 'v1', summary: '面板:状态一致性/错误引导/输入事件' },
]

/** 重放前清理:清空任务、租约、测试运行与产物,保留需求/契约/用例定义 */
export function resetDemoState(store: WorkbenchStore): void {
  store.db.exec(
    'DELETE FROM leases; DELETE FROM test_runs; DELETE FROM artifacts; DELETE FROM tasks; DELETE FROM gates;'
  )
  store.appendEvent('system', 'demo.reset', { note: '重放前清理任务、运行记录与门禁签署' })
}

export function seedDemo(
  store: WorkbenchStore,
  actor = 'demo-seed',
  opts: { reset?: boolean; autoGate?: boolean } = {},
): { requirementId: string; taskIds: string[] } {
  if (opts.reset) resetDemoState(store)
  seedResources(store)

  // ---------- 需求与 Define(方案 19.1) ----------
  const requirement = importRequirement(store, {
    id: DEMO_REQUIREMENT_ID,
    title: '面板发起单页黑白复印',
    originalText: '用户在设备面板选择"复印",放入一张 A4 原稿,设备以产品定义的分辨率完成扫描、图像处理,并由真实打印引擎输出一张黑白纸张。',
    priority: 'high',
    actor,
  })

  applyDefine(
    store,
    {
      requirementId: requirement.id,
      actor,
      define: {
        actors: ['local-user'],
        preconditions: ['device-ready', 'a4-paper-available', 'original-on-flatbed'],
        normalFlow: [
          '用户在面板选择复印',
          '设备进入 SCANNING 并完成 A4 平板 300dpi 扫描',
          '图像流水线完成校正与半色调',
          '引擎输出 1 页黑白 A4',
          '面板与作业状态显示 COMPLETED',
        ],
        alternativeFlows: ['用户在扫描前取消:作业 CANCELLED,设备回到就绪'],
        errorFlows: [
          '扫描超时:作业 FAILED,错误码 SCAN-TIMEOUT',
          '打印前缺纸:面板提示 PAPER_EMPTY,作业 WAITING_FOR_PAPER',
          '引擎可恢复错误:自动重试一次',
        ],
        recoveryRules: [
          '缺纸后补纸:作业继续输出并 COMPLETED',
          '缺纸未恢复:作业 FAILED,清理任务恢复资源健康',
          '取消后设备回到就绪,无残留作业',
        ],
        functionalRequirements: ['单页黑白复印闭环', '作业状态与面板一致', '取消即时生效'],
        nonFunctionalRequirements: {
          performance: ['(待产品负责人签署:首张时间目标)'],
          resource: ['(待签署:CPU/内存预算)'],
          reliability: ['异常后设备必须回到已知状态'],
          security: ['无外部网络依赖'],
          maintainability: ['作业全链路携带同一 job_id'],
        },
        outOfScope: ['pc-driver-development'],
        dependencies: ['scanner-interface', 'image-pipeline', 'print-engine-interface', 'panel-ui'],
        openQuestions: [],
        risks: ['真实扫描器/引擎接口未冻结(Phase 0 事实)'],
      },
      criteria: [
        {
          title: '模拟层:虚拟设备完成单页黑白复印',
          method: 'automated',
          threshold: '虚拟设备终态 COMPLETED 且出纸 1 页',
          maxLevel: 'L1',
        },
        {
          title: '模拟层:必选异常场景符合作业状态机(取消/超时/缺纸恢复)',
          method: 'automated',
          threshold: '全部场景终态与转移表预期一致',
          maxLevel: 'L1',
        },
        {
          title: '真机:面板发起真实扫描并真实出纸 1 页',
          method: 'manual',
          threshold: '真实纸张输出且作业时间线完整',
          maxLevel: 'L4',
        },
      ],
    },
  )
  // ---------- 门禁与契约:引导模式下由用户逐步签署(方案 7.2 阶段门禁) ----------
  if (opts.autoGate) {
    approveDefineGate(store, actor)
    freezeContractGate(store, actor)
  }

  // ---------- 任务 DAG(方案 8.7) ----------
  const workbench = new Workbench(store)
  const gate = [{ kind: 'gate_requires' as const, ref: 'G3-CONTRACT-BASELINE' }]
  const contractDeps = (names: string[]) => [
    { kind: 'hard_after' as const, ref: 'TASK-COPY-0002' },
    ...names.map(name => ({ kind: 'contract_requires' as const, ref: `${name}@v1` })),
    ...gate,
  ]
  const simBuild = (component: string) =>
    `node ${cliEntrypoint()} sim component --name ${component}`

  const taskIds: string[] = []

  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0001',
        type: 'define',
        title: 'Define:澄清单页黑白复印需求与验收',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        acceptanceRefs: [],
        note: '已随种子完成(G1 定义完成)',
      },
      actor,
    ).id,
  )
  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0002',
        type: 'contract',
        title: '冻结状态机/接口/错误码契约 v1',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [{ kind: 'hard_after', ref: 'TASK-COPY-0001' }],
        note: '已随种子冻结(G3 契约基线)',
      },
      actor,
    ).id,
  )

  const workPackages: Array<{ id: string; title: string; contracts: string[]; output: string }> = [
    { id: 'TASK-COPY-0010', title: '面板 UI 工作包', contracts: ['IF-PANEL-UI', 'IF-JOB-MANAGER'], output: 'panel-ui' },
    { id: 'TASK-COPY-0011', title: '作业管理器工作包', contracts: ['IF-JOB-MANAGER'], output: 'job-manager' },
    { id: 'TASK-COPY-0012', title: '扫描适配器工作包', contracts: ['IF-SCANNER', 'IF-IMAGE-BUFFER'], output: 'scanner-adapter' },
    { id: 'TASK-COPY-0013', title: '图像流水线工作包', contracts: ['IF-IMAGE-BUFFER'], output: 'image-pipeline' },
    { id: 'TASK-COPY-0014', title: '引擎适配器工作包', contracts: ['IF-ENGINE', 'IF-IMAGE-BUFFER'], output: 'engine-adapter' },
  ]
  for (const pack of workPackages) {
    taskIds.push(
      workbench.createTask(
        {
          id: pack.id,
          type: 'implementation',
          title: pack.title,
          requirementRefs: [DEMO_REQUIREMENT_ID],
          dependencies: contractDeps(pack.contracts),
          outputs: [pack.output],
          resources: [{ id: 'build/rk3588', units: 1 }],
          actions: { execute: simBuild(pack.output) },
          policy: { timeoutMinutes: 5, retryInfraOnly: true, maxAttempts: 2 },
          estimateMinutes: 60,
          note: '模拟闭环:构建与自测为组件级模拟(L0)',
        },
        actor,
      ).id,
    )
  }

  // 每个工作包的自测(方案 8.8:实现任务自动关联自测)
  for (const pack of workPackages) {
    taskIds.push(
      workbench.createTask(
        {
          id: `${pack.id}-T`,
          type: 'self-test',
          title: `${pack.title} 自测(L1 契约/模型)`,
          requirementRefs: [DEMO_REQUIREMENT_ID],
          dependencies: [
            { kind: 'hard_after', ref: pack.id },
            { kind: 'artifact_requires', ref: pack.output },
          ],
          resources: [{ id: 'sim/scanner', units: 1 }, { id: 'sim/engine', units: 1 }],
          actions: { execute: simBuild(`${pack.output}-test`) },
          policy: { timeoutMinutes: 5 },
          estimateMinutes: 20,
        },
        actor,
      ).id,
    )
  }

  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0015',
        type: 'implementation',
        title: '验收自动化开发(按验收契约先行)',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [...contractDeps(['IF-JOB-MANAGER'])],
        outputs: ['acceptance-automation'],
        actions: { execute: simBuild('acceptance-automation') },
        estimateMinutes: 30,
      },
      actor,
    ).id,
  )

  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0030',
        type: 'integration',
        title: '模拟集成:虚拟设备单页复印主流程',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [
          ...workPackages.map(pack => ({ kind: 'hard_after' as const, ref: `${pack.id}-T` })),
          { kind: 'hard_after', ref: 'TASK-COPY-0015' },
          ...workPackages.map(pack => ({ kind: 'artifact_requires' as const, ref: pack.output })),
        ],
        resources: [{ id: 'sim/scanner', units: 1 }, { id: 'sim/engine', units: 1 }],
        actions: { execute: { simScenario: 'success', note: '虚拟扫描 -> 图像 -> 虚拟出纸' } },
        estimateMinutes: 15,
      },
      actor,
    ).id,
  )

  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0031',
        type: 'integration',
        title: '模拟异常恢复:取消/超时/缺纸/引擎错误',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [{ kind: 'hard_after', ref: 'TASK-COPY-0030' }],
        resources: [{ id: 'sim/scanner', units: 1 }, { id: 'sim/engine', units: 1 }],
        actions: { execute: { simSuite: 'copy-recovery', note: '方案 19.3 必选异常全部场景' } },
        estimateMinutes: 20,
      },
      actor,
    ).id,
  )

  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0040',
        type: 'acceptance',
        title: '需求验收:独立评估并生成证据包',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [
          { kind: 'hard_after', ref: 'TASK-COPY-0031' },
          { kind: 'artifact_requires', ref: 'acceptance-automation' },
        ],
        actions: { verify: { evaluateAcceptance: true } },
        estimateMinutes: 10,
      },
      actor,
    ).id,
  )

  // 真机队列(无真机时停留在 BLOCKED_RESOURCE,演示资源等待)
  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0050',
        type: 'integration',
        title: '获取 Printer-01 并刷机',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [
          { kind: 'hard_after', ref: 'TASK-COPY-0040' },
          { kind: 'contract_requires', ref: 'IF-ENGINE@v1' },
          ...gate,
        ],
        resources: [
          { id: 'device/printer-01', mode: 'exclusive' },
          { id: 'device/printer-01/serial', mode: 'shared-read' },
          { id: 'build/rk3588', units: 1 },
        ],
        note: '真机 Provider 待 Phase 0 事实后接入(刷机/救援路径)',
        estimateMinutes: 30,
      },
      actor,
    ).id,
  )
  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0051',
        type: 'integration',
        title: '板端冒烟 + VNC 面板发起真实单页复印',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [{ kind: 'hard_after', ref: 'TASK-COPY-0050' }],
        resources: [
          { id: 'device/printer-01', mode: 'exclusive' },
          { id: 'device/printer-01/vnc-input', mode: 'exclusive' },
          { id: 'device/printer-01/serial', mode: 'shared-read' },
          { id: 'human/operator', action: 'load-a4-original' },
        ],
        estimateMinutes: 20,
      },
      actor,
    ).id,
  )
  taskIds.push(
    workbench.createTask(
      {
        id: 'TASK-COPY-0052',
        type: 'integration',
        title: '真机异常恢复:缺纸补纸/取消(附录 B 用例)',
        requirementRefs: [DEMO_REQUIREMENT_ID],
        dependencies: [{ kind: 'hard_after', ref: 'TASK-COPY-0051' }],
        resources: [
          { id: 'device/printer-01', mode: 'exclusive' },
          { id: 'device/printer-01/engine', mode: 'exclusive' },
          { id: 'fixture/power-relay-01', mode: 'exclusive' },
          { id: 'human/operator', action: 'load-a4-paper' },
        ],
        estimateMinutes: 30,
      },
      actor,
    ).id,
  )

  // ---------- 测试用例(附录 B / 方案 19.3) ----------
  const cases: TestCaseRow[] = [
    {
      id: 'TC-COPY-FUNC-0001',
      title: '面板发起单页黑白复印(模拟主流程)',
      level: 'L1',
      requirementRefs: [DEMO_REQUIREMENT_ID],
      acceptanceRefs: ['AC-COPY-0001-0001'],
      preconditions: ['virtual-device-ready', 'a4-original-present'],
      steps: [{ action: 'panel.copy.start' }, { expect: 'job.state == COMPLETED' }, { expect: 'pages_out == 1' }],
      resources: [{ id: 'sim/scanner', units: 1 }, { id: 'sim/engine', units: 1 }],
      cleanup: ['释放模拟器租约'],
      evidence: ['job-timeline', 'sim-events'],
    },
    {
      id: 'TC-COPY-REC-0002',
      title: '扫描前取消',
      level: 'L1',
      requirementRefs: [DEMO_REQUIREMENT_ID],
      acceptanceRefs: ['AC-COPY-0001-0002'],
      preconditions: ['virtual-device-ready'],
      steps: [{ action: 'panel.copy.start' }, { action: 'panel.copy.cancel' }, { expect: 'job.state == CANCELLED' }],
      resources: [{ id: 'sim/scanner', units: 1 }, { id: 'sim/engine', units: 1 }],
      cleanup: ['设备回到就绪'],
      evidence: ['job-timeline'],
    },
    {
      id: 'TC-COPY-REC-0003',
      title: '扫描超时进入 FAILED',
      level: 'L1',
      requirementRefs: [DEMO_REQUIREMENT_ID],
      acceptanceRefs: ['AC-COPY-0001-0002'],
      preconditions: ['virtual-device-ready'],
      steps: [{ action: 'inject.scan-timeout' }, { action: 'panel.copy.start' }, { expect: 'job.state == FAILED' }],
      resources: [{ id: 'sim/scanner', units: 1 }],
      cleanup: ['清理注入并恢复'],
      evidence: ['job-timeline'],
    },
    {
      id: 'TC-COPY-REC-0004',
      title: '复印缺纸后补纸恢复',
      level: 'L1',
      requirementRefs: [DEMO_REQUIREMENT_ID],
      acceptanceRefs: ['AC-COPY-0001-0002'],
      preconditions: ['virtual-device-ready', 'tray.paper_count == 0'],
      steps: [
        { action: 'panel.copy.start' },
        { expect: 'job.state == WAITING_FOR_PAPER' },
        { human: 'load-a4-paper' },
        { action: 'panel.continue' },
        { expect: 'job.state == COMPLETED' },
      ],
      resources: [{ id: 'sim/engine', units: 1 }, { id: 'human/operator', action: 'load-a4-paper' }],
      cleanup: ['fwctl device restore-known-state'],
      evidence: ['panel-screenshots', 'job-timeline'],
    },
    {
      id: 'TC-COPY-REC-0005',
      title: '缺纸未恢复作业终止',
      level: 'L1',
      requirementRefs: [DEMO_REQUIREMENT_ID],
      acceptanceRefs: ['AC-COPY-0001-0002'],
      preconditions: ['virtual-device-ready', 'tray.paper_count == 0'],
      steps: [{ action: 'panel.copy.start' }, { expect: 'job.state == WAITING_FOR_PAPER' }, { action: 'give-up' }, { expect: 'job.state == FAILED' }],
      resources: [{ id: 'sim/engine', units: 1 }],
      cleanup: ['清理并恢复'],
      evidence: ['job-timeline'],
    },
    {
      id: 'TC-COPY-REC-0006',
      title: '真机:真实扫描到真实出纸(L4)',
      level: 'L4',
      requirementRefs: [DEMO_REQUIREMENT_ID],
      acceptanceRefs: ['AC-COPY-0001-0003'],
      preconditions: ['device.state == READY', 'firmware-flashed'],
      steps: [{ action: 'panel.copy.start(vnc)' }, { expect: 'job.state == COMPLETED' }, { human: 'verify-output-sheet' }],
      resources: [
        { id: 'device/printer-01', mode: 'exclusive' },
        { id: 'device/printer-01/vnc-input', mode: 'exclusive' },
        { id: 'device/printer-01/serial', mode: 'shared-read' },
      ],
      cleanup: ['fwctl device cancel-all', 'fwctl device restore-known-state'],
      evidence: ['panel-screenshots', 'serial-log', 'job-timeline', 'output-sheet-record'],
    },
    {
      id: 'TC-COPY-REC-0007',
      title: '真机:复印缺纸后补纸恢复(L4,附录 B 原型)',
      level: 'L4',
      requirementRefs: [DEMO_REQUIREMENT_ID],
      acceptanceRefs: ['AC-COPY-0001-0003'],
      preconditions: ['device.state == READY', 'tray.default.paper_count == 0', 'scanner.original_present == true'],
      steps: [
        { action: 'panel.copy.start' },
        { expect: 'job.state == WAITING_FOR_PAPER' },
        { expect: 'panel.error == PAPER_EMPTY' },
        { human: 'load-a4-paper' },
        { action: 'panel.continue' },
        { expect: 'job.state == COMPLETED' },
      ],
      resources: [
        { id: 'device/printer-01', mode: 'exclusive' },
        { id: 'device/printer-01/vnc-input', mode: 'exclusive' },
        { id: 'device/printer-01/serial', mode: 'shared-read' },
        { id: 'human/operator', action: 'load-a4-paper' },
      ],
      cleanup: ['fwctl device cancel-all', 'fwctl device restore-known-state'],
      evidence: ['panel-screenshots', 'serial-log', 'job-timeline', 'output-sheet-record'],
    },
  ]
  for (const testCase of cases) insertTestCase(store, testCase)

  // 真实硬件 Provider 未接入(Phase 0 事实待冻结):真机资源标记隔离,任务停留在资源等待队列
  const hardwareIds = [
    'device/printer-01',
    'device/printer-01/serial',
    'device/printer-01/vnc-view',
    'device/printer-01/vnc-input',
    'device/printer-01/scanner',
    'device/printer-01/engine',
    'fixture/power-relay-01',
    'instrument/image-meter',
  ]
  const quarantine = store.db.prepare(
    "UPDATE resources SET state = 'quarantined', quarantine_reason = ? WHERE id = ?",
  )
  for (const id of hardwareIds) {
    quarantine.run('真机 Provider 未接入(Phase 0 事实待冻结)', id)
  }
  store.appendEvent(actor, 'hardware.pending_phase0', {
    resources: hardwareIds,
    note: '无真实样机:整机资源保持隔离,真机任务排队演示 BLOCKED_RESOURCE',
  })

  store.appendEvent(actor, 'demo.seed_done', {
    requirement: DEMO_REQUIREMENT_ID,
    tasks: taskIds.length,
    testCases: cases.length,
  })

  workbench.refreshStates(actor)
  return { requirementId: DEMO_REQUIREMENT_ID, taskIds }
}

/**
 * 引导式流程的三个签署动作(方案 7.2 G1/G3):
 * 批准 Define、冻结全部契约并批准 G3。返回当前需求状态。
 */
export function approveDefineGate(store: WorkbenchStore, actor = 'web'): { requirementId: string; status: string } {
  const requirement = getRequirementForDemo(store)
  const approved = approveRequirement(store, requirement.id, actor)
  return { requirementId: approved.id, status: approved.status }
}

export function freezeContractGate(
  store: WorkbenchStore,
  actor = 'web',
): { contracts: Array<{ id: string; status: string }>; gate: string } {
  const frozen: Array<{ id: string; status: string }> = []
  for (const contract of CONTRACTS) {
    const existing = store.db
      .prepare('SELECT id FROM contracts WHERE name = ? AND version = ?')
      .get(contract.name, contract.version) as { id: string } | undefined
    const record = existing ?? createContract(store, {
      name: contract.name,
      version: contract.version,
      body: { summary: contract.summary, status: 'baseline' },
      actor,
    })
    const result = freezeContract(store, record.id, actor)
    frozen.push({ id: result.id, status: result.status })
  }
  setGateDecision(store, {
    id: 'G3-CONTRACT-BASELINE',
    scope: 'REQ-COPY-0001 契约基线',
    decision: 'approved',
    signer: actor,
    conditions: ['模拟契约:真机阶段按 Phase 0 实测协议替换版本'],
  })
  return { contracts: frozen, gate: 'G3-CONTRACT-BASELINE' }
}

/** 用户导入自己的需求(P0):更新种子需求的原始文本,重置工程等待重新评审 */
export function importUserRequirement(
  store: WorkbenchStore,
  input: { title: string; text: string },
  actor = 'web',
): { requirementId: string; status: string } {
  // 完整重播种(含 Define 模板与任务 DAG),再覆盖为用户的原始需求;状态保持 defined 等待评审批准
  seedDemo(store, actor, { reset: true, autoGate: false })
  store.db
    .prepare('UPDATE requirements SET title = ?, original_text = ?, updated_at = ? WHERE id = ?')
    .run(input.title, input.text, store.now(), DEMO_REQUIREMENT_ID)
  store.appendEvent(actor, 'requirement.import', {
    id: DEMO_REQUIREMENT_ID,
    title: input.title,
    note: '用户自定义原始需求;Define 模板已生成,等待评审批准(G1)',
  })
  return { requirementId: DEMO_REQUIREMENT_ID, status: 'defined' }
}

function getRequirementForDemo(store: WorkbenchStore): { id: string; status: string } {
  const row = store.db
    .prepare('SELECT id, status FROM requirements WHERE id = ?')
    .get(DEMO_REQUIREMENT_ID) as { id: string; status: string } | undefined
  if (!row) throw new Error('工程尚未装载:请先导入需求或装载种子')
  if (row.status !== 'defined') {
    throw new Error(`需求状态为 ${row.status},只有 defined(Define 已就绪)可批准;请先装载种子或导入需求`)
  }
  return row
}

function cliEntrypoint(): string {
  const url = new URL('./cli.js', import.meta.url)
  let path = decodeURIComponent(url.pathname)
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return `"${path}"`
}
