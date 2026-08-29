# -*- coding: utf-8 -*-
import io

p = 'src/routes.ts'
s = io.open(p, encoding='utf-8').read()

# 1) imports:demo.ts 新函数
old = "import { seedDemo } from './demo.js'"
new = "import { seedDemo, importUserRequirement, approveDefineGate, freezeContractGate } from './demo.js'"
assert old in s, 'demo import'
s = s.replace(old, new)

# 2) imports:generateAcceptanceBundle 已导入,route 常量追加
old = "  caseRun: `${ROUTE_PREFIX}/case-run`,"
new = """  caseRun: `${ROUTE_PREFIX}/case-run`,
  requirementImport: `${ROUTE_PREFIX}/requirement/import`,
  defineApprove: `${ROUTE_PREFIX}/define/approve`,
  contractsFreeze: `${ROUTE_PREFIX}/contracts/freeze`,"""
assert old in s, 'routes const'
s = s.replace(old, new)

# 3) acceptance POST 支持 generateReport
old = """        case ROUTES.acceptance: {
          const requirementId = String(body.requirementId ?? '')
          if (!requirementId) throw new Error('缺少 requirementId')
          const scope = body.scope === 'sim' ? ('L1' as const) : undefined
          sendJson(res, 200, evaluateRequirement(service.store, requirementId, { maxLevel: scope }))
          return
        }"""
new = """        case ROUTES.acceptance: {
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
          const result = approveDefineGate(service.store, 'web')
          service.workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        case ROUTES.contractsFreeze: {
          const result = freezeContractGate(service.store, 'web')
          service.workbench.refreshStates('web')
          sendJson(res, 200, { ok: true, ...result })
          return
        }"""
assert old in s, 'acceptance case'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('routes interaction patched')
