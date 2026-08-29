import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkbenchStore } from '../lib/core/store.js'
import { Workbench } from '../lib/core/workbench.js'
import { validateDag, evaluateRunnable, computeCriticalPath, assertTransition } from '../lib/core/dag.js'
import { seedResources, acquireLeases, releaseTaskLeases, sweepExpiredLeases, quarantineResource, listLeases } from '../lib/core/resources.js'
import { createContract, freezeContract, updateContractBody, setGateDecision } from '../lib/core/contract.js'
import { seedDemo, resetDemoState, autoAlignRequirement, freezeContractGate, DEMO_REQUIREMENT_ID } from '../lib/demo.js'
import { importRawRequirement, listQuestions, answerQuestion, proposeItem, draftDefine, submitDefine, reviewDefine, changeItem, clarifyComplete, listItems, listDefineVersions } from '../lib/core/align.js'
import { nextJobState, JOB_TRANSITIONS } from '../lib/sim/job-model.js'
import { VirtualDevice, SCENARIO_EXPECTATIONS } from '../lib/sim/virtual-device.js'
import { EvidenceStore } from '../lib/core/evidence/store.js'
import { evaluateRequirement, generateAcceptanceBundle } from '../lib/core/acceptance.js'
import { runTaskLocally } from '../lib/core/runner/local.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function safeClose(store, dir) {
  try { store.close() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

function freshDb(name) {
  const dir = mkdtempSync(join(tmpdir(), `fwb-${name}-`))
  const store = new WorkbenchStore(join(dir, 'test.db'))
  return { store, dir }
}

// ---------- DAG ----------

function task(id, overrides = {}) {
  return {
    id,
    type: 'implementation',
    title: id,
    requirementRefs: [],
    acceptanceRefs: [],
    dependencies: [],
    inputs: [],
    outputs: [],
    resources: [],
    actions: {},
    policy: {},
    evidence: [],
    status: 'planned',
    createdAt: '2026-08-28T00:00:00.000Z',
    attempts: 0,
    ...overrides,
  }
}

test('DAG 校验:引用存在与循环检测', () => {
  const tasks = [
    task('A', { dependencies: [{ kind: 'hard_after', ref: 'B' }] }),
    task('B', { dependencies: [{ kind: 'hard_after', ref: 'A' }] }),
    task('C', { dependencies: [{ kind: 'hard_after', ref: 'MISSING' }] }),
    task('D', { dependencies: [{ kind: 'contract_requires', ref: 'BAD-FORMAT' }] }),
  ]
  const errors = validateDag(tasks)
  assert.ok(errors.some(e => e.includes('循环')))
  assert.ok(errors.some(e => e.includes('MISSING')))
  assert.ok(errors.some(e => e.includes('名称@版本')))
})

test('DAG 可运行判定:依赖/契约/门禁/产物/资源分列阻塞', () => {
  const ctx = {
    tasks: [
      task('T', {
        dependencies: [
          { kind: 'hard_after', ref: 'PRE' },
          { kind: 'contract_requires', ref: 'IF-X@v1' },
          { kind: 'gate_requires', ref: 'G3' },
          { kind: 'artifact_requires', ref: 'art-1' },
        ],
        resources: [{ id: 'sim/scanner', units: 1 }],
      }),
      task('PRE', { status: 'planned' }),
    ],
    frozenContracts: new Set(),
    approvedGates: new Set(),
    producedArtifacts: new Set(),
    availableData: new Set(),
    resourceBlocker: () => '虚拟资源忙',
  }
  const verdict = evaluateRunnable(ctx.tasks[0], ctx)
  assert.equal(verdict.runnable, false)
  const kinds = verdict.blockers.map(b => b.kind)
  assert.deepEqual(kinds.sort(), ['artifact', 'contract', 'dependency', 'gate', 'resource'].sort())
})

test('关键路径:最长加权链', () => {
  const tasks = [
    task('A', { estimateMinutes: 60 }),
    task('B', { estimateMinutes: 10, dependencies: [{ kind: 'hard_after', ref: 'A' }] }),
    task('C', { estimateMinutes: 30, dependencies: [{ kind: 'hard_after', ref: 'A' }] }),
    task('D', { dependencies: [{ kind: 'hard_after', ref: 'B' }] }),
  ]
  const path = computeCriticalPath(tasks)
  assert.equal(path.totalMinutes, 100) // A60 + B10 + D30(缺省 30)
  assert.deepEqual(path.ids, ['A', 'B', 'D'])
})

test('任务状态机:非法迁移被拒绝', () => {
  assert.throws(() => assertTransition('succeeded', 'running'))
  assert.throws(() => assertTransition('planned', 'succeeded'))
  assert.doesNotThrow(() => assertTransition('blocked_resource', 'reserved'))
})

// ---------- 资源租约 ----------

test('原子租约:任一资源不可得则全部失败', () => {
  const { store, dir } = freshDb('lease')
  seedResources(store)
  const ok = acquireLeases(store, { taskId: 'T1', owner: 'test', purpose: 'x', requirements: [{ id: 'sim/scanner', units: 1 }, { id: 'sim/engine', units: 1 }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.leases.length, 2)

  // device/printer-01 独占:第二次申请互斥
  const second = acquireLeases(store, { taskId: 'T2', owner: 'test', purpose: 'y', requirements: [{ id: 'device/printer-01' }] })
  assert.equal(second.ok, true)
  const third = acquireLeases(store, { taskId: 'T3', owner: 'test', purpose: 'z', requirements: [{ id: 'device/printer-01' }] })
  assert.equal(third.ok, false)
  assert.equal(third.leases.length, 0, '不得留下半套租约')
  assert.equal(listLeases(store, { activeOnly: true, taskId: 'T3' }).length, 0)

  releaseTaskLeases(store, 'T2')
  const fourth = acquireLeases(store, { taskId: 'T4', owner: 'test', purpose: 'w', requirements: [{ id: 'device/printer-01' }] })
  assert.equal(fourth.ok, true)
  safeClose(store, dir)
})

test('容量型资源:超出容量被拒', () => {
  const { store, dir } = freshDb('cap')
  seedResources(store)
  const a = acquireLeases(store, { taskId: 'A', owner: 't', purpose: 'p', requirements: [{ id: 'sim/scanner', units: 3 }] })
  const b = acquireLeases(store, { taskId: 'B', owner: 't', purpose: 'p', requirements: [{ id: 'sim/scanner', units: 1 }] })
  const c = acquireLeases(store, { taskId: 'C', owner: 't', purpose: 'p', requirements: [{ id: 'sim/scanner', units: 1 }] })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(c.ok, false, '4 单位容量被 3+1 占满')
  safeClose(store, dir)
})

test('租约过期:资源进入隔离待清理(方案 9.4)', () => {
  const { store, dir } = freshDb('ttl')
  seedResources(store)
  acquireLeases(store, { taskId: 'T1', owner: 't', purpose: 'p', requirements: [{ id: 'device/printer-01' }], ttlMinutes: -1 })
  const expired = sweepExpiredLeases(store)
  assert.equal(expired.length, 1)
  const res = JSON.parse(JSON.stringify(store.db.prepare("SELECT state FROM resources WHERE id = 'device/printer-01'").get()))
  assert.equal(res.state, 'quarantined')
  quarantineResource(store, 'device/printer-01', '测试恢复')
  safeClose(store, dir)
})

// ---------- 需求与契约 ----------

test('对齐层:澄清门未关不允许起草 Define;答完可起草', () => {
  const { store, dir } = freshDb('clarify')
  const req = importRawRequirement(store, { title: 'T', text: 'X', id: 'REQ-CL-0001' })
  const questions = listQuestions(store, req.id)
  assert.ok(questions.length >= 5, '模板问题已生成')
  assert.equal(clarifyComplete(store, req.id), false)
  assert.throws(() => draftDefine(store, req.id, {}), /澄清未完成/)
  for (const q of questions) answerQuestion(store, q.id, '测试答案', 'tester')
  assert.equal(clarifyComplete(store, req.id), true)
  assert.doesNotThrow(() => proposeItem(store, { requirementId: req.id, content: '条目', origin: 'template' }, 'tester'))
  assert.doesNotThrow(() => draftDefine(store, req.id, { note: 'test' }, 'tester'))
  safeClose(store, dir)
})

test('对齐层:三态评审 —— request-changes 打回,approve 物化 AC 并批 G1', () => {
  const { store, dir } = freshDb('review')
  const req = importRawRequirement(store, { title: 'T', text: 'X', id: 'REQ-RV-0001' })
  for (const q of listQuestions(store, req.id)) answerQuestion(store, q.id, '答案', 'tester')
  proposeItem(store, {
    requirementId: req.id,
    content: '条目 A',
    acceptance: [{ title: 'AC-A', method: 'automated', maxLevel: 'L1' }],
    origin: 'template',
  }, 'tester')
  const define = draftDefine(store, req.id, {}, 'tester')
  submitDefine(store, define.id, 'tester')

  // request-changes:版本 rejected、需求回 defining、条目回 proposed
  const rc = reviewDefine(store, { defineId: define.id, decision: 'request-changes', reviewer: 'rev', comments: [{ itemId: listItems(store, req.id)[0].id, text: '恢复策略未定义' }] })
  assert.equal(rc.define.status, 'rejected')
  assert.equal(rc.requirement.status, 'defining')

  // 修订(v2)后批准:条目 approved、AC 物化、G1 批准
  const define2 = draftDefine(store, req.id, { note: 'v2' }, 'tester')
  assert.equal(define2.version, 2)
  submitDefine(store, define2.id, 'tester')
  const approved = reviewDefine(store, { defineId: define2.id, decision: 'approve', reviewer: 'rev' })
  assert.equal(approved.define.status, 'approved')
  assert.equal(approved.requirement.status, 'approved')
  assert.equal(listDefineVersions(store, req.id).find(v => v.version === 1).status, 'superseded', '批准后旧版本链被取代')
  const acs = store.db.prepare('SELECT id FROM acceptance_criteria WHERE requirement_id = ?').all(req.id)
  assert.equal(acs.length, 1)
  assert.ok(store.db.prepare('SELECT id FROM gates WHERE id = ? AND decision = ?').get(`G1-${req.id}`, 'approved'))
  safeClose(store, dir)
})

test('对齐层:变更传导 —— 条目 changed、任务 stale 回 planned、G1 回 pending', () => {
  const { store, dir } = freshDb('change')
  seedDemo(store, 'test', { reset: true, autoGate: true })
  const workbench = new Workbench(store)
  // 推进一个已完成任务
  const r = workbench.acquireTask('TASK-COPY-0010', 'test')
  assert.equal(r.ok, true)
  workbench.startTask('TASK-COPY-0010', 'test')
  workbench.beginVerify('TASK-COPY-0010', 'test')
  workbench.completeTask('TASK-COPY-0010', 'test')
  assert.equal(workbench.getTask('TASK-COPY-0010').status, 'succeeded')

  const outcome = changeItem(store, {
    itemId: 'ITEM-COPY-0001-01',
    content: '单页黑白复印闭环(份数支持 1-99)',
    source: 'customer',
    summary: '份数从 1 改为支持 1-99',
  }, 'product')
  assert.equal(outcome.requirementId, DEMO_REQUIREMENT_ID)
  assert.ok(outcome.staleTasks.includes('TASK-COPY-0010'), '已完成任务被打回 stale')
  const task = workbench.getTask('TASK-COPY-0010')
  assert.equal(task.status, 'planned')
  assert.ok(task.staleReason?.includes('变更'))
  assert.ok(store.db.prepare('SELECT id FROM gates WHERE id = ? AND decision = ?').get(`G1-${DEMO_REQUIREMENT_ID}`, 'pending'))
  safeClose(store, dir)
})

test('契约冻结后不可修改,变更需新版本(方案 15.3)', () => {
  const { store, dir } = freshDb('contract')
  const contract = createContract(store, { name: 'IF-TEST', version: 'v1', body: {} })
  freezeContract(store, contract.id)
  assert.throws(() => updateContractBody(store, contract.id, { changed: true }))
  safeClose(store, dir)
})

test('门禁批准后 gate_requires 解除阻塞', () => {
  const { store, dir } = freshDb('gate')
  const workbench = new Workbench(store)
  seedResources(store)
  importRawRequirement(store, { title: 'T', text: 'X', id: 'REQ-G-0001' })
  workbench.createTask({ id: 'TASK-G-1', type: 'implementation', title: 'gated', requirementRefs: ['REQ-G-0001'], dependencies: [{ kind: 'gate_requires', ref: 'G-TEST' }] })
  workbench.refreshStates()
  assert.equal(workbench.getTask('TASK-G-1').status, 'blocked_gate')
  setGateDecision(store, { id: 'G-TEST', scope: 'test', decision: 'approved', signer: 'tester' })
  workbench.refreshStates()
  assert.equal(workbench.getTask('TASK-G-1').status, 'ready')
  safeClose(store, dir)
})

// ---------- 模拟器 ----------

test('作业状态机:未定义迁移被拒绝', () => {
  assert.throws(() => nextJobState('IDLE', 'PRINT_DONE'))
  assert.equal(nextJobState('IDLE', 'COPY_START'), 'SCANNING')
  assert.equal(JOB_TRANSITIONS.WAITING_FOR_PAPER.PAPER_LOADED, 'PRINTING')
})

test('虚拟设备:全部场景符合转移表预期(方案 11.6 Oracle)', async () => {
  for (const [scenario, expectation] of Object.entries(SCENARIO_EXPECTATIONS)) {
    const device = new VirtualDevice(`JOB-${scenario}`, { scenario, scanMs: 0, processMs: 0, printMs: 0 })
    const result = await device.runCopy()
    assert.equal(result.finalState, expectation.finalState, `场景 ${scenario} 终态`)
    assert.equal(result.pagesOut, expectation.pagesOut, `场景 ${scenario} 出纸`)
    assert.equal(result.pass, expectation.pass)
  }
})

// ---------- 工作台生命周期 ----------

test('任务生命周期:acquire -> start -> verifying -> succeeded 并登记产物', async () => {
  const { store, dir } = freshDb('lifecycle')
  const workbench = new Workbench(store)
  seedResources(store)
  workbench.createTask({
    id: 'TASK-L-1',
    type: 'implementation',
    title: 'lifecycle',
    outputs: ['artifact-l1'],
    resources: [{ id: 'build/rk3588', units: 1 }],
    actions: { execute: { simScenario: 'success' } },
  })
  const run = await runTaskLocally(workbench, 'TASK-L-1', { actor: 'test' })
  assert.equal(run.ok, true, run.message)
  const taskRow = workbench.getTask('TASK-L-1')
  assert.equal(taskRow.status, 'succeeded')
  const artifact = store.db.prepare("SELECT * FROM artifacts WHERE name = 'artifact-l1'").get()
  assert.ok(artifact, '产物已登记')
  assert.equal(listLeases(store, { activeOnly: true, taskId: 'TASK-L-1' }).length, 0, '完成后释放租约')
  safeClose(store, dir)
})

test('失败三分类:产品失败不自动重试,租约释放', async () => {
  const { store, dir } = freshDb('fail')
  const workbench = new Workbench(store)
  seedResources(store)
  workbench.createTask({
    id: 'TASK-F-1',
    type: 'implementation',
    title: 'failing',
    resources: [{ id: 'sim/scanner', units: 1 }],
    actions: { execute: { simScenario: 'unknown-scenario' } },
  })
  const run = await runTaskLocally(workbench, 'TASK-F-1', { actor: 'test' })
  assert.equal(run.ok, false)
  assert.equal(run.failureClass, 'infra', '未知场景属执行配置问题')
  assert.equal(workbench.getTask('TASK-F-1').status, 'failed_infra')
  assert.equal(listLeases(store, { activeOnly: true, taskId: 'TASK-F-1' }).length, 0)
  safeClose(store, dir)
})

// ---------- 种子重放与验收 ----------

test('demo 种子幂等且支持重放;模拟闭环 L1 PASS / 全量 BLOCKED', async () => {
  const { store, dir } = freshDb('demo')
  seedDemo(store, 'test', { reset: true, autoGate: true })
  seedDemo(store, 'test', { reset: true, autoGate: true }) // 幂等
  const workbench = new Workbench(store)

  const results = []
  const runNext = async () => {
    workbench.refreshStates('test')
    const queue = workbench.readyQueue()
    if (!queue.length) return
    const r = await runTaskLocally(workbench, queue[0].id, { actor: 'test', humanAutoAccept: true })
    results.push(r)
    if (r.ok) return runNext()
  }
  await runNext()

  const tasks = workbench.listTasks()
  assert.equal(tasks.filter(t => t.status === 'succeeded').length, 16, '16 个模拟任务完成')
  assert.equal(tasks.filter(t => t.status === 'blocked_resource').length, 3, '真机任务排队等待资源')
  assert.ok(results.every(r => r.ok), '全部执行成功')

  const evidence = new EvidenceStore(store, join(dir, 'evidence'))
  const generated = generateAcceptanceBundle({
    store,
    evidence,
    requirementId: DEMO_REQUIREMENT_ID,
    baselines: { product: 'PRD-A4-MONO-MFP-v0.1' },
    maxLevel: 'L1',
    actor: 'test',
  })
  assert.equal(generated.decision.decision, 'PASS')
  assert.equal(generated.decision.coverage.passed, 5)

  const full = evaluateRequirement(store, DEMO_REQUIREMENT_ID)
  assert.equal(full.decision, 'BLOCKED', '全量范围因真机用例未执行而 BLOCKED')

  // 证据哈希校验
  const bundleRecord = evidence.get(generated.bundleId)
  assert.equal(evidence.verify(bundleRecord), true)
  safeClose(store, dir)
})

test('引导模式:门禁未签署时任务 blocked_gate,签署后解锁', () => {
  const { store, dir } = freshDb('walkthrough')
  seedDemo(store, 'test', { reset: true, autoGate: false })
  const workbench = new Workbench(store)
  workbench.refreshStates('test')
  // 完成 0001/0002 后,0010 仍因契约未冻结 + 门禁未批准而阻塞
  for (const id of ['TASK-COPY-0001', 'TASK-COPY-0002']) {
    workbench.acquireTask(id, 'test')
    workbench.startTask(id, 'test')
    workbench.beginVerify(id, 'test')
    workbench.completeTask(id, 'test')
  }
  workbench.refreshStates('test')
  assert.equal(workbench.getTask('TASK-COPY-0010').status, 'blocked_gate')

  const aligned = autoAlignRequirement(store, DEMO_REQUIREMENT_ID, 'test')
  assert.equal(aligned.decision, 'approved')
  freezeContractGate(store, 'test')
  workbench.refreshStates('test')
  assert.equal(workbench.getTask('TASK-COPY-0010').status, 'ready')
  safeClose(store, dir)
})

test('证据仓内容寻址:同内容同哈希、哈希校验', () => {
  const { store, dir } = freshDb('evidence')
  const evidence = new EvidenceStore(store, join(dir, 'evidence'))
  const a = evidence.putFile('a.txt', 'hello')
  const b = evidence.putFile('b.txt', 'hello')
  assert.equal(a.sha256, b.sha256)
  assert.equal(evidence.verify(a), true)
  const c = evidence.putFile('c.txt', 'world!')
  assert.notEqual(a.sha256, c.sha256)
  assert.equal(evidence.verify(c), true)
  safeClose(store, dir)
})

test('resetDemoState 清空对齐层与执行层,保留契约/用例/资源', () => {
  const { store, dir } = freshDb('reset')
  seedDemo(store, 'test', { autoGate: true })
  resetDemoState(store)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM requirements').get().n, 0, '需求清空(重新装载)')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM clarify_questions').get().n, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n, 5, '契约保留')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM test_cases').get().n, 7, '用例目录保留')
  safeClose(store, dir)
})
