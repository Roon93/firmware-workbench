# 打印机固件智能开发工作台

基于 DeepSeek Harness 的单台 RK3588 打印机固件研发工作台(MVP:模拟闭环)。
从一个原始需求开始,完成 Define、契约门禁、任务 DAG 并行开发、分层测试、虚拟整机集成、异常恢复和证据化验收报告。

- 总体方案:[printer-firmware-workbench-solution-v1.0.md](printer-firmware-workbench-solution-v1.0.md)
- 详细说明:[firmware-workbench/README.md](firmware-workbench/README.md)

## 仓库结构

```
├─ printer-firmware-workbench-solution-v1.0.md   # 总体方案说明书 v1.0(评审基线)
├─ firmware-workbench/                           # 工作台源码工程(DSH 插件 + fwctl CLI)
│  ├─ src/core/      # Workbench Core:需求/DAG/租约/契约/测试/证据/验收
│  ├─ src/sim/       # 虚拟设备:作业状态机 Oracle + 扫描器/引擎模拟
│  ├─ src/client/    # 座舱 UI(七视图 + 演示中心)
│  ├─ src/platform/rk3588/   # Platform Pack 骨架 + 真机 Provider stub
│  ├─ spike/dagu/    # Dagu Runner Spike(报告 + 最小工作流)
│  └─ docs/          # Phase 0 事实冻结清单、UI 设计文档
└─ dsh-env/                          # 成品组装(运行时需按说明落地,不入库)
   ├─ 启动工作台.cmd / 停止工作台.cmd
   └─ tools/           # start/stop/pack 脚本(DSH host + profile 一键运行)
```

## 快速开始

要求 Windows、Node.js 24.11+、pnpm 10+。

```powershell
# 1) 源码构建与测试
cd firmware-workbench
pnpm install
pnpm test          # 18/18 通过
node lib/cli.js demo-verify --db work/demo.db   # 模拟闭环一条龙(L1 验收 PASS)

# 2) 图形界面
#    先组装 DSH 环境:npm 安装 @deepseek-ai/dsh@0.1.1-rc.2 到 dsh-env/runtime/dsh,
#    Node 24 运行时放 dsh-env/runtime/node,插件 tgz 放 dsh-env/packages(见 firmware-workbench/README.md)
#    然后:
dsh-env\启动工作台.cmd            # 浏览器自动打开 http://127.0.0.1:3081,右下角"进入工作台"
```

## 当前能力与边界

- ✅ 模拟闭环:需求导入(可输入自定义需求)→ Define 评审(G1)→ 契约冻结(G3)→ 五路并行开发 → 自测 → 虚拟复印 → 异常恢复 6 场景 → PASS L1 证据化验收
- ✅ 资源租约、任务 DAG、审计事件、内容寻址证据包;引导操作 + 自动演示双模式
- ⏸ 真机层(L4)诚实排队:RK3588 BSP、刷机/救援、VNC、扫描器/引擎契约待 [Phase 0 事实冻结](firmware-workbench/docs/phase-0-fact-freeze-checklist.md) 后接入

## License

MIT
