# 验证记录

## 2026-09-08：Linux 与隔离 DSH 联调

环境：Node 22，pnpm 11；PDM 管理的独立 DSH 0.1.2-rc.1，项目 `dsh-companion-production-local`，URL `http://127.0.0.1:3083`。该实例不是稳定 `:3080`。

已取得证据：

- 全包 TypeScript 检查和构建通过；单文件 CLI 的 --help/--version 可执行，ws 已打入 bundle。
- Host/CLI 通过真实本机 HTTP/WebSocket 互通，Device 侧使用真实严格 parser、RuntimeStore、ForwardController；只有 SSH executor 为 fake。
- Host 配对、初始 list 屏障、close ACK 后 restart、TTL 保持、Device 撤销、状态落盘后的旧命令重放均有回归。
- CLI 固定 argv、Keychain stdin 转义/长度限制、安装失败回滚、文件权限、重复安装、LaunchAgent 参数、归属校验、有限重试、断线异步竞态、到期取消、陈旧锁并发回收均有自动化测试。
- 浏览器实际打开 Better Sidebar → New tab → Task Services，解析验收 Task；注册 Acceptance Vite:5173 并展开卡片内诊断。
- 浏览器实际打开 Settings → Companion Devices 并生成一次性配对码，显示本次 CLI 下载及不含配对 secret 的 setup 命令。
- 无浏览器 cookie 的 /api/companion/devices 与 CLI 下载返回 401；已登录浏览器返回 200。
- 独立实例重启后浏览器登录保持，Task Service 保留。

限制和异常：

- 直接以 registry 依赖创建开发实例，被 node-pty@1.1.0 的生命周期构建审批阻止。没有批准或执行该脚本；联调改用工作区已有、只读且已构建的 Better Sidebar/Task Workspace 参考包。
- Task Workspace 0.2.5 参考 Web 的“New Session for Task”在 Runtime 0.1.2-rc.1 调用已不存在的 workspaces.startSession。未修改参考源码；通过 DSH 原生 Choose workspace 选择同一个 Task 可建立验收会话。
- 主机刚启动时 Task Workspace 路由尚未注册，周期对账可短暂报 unavailable；后续路由就绪可恢复，不降级为猜测 Task。
- 未在真实 Mac 执行 /usr/bin/security、launchctl 或 Apple /usr/bin/ssh；未完成浏览器 localhost 到实际 devbox 服务的 Mac 端验收。
- spawn 到 owner metadata 落盘的崩溃窗口依赖 launchd 的进程组清理；recoverAll 对缺失或损坏记录失败关闭，不凭未知 PID 杀进程。此行为需要真实 Mac 故障注入证据。
- 没有稳定 profile 更改、稳定更新排队或稳定 Host 重启。

自动化测试数量会随回归补充增长；发布制品应绑定打包时的检查输出与 SHA-256，而不是依赖这份中间记录的固定计数。
