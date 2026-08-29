import type { WorkbenchStore } from './core/store.js'
import { seedResources } from './core/resources.js'
import { Workbench } from './core/workbench.js'
import {
  importRawRequirement,
  listQuestions,
  answerQuestion,
  proposeItem,
  draftDefine,
  submitDefine,
  reviewDefine,
  type ItemAcceptance,
} from './core/align.js'
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
  // v2:完整清空对齐层 + 执行层(需求重新从 clarifying 走);契约、用例目录与资源保留
  store.db.exec(
    `DELETE FROM leases; DELETE FROM test_runs; DELETE FROM artifacts; DELETE FROM tasks; DELETE FROM gates;
     DELETE FROM clarify_questions; DELETE FROM requirement_items; DELETE FROM define_versions;
     DELETE FROM reviews; DELETE FROM decisions; DELETE FROM change_records;
     DELETE FROM acceptance_criteria; DELETE FROM requirements;`
  )
  store.appendEvent('system', 'demo.reset', { note: '重置工程:对齐层与执行层清空,契约/用例/资源保留' })
}

export function seedDemo(
  store: WorkbenchStore,
  actor = 'demo-seed',
  opts: { reset?: boolean; autoGate?: boolean } = {},
): { requirementId: string; taskIds: string[] } {
  if (opts.reset) resetDemoState(store)
  seedResources(store)

  // ---------- 需求(v2:多需求集合 + 澄清问答,提案 §3.1/G2) ----------
  importRawRequirement(
    store,
    {
      id: DEMO_REQUIREMENT_ID,
      title: '面板发起单页黑白复印',
      text: '用户在设备面板选择"复印",放入一张 A4 原稿,设备以产品定义的分辨率完成扫描、图像处理,并由真实打印引擎输出一张黑白纸张。',
      priority: 'high',
    },
    actor,
  )
  // 第二需求(G2 多需求演示):停留在 clarifying,由用户后续推进
  importRawRequirement(
    store,
    {
      title: '扫描件保存到 U 盘',
      text: '用户将 U 盘插入设备前面板端口,扫描完成后设备将 PDF/JPG 写入 U 盘指定目录,并在面板显示保存结果;U 盘拔出或写失败时给出明确提示。',
      priority: 'medium',
    },
    actor,
  )

  // ---------- 门禁与契约:引导模式下由用户逐步签署(方案 7.2 阶段门禁) ----------
  // ---------- 门禁与契约:引导模式下由用户逐步签署(方案 7.2 阶段门禁) ----------
  if (opts.autoGate) {
    autoAlignRequirement(store, DEMO_REQUIREMENT_ID, actor)
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
        dependencies: [{ kind: 'gate_requires', ref: `G1-${DEMO_REQUIREMENT_ID}` }],
        note: 'G1 门禁由需求评审批准后解锁',
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
        dependencies: [
          { kind: 'hard_after', ref: 'TASK-COPY-0001' },
          { kind: 'gate_requires', ref: `G1-${DEMO_REQUIREMENT_ID}` },
        ],
        note: 'G1 批准后可执行;产物随种子冻结(G3 契约基线)',
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
      acceptanceRefs: ['ITEM-COPY-0001-01-AC1'],
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
      acceptanceRefs: ['ITEM-COPY-0001-02-AC1'],
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
      acceptanceRefs: ['ITEM-COPY-0001-02-AC1'],
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
      acceptanceRefs: ['ITEM-COPY-0001-02-AC1'],
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
      acceptanceRefs: ['ITEM-COPY-0001-02-AC1'],
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
      acceptanceRefs: ['ITEM-COPY-0001-01-AC2'],
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
      acceptanceRefs: ['ITEM-COPY-0001-01-AC2'],
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

/**
 * 主需求的"对齐快速通道"(自动模式/CLI 用):逐题回答模板问题 → 生成需求条目 →
 * 起草 Define v1 → 提交 → 批准(G1)。引导模式(前端)会拆成逐步操作,复用同一组 align 原语。
 */
export function autoAlignRequirement(store: WorkbenchStore, requirementId: string, actor = 'web'): {
  questionsAnswered: number
  items: string[]
  defineId: string
  decision: string
} {
  const req = getRequirementById(store, requirementId)
  if (!req) throw new Error(`需求不存在: ${requirementId}`)

  // 1) 模板问题的种子答案(演示工程语义;真实场景由人逐题回答)
  const seedAnswers: Record<string, string> = {
    '目标纸张规格与介质范围是什么?': '仅 A4 普通纸(80-120g/m²)',
    '单双面、份数与缩放需求?': '单面单份 1:1(本 MVP 不做双面/多份)',
    '异常场景(缺纸/卡纸/开盖/取消)各自的恢复策略是什么?': '缺纸补纸后继续并完成;卡纸/开盖按引擎错误终止并回就绪;取消立即生效',
    '性能有量化目标吗(首张时间/连续速度)?': '暂无,记为待产品签署(Phase 0 后补)',
    '是否涉及用户数据留存或网络暴露面?': '无数据留存、无网络服务',
  }
  let answered = 0
  for (const question of listQuestions(store, requirementId)) {
    if (question.status !== 'open') continue
    const answer = seedAnswers[question.question]
    if (!answer) throw new Error(`问题缺少种子答案: ${question.question}`)
    answerQuestion(store, question.id, answer, actor)
    answered += 1
  }

  // 2) 需求条目(验收标准与测试用例引用对齐)
  const items: Array<{ id: string; content: string; acceptance: ItemAcceptance[] }> = [
    {
      id: 'ITEM-COPY-0001-01',
      content: '单页黑白复印闭环:面板发起 → A4 平板 300dpi 扫描 → 图像处理 → 引擎出纸 1 页 → 面板 COMPLETED',
      acceptance: [
        { title: '模拟层:虚拟设备完成单页黑白复印', method: 'automated', threshold: '终态 COMPLETED 且出纸 1 页', maxLevel: 'L1' },
        { title: '真机:面板发起真实扫描并真实出纸 1 页', method: 'manual', threshold: '真实纸张输出且作业时间线完整', maxLevel: 'L4' },
      ],
    },
    {
      id: 'ITEM-COPY-0001-02',
      content: '异常语义:扫描超时 FAILED、缺纸 WAITING_FOR_PAPER、引擎可恢复错误自动重试;全部场景符合作业状态机',
      acceptance: [
        { title: '模拟层:必选异常场景符合作业状态机(取消/超时/缺纸恢复)', method: 'automated', threshold: '全部场景终态与转移表预期一致', maxLevel: 'L1' },
      ],
    },
  ]
  const itemIds: string[] = []
  for (const item of items) {
    const created = proposeItem(
      store,
      {
        requirementId,
        content: item.content,
        acceptance: item.acceptance,
        priority: 'high',
        origin: 'template',
      },
      actor,
    )
    // 对齐引用 id(测试用例按此引用)
    store.db.prepare('UPDATE requirement_items SET id = ? WHERE id = ?').run(item.id, created.id)
    itemIds.push(item.id)
  }

  // 3) Define v1:起草 → 提交 → 批准(G1)
  const define = draftDefine(
    store,
    requirementId,
    {
      actors: ['local-user'],
      preconditions: ['device-ready', 'a4-paper-available', 'original-on-flatbed'],
      normalFlow: ['面板发起', '扫描', '图像处理', '出纸 1 页', 'COMPLETED'],
      errorFlows: ['扫描超时 FAILED', '缺纸 WAITING_FOR_PAPER', '引擎可恢复错误重试'],
      recoveryRules: ['补纸后继续', '未恢复终止并清理', '取消回就绪'],
      outOfScope: ['pc-driver-development'],
      note: '由 autoAlignRequirement 自动起草并批准(自动演示/CLI 路径)',
    },
    actor,
  )
  submitDefine(store, define.id, actor)
  const review = reviewDefine(store, {
    defineId: define.id,
    decision: 'approve',
    reviewer: actor,
    comments: [],
  })
  return { questionsAnswered: answered, items: itemIds, defineId: review.define.id, decision: review.define.status }
}

function getRequirementById(store: WorkbenchStore, id: string): { id: string; status: string } | undefined {
  const row = store.db.prepare('SELECT id, status FROM requirements WHERE id = ?').get(id) as
    | { id: string; status: string }
    | undefined
  return row ?? undefined
}

/** 导入用户需求(v2 多需求):新增一条需求进入 clarifying,并自动生成模板澄清问题 */
export function importUserRequirement(
  store: WorkbenchStore,
  input: { title: string; text: string },
  actor = 'web',
): { requirementId: string; status: string; questions: number } {
  const requirement = importRawRequirement(store, { title: input.title, text: input.text }, actor)
  const questions = listQuestions(store, requirement.id).length
  return { requirementId: requirement.id, status: requirement.status, questions }
}

function cliEntrypoint(): string {
  const url = new URL('./cli.js', import.meta.url)
  let path = decodeURIComponent(url.pathname)
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return `"${path}"`
}
