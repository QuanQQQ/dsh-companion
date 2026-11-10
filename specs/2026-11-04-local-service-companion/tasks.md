# Local Service与Companion交付任务

| ID | 交付单元 | 状态 | 验证依据 |
| --- | --- | --- | --- |
| T1 | rc.5原生认证、Workspace与侧栏契约 | 已核实 | 原生SDK类型/实现；Astra审查 |
| T2 | 独立dev-services包与Workspace迁移 | 已实现并定向验证 | 33项常规测试通过，5项条件测试由12项真实systemd/health测试覆盖 |
| T3 | Linux持久unit、owned listener与readiness | 已验证 | 真实systemd监督、Host卸载存活、进程后代停止 |
| T4 | owner-browser认证、私有启动审批与managed服务权限 | 已验证 | 真实HTTP/SQLite facade、Cordis provider、API Peer拒绝、stale digest和跨Workspace回归 |
| T5 | Device TCP probe、新鲜度及关闭确认 | 源码与fixture验证通过 | CLI186项测试；真实Mac后续验证 |
| T6 | 显式设备/TTL及复合启动转发 | 已实现并定向验证 | Workspace边界与取消后不产生授权；真实Device后续验证 |
| T7 | 原生Local Services侧栏和命令review | 浏览器验证中 | 隔离DSH_HOME，仅测试自有服务 |
| T8 | Astra审查、类型/构建/安装包 | 已通过工程检查 | Companion109项、CLI186项、dev-services33项、真实systemd12项；三包0.2.0-rc.1 |
| T9 | 真实Mac与两设备实际数据路径 | 未执行 | 不从Linux fixture推断真实设备可用性，不自动注册/授权设备 |
| T10 | 提交、合入、安装常驻新版、清理临时worktree | 待执行 | 完成验收后保留正式Git源码、历史及可恢复归档 |
