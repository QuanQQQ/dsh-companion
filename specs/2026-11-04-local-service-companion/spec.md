# Local Service 与 Companion 一体化

## 目标与交付边界

面向 DSH 0.2.1-rc.5，在 Companion monorepo 中交付 Linux 开发服务管理、现有 Mac Companion 转发与原生 Local Services 侧栏的一体化源码和自动化测试。基线为 Companion main `6a8948d68d5006d8d4092b7867086ffa9c2a5d01`。

独立 package `packages/dev-services` 从非 Git dev-services 的源代码和测试迁入，保留独立 systemd user transient unit 监督。Mac 继续使用 Companion Keychain、配对、WSS 和独立同端口 SSH，不引入另一 helper，不管理 Codex 的连接。

交付包含完成原生UI与执行授权、Astra审查、工程与浏览器验证、提交并合入源码、在既有3090常驻DSH中安装插件，以及清理临时开发副本。保留独立位置的正式Git仓库、源码历史和安装包，清理工作副本不删除源码唯一副本。既有3080及实际配对/runtime数据保持；真实Mac注册、设备选择、授权和升级不自动执行。安装前备份配置与状态，失败可恢复。验收使用自有测试服务，不停止无关应用。

## 核心规则

- 服务定义持久保存实际 executable、字面值 args、固定端口和 canonical workdir。普通 Runtime Workspace 为归属依据；Agent 不能以 cwd 或用户提供 ID 伪造 Workspace 权限。
- 全局可展示服务。Agent 修改受真实所属 Workspace 限制；owner-browser 的明确面板操作与 Agent scope 分离。跨 Workspace 修改没有隐式权限。独立服务 launch 仍要求当前 sandboxPolicy danger-full-access，不用面板/API 代低权限 Agent执行。
- Linux 进程运行、owned listener + 主动 IPv4 loopback TCP connect、应用业务健康分层报告。端口占用不证明归属；未知 PID/端口不终止。长编译超过有限 readiness 等待保持自有进程和 running 意图，返回 starting/not_ready，可继续读日志。
- managed declarations 由单个 CompanionService 所在 Host 暴露 ensure/retire。owner 固定为 provider + namespace + service-id；不能接管人工声明，迟到 ensure 不复活 retire tombstone。该 capability 不批准配对、不选择设备、不创建 Lease。
- 注册/启动不自动授权转发。“启动并转发”是明确复合操作，Linux owned ready 后申请指定设备 Lease。首次必须明确选择设备并授权 TTL；只复用已经明确保存的偏好。即使只有一台设备也不隐式选择，多设备不切换或 failover。
- Lease 默认和最长均为 7 天，重复 open/recheck 不续期。组合结果分开表示无配置、待选择、离线、等待确认、失败和 ready。ready 要求 online Device、同 generation、新鲜观测、SSH running、listener owned 和主动本地转发 TCP probe；不声称应用业务健康。
- 关闭意图与确认分开。确认要求同 generation closed、SSH exited、listener missing；离线意图不能当作已关闭。
- rc.5 requestRejection 接受 signed API/live Peer，不等于人类批准。配对 ticket、enrollment 审批/拒绝和 owner 面板变更只允许公开 trust/auth 契约证明的 owner-browser；匿名、API Peer、跨站 fail closed。保留 Host/Origin/Fetch-Metadata 防护。
- SQLite 和 Companion state 不重置。迁移先验证并备份；Task→Workspace 不可证明归属的旧记录标为 unclaimed，仅 owner 明确 claim 后允许 Workspace Agent 管理。迁移错误可诊断且保留原数据。
- 安全 snapshot 不返回 executable/args/env/credential。仅owner-browser的启动review可读取固定命令、目录和端口；显式确认配置digest后，Host签发只在该请求内有效的不可序列化proof，启动前重新校验配置和浏览器认证。Agent仍受原sandboxPolicy约束。日志有界并提示其可能含应用自身敏感输出。

## UI

原生右侧栏 Local Services：紧凑卡片同屏显示名称、端口、Workspace 标签、Linux 状态和 Mac 摘要，操作行提供启动、启动并转发、停止、重启、日志、设置和移除。日志与设备/TTL设置使用弹窗。空态链接现有 Companion Devices 设置，不复制配对页。全局服务的其他 Workspace 标签保持明显，跨 Workspace操作需要 owner 明确动作。

## 现有链路与缺口

- Companion Host 入口依赖已移除的 webRuntime.trustedHosts；client依赖 Better Sidebar。
- managedOwner 被 v3 store 保留，但 main 未提供 managed capability。
- dev-services 工具依赖旧 Task API；readiness 超时会 stop；health 只校验 inode，未主动 connect。
- Mac controller 将成功 remoteProbe 写为 disabled，不能证明实际转发数据路径。

## Review 与未验证

范围已由用户/leader确认，自主完成实现细节；重要授权默认、迁移取舍或实际接口缺口即时报告。内存整组保护不属于本次核心范围，不扩展进程后台；列为后续。

真实 PDM Web 交互、Mac launchd/Keychain/休眠、两设备同端口数据路径验收为后续未验证，不以 mock/Linux fixture 替代。
