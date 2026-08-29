# dsh-firmware-workbench

基于 DeepSeek Harness 的单台打印机固件开发工作台(总体方案 v1.0 的落地实现)。
把需求与 Define、任务 DAG、资源租约、模拟器、测试分类、内容寻址证据仓和验收报告放进一个本地工作台。

- 总体方案:见 `../printer-firmware-workbench-solution-v1.0.md`(或公司评审基线)
- 真实硬件接入前必须完成 Phase 0 事实冻结:见 `docs/phase-0-fact-freeze-checklist.md`

## 当前能力(模拟闭环 MVP)

无真实样机时的完成口径(方案 19.4):模拟闭环即完成,每个验收结论标记最高验证层级 L1,不宣称整机验收。

- 导入需求、Define 模板与结构化验收标准,SQLite 持久化 + 全量审计事件。
- 本机复印 MVP 一键种子:19 个任务(方案 8.7 DAG)、5 个契约、7 个测试用例、13 类资源。
- 七种依赖类型(hard_after / artifact_requires / contract_requires / gate_requires / data_requires / soft_after + 资源 recipe)、16 态任务状态机、关键路径与 Ready 队列。
- 资源租约:独占/共享读/容量三种锁模式、原子获取、TTL/心跳/续租、过期隔离与维护恢复。
- 虚拟设备:作业状态机(显式转移表 Oracle)+ 虚拟扫描器/引擎,六个必选场景(主流程、扫描前取消、扫描超时、缺纸恢复、缺纸终止、引擎可恢复错误)。
- 测试结果八分类(PASS / PRODUCT_FAIL / TEST_FAIL / INFRA_FAIL / BLOCKED_RESOURCE / INVALID / FLAKY / WAIVED);任务执行自动绑定用例证据。
- 验收评估双口径:scope=sim(L1 模拟闭环)与 scope=all(真机层级);生成不可变 Evidence Bundle(SHA-256 内容寻址 + JUnit XML + 时间线 + 验收报告)。
- 真实硬件资源(整机/串口/VNC/工装)在资源目录中建模并保持隔离,真机任务停在 `blocked_resource` 队列;Provider 接口已定义,Phase 0 后替换 stub。

## 快速开始(fwctl)

要求 Node.js 24.11+、pnpm 10+。

```powershell
pnpm install
pnpm test
node lib/cli.js demo-seed --db work/demo.db     # 装载 MVP 种子
node lib/cli.js demo-verify --db work/demo.db   # 模拟闭环一条龙:执行 16 个任务 + L1 验收 + 证据包
node lib/cli.js status --db work/demo.db        # 总览(16 succeeded + 3 blocked_resource)
node lib/cli.js ready --db work/demo.db         # Ready 队列 / 关键路径 / 阻塞原因
```

验收报告与证据包输出在 `work/evidence/bundles/<run-id>/`(manifest、任务计划、执行时间线、JUnit、验收决定与报告)。

## fwctl 命令面(方案 5.4)

```text
demo-seed / demo-verify / run --task / run all / ready / status / resources
requirement import --title T --text X
contract freeze --name IF-X --version v1
plan validate
task acquire|start|complete|fail|release --task <id>
device acquire|release|quarantine|maintain
sim run --scenario <name> / sim states / sim component --name <x>
test select|run|record
accept evaluate --scope sim|all / accept report
evidence list|export
build   # 演示构建清单;Phase 0 后接入容器构建
```

## DSH 集成

本包是标准 DSH 插件。`dsh-env/`(工作区上一级)提供一键启动:

```text
workflow_2/
├─ firmware-workbench/     # 本项目(源码 + 构建产物)
└─ dsh-env/                # 实际成品:DSH host + profile + 插件 + 启动脚本
   ├─ runtime/node/        # Node 24 运行时
   ├─ runtime/dsh/         # @deepseek-ai/dsh host
   ├─ dsh-home/profiles/web/
   └─ 启动工作台.cmd
```

双击 `启动工作台.cmd`(或 `powershell -File dsh-env/tools/start.ps1`)后浏览器打开 `http://127.0.0.1:3081`,
左侧出现 Firmware 工作台入口,提供四视图:定义与总览、任务编排、测试资源、样机座舱。

模型工具(DSH 会话中可用,变更类经 Harness 审批):

- `printer_workbench_status`:只读快照。
- `printer_requirement_import`:导入需求。
- `printer_demo_seed`:装载本机复印 MVP。
- `printer_task_acquire` / `printer_task_start` / `printer_task_update` / `printer_task_release`:任务生命周期。
- `printer_task_run`:本地 Runner 端到端运行任务。
- `printer_test_record`:按八分类记录用例结果。
- `printer_acceptance_evaluate`:评估验收(scope=sim|all,可生成证据包)。

## 状态与资源语义

```text
planned → blocked_dependency / blocked_gate / blocked_resource
        → ready → reserved → running → verifying → succeeded
                                            ├→ failed_product
                                            ├→ failed_test
                                            └→ failed_infra
```

真实样机独占;串口观察与 VNC 观看共享;VNC 输入、扫描器、引擎、断电工装和人工位按任务独占;
一个任务必须同时拿到它声明的全部资源才能启动(原子租约)。

## 代码结构

```text
src/store.ts (core/store.ts)     SQLite 模型与审计事件
src/core/dag.ts                  依赖校验、Runnable 判定、关键路径、Ready 队列
src/core/resources.ts            资源目录、三种锁模式、原子租约、TTL/隔离
src/core/workbench.ts            任务生命周期编排
src/core/requirement.ts          需求导入、Define、验收标准
src/core/contract.ts             契约冻结与门禁
src/core/testing.ts              用例目录、八分类、JUnit XML
src/core/acceptance.ts           验收评估、Evidence Bundle、验收报告
src/core/evidence/store.ts       SHA-256 内容寻址证据仓
src/core/runner/local.ts         本地 Runner(SQLite 状态机,可替换)
src/sim/job-model.ts             作业状态机(显式转移表 Oracle)
src/sim/virtual-device.ts        虚拟扫描器/引擎/复印编排与场景
src/platform/rk3588/             Platform Pack 骨架与 Provider 接口 + stub
src/tools.ts / routes.ts         DSH 模型工具与本机同源座舱 API
src/client/                      座舱四视图 UI
src/cli.ts                       fwctl 命令面
```

## 当前边界(Phase 0 后接入)

- RK3588 BSP/SDK 确定版本、交叉工具链与可复现容器镜像(`platform/rk3588/`)。
- 样机 SSH、刷机、救援 Provider(`src/platform/rk3588/providers/board.ts` stub 待替换)。
- 面板 UI 栈对应的 x11vnc / wayvnc / Qt EGLFS VNC 路径。
- 扫描器、打印引擎真实协议与契约版本升级(现用模拟契约 v1)。
- Dagu Runner Spike 决策(`spike/dagu/`,RunnerAdapter 边界已隔离)。
- 真实纸张复印、缺纸、卡纸、门盖、掉电验收 recipe(L4 用例已定义,未执行)。
