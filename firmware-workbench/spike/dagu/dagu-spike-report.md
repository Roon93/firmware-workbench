# Dagu Runner Spike 报告(方案 18.3 / phase-0 第 8 节)

> 日期:2026-08-28 · 时间盒:半个工作日(计划 2-3 天,提前收敛)
> 版本:Dagu v2.15.4(windows_amd64)· OS:Windows 11 x64 · 执行目录:`spike/dagu/`
> 结论:**延后整体采用;保留 RunnerAdapter 边界;MVP 使用 Local Runner(SQLite 状态机)**

## 1. 验证结果(phase-0 第 8 节七项)

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 两个无依赖构建任务并行 | 通过 | `spike-parallel.yaml`:build-a / build-b 同一秒启动,max_active_steps: 4 |
| 2 | 测试等待其开发任务完成 | 通过 | unit-test-waits-a 以 `depends: [build-a]` 在 build-a 成功后启动 |
| 3 | 设备占用排队 | 部分通过 | `max_active_steps: 1` 提供全局并发排队;**没有按"资源"的细粒度排队**(复合资源、锁模式、原子获取是工作台调度器语义,Dagu 无此概念) |
| 4 | 基础设施失败重试、产品失败不重试 | 不满足 | `retry_policy` 对**任何**非零退出都重试(spike-retry.yaml:产品失败也被重试 3 次)。方案 11.4"产品断言失败不自动重试到通过"必须在 Adapter 层实现(exit code 约定)或由工作台控制重试 |
| 5 | 人工验收任务暂停签核 | 通过 | `action: human.task` 原生支持:DAG 进入 Waiting,`dagu human-task complete --run-id=... --step=review <dag-name>` 签核后恢复(Queued)。注意 DAG 标识须用名称而非路径 |
| 6 | 取消后子进程/租约/临时文件清理 | 通过 | `dagu stop` 经 socket 停止运行(run-id 级);长任务 30s 在 stop 后终止 |
| 7 | 重启后状态恢复 | 通过 | run 历史持久化在本地存储,stop 后 `status` 仍可查询;工作台约定 SQLite 仍是事实索引,Dagu 数据只作执行层缓存 |

## 2. Windows 运行注意事项(实施时规避)

1. 命令经 PowerShell 执行:子进程 PATH 不继承 bash 会话;在 DAG `env:` 中显式注入 PATH。
2. `command:` 值含嵌套双引号时 YAML 解析易错;推荐 env 注入 + 单引号脚本。
3. 2.x 要求 snake_case 键(如 `max_active_steps`、`retry_policy.interval_sec` 必填)。
4. 二进制下载:GitHub 直连失败,经 `ghfast.top` 镜像取得(51MB);离线环境需提前归档到 `spike/dagu/bin/`。

## 3. Runner 决策

**决策:延后采用 Dagu;MVP 执行内核 = Local Runner(`src/core/runner/local.ts`,SQLite 状态机);`RunnerAdapter` 边界保留。**

理由:

1. 方案 11.4 的失败分类重试规则与方案 9.4 的原子资源租约是工作台核心语义,Dagu 不原生支持,双状态源(工作台 SQLite + Dagu 存储)同步成本高于收益。
2. MVP 纵向切片(模拟闭环)是短任务、单机、即时调度,Local Runner 已完整覆盖且 17/17 测试通过。
3. Dagu 的优势(持久重试、Web 观测、计划调度、human.task)在真机阶段(演进路线第 2 步:内部可用版)价值更大,届时可将 L3/L4 长任务下放 Dagu 执行。

## 4. 重新启用 Dagu 的触发条件与验收清单

触发:出现长时间运行任务(整批回归 >30 分钟)、需要计划预约(长期可靠性测试)、或需要独立于工作台进程的执行恢复时。

验收清单(接 `RunnerAdapter`):

- [ ] Adapter 将工作台任务的 infra/产品失败语义映射为 Dagu exit-code 约定(产品失败以特定退出码表达且 retry_policy 禁用)。
- [ ] 资源租约仍由 Workbench Broker 原子发放,Dagu 步骤只消费已持有的租约令牌。
- [ ] human.task 与 DSH 审批打通(签核动作双写工作台门禁表)。
- [ ] 取消/超时后工作台侧租约释放与设备清理得到验证(参照 phase-0 第 8 节 6 项)。
- [ ] Dagu 重启后,以工作台 SQLite 为准对账运行状态。

## 5. 产物清单

- `dags/spike-parallel.yaml`:并行 + 依赖(1/2 项)
- `dags/spike-retry.yaml`:重试语义(4 项)
- `dags/spike-queue.yaml`:并发排队 + 取消(3/6 项)
- `dags/spike-gate.yaml`:human.task 人工门禁(5 项)
- `results/`:运行日志
- `bin/dagu.exe`:v2.15.4 二进制(不入发布包)
