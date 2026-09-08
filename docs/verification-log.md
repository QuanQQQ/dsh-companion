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

## 2026-09-08：归档可重建修复与最终制品验证

源码提交：65a031bfde11a322520f80a37667ed34ce73babd。

PDM 归档重建最初因工作区外相对 link 类型依赖失效而报 TS2307。修复为固定的公开 dsh-better-sidebar@0.13.1 开发依赖，并移除仅通过 HTTP 集成的未发布 Task Workspace 的模块依赖声明；仓库固定 npm registry，禁止 node-pty 构建脚本。无脚本安装、全包类型检查、111 项测试（CLI 72 + Plugin 39）和构建全部通过。

PDM 项目 dsh-companion-package-validation 对干净 Git 归档执行重建/打包，把精确 tarball 安装进全新 DSH 后验证健康，时间 2026-09-08T12:20:57.594Z，allowBuilds=[]。临时验证 Host 已由 PDM 自动停止。该结果验证 Companion 制品本身，不代表整个外部插件组合通过干净重建。

组合项目 dsh-companion-production-local 的完整干净重建在 Companion 打包成功后，被参考 Sidebar 的 HEAD 未合入 main 门禁拒绝。没有合并、修改或绕过该参考仓库。组合功能的浏览器证据仍来自现有只读链接依赖；此限制保留在最终制品 manifest。

刷新隔离页面后 Task Services 卡片仍正常加载，已登录 Devices API 和 CLI 下载均为 200。下载的 CLI 与 tarball 内 package/lib/companion-cli.mjs 的 SHA-256 相同：52548ea07021a6a67db46a111d0aa9ee87d0aff4fbe4a62133b9346aacc2ca5a。

最终制品：

- dsh-companion-0.1.0.tgz：aa4397b865f2e77c6466f6a4f2718fe33f081bfbb4c3173a860c6aade1a670b7（PDM 实际验证的文件）。
- dsh-companion-cli-0.1.0.tgz：cba4281e336fcb12c5b590d9fb0d92d541760f92f7fb2248486ea73a51380599。

真实 macOS 发布验收仍未进行，不能声称 Keychain/launchd/Apple SSH 已通过实机验证。稳定 DSH 未部署、未排队、未重启。

## 2026-09-08：0.1.1 修复 Mac 初装误判

用户在真实 Mac 上执行 launchctl print，报告当前 GUI 用户 501 下不存在 dev.deepseek.dsh-companion，退出码为 113。0.1.0 仅识别退出码 3，因而在配对前误报 Existing or unverifiable LaunchAgent。

0.1.1 只在 print 返回 113 且诊断精确匹配请求的服务 label 和 GUI UID 时视为未加载；113 的其他诊断和 bootout 失败不会获得放行。新增测试直接重放用户输出，从同一 setup 报错转为成功，并覆盖错误 UID、错误服务、权限/域错误以及停止安全边界。CLI 75 项、Plugin 39 项测试及类型检查、构建通过。

刷新隔离页面后，下载返回 200，包含 0.1.1 版本和 113 修复，与本地文件 SHA-256 一致：48db29f12a4424888f1df03d51a045f726da47a05a31668bd16d35b889560575。用户需覆盖旧下载并重新执行 setup；此次修复尚未获得用户 Mac 重试成功的证据。未重启或更新稳定 DSH。

## 2026-09-08：0.1.2 修复 OpenSSH 配置键大小写误判

用户随后报告转发阶段 SSH_CONFIG_UNSAFE；其提供的主机、用户、端口、identityfile 和 known_hosts 字段均能通过已有值校验。使用真实系统 ssh -G（-F /dev/null，不建立连接）发现默认输出 canonicalizePermittedcnames 含大写 P，旧解析器只接受全小写键，因而拒绝正常完整输出。

新增混合大小写样本和真实系统 OpenSSH 输出两项端到端执行器测试，均先复现 SSH_CONFIG_UNSAFE，再通过修复。0.1.2 按 SSH 键名不区分大小写的规则归一化键，保持值的大小写和窄白名单；不同大小写的重复 HostName 仍拒绝。CLI 77 项、Plugin 39 项测试、类型检查和打包全部通过。真实 ssh -G 运行于 Linux；隧道 spawn 和归属证据仍是测试替身，不声称 Mac 真实隧道已建立。

隔离页面已刷新，下载返回 200，版本 0.1.2，SHA-256 与本地构建一致：af4dd107adbb9ac01657610f86e7d4e7b93111bf088070af3773a0bcb8ac5c48。现有安装需保留配对地替换固定 Library bundle；仅重新下载不会更新 LaunchAgent 使用的程序。手动更新步骤见 macos-cli-update.md。稳定 DSH 未变更；用户 Mac 更新后转发是否成功仍待确认。

## 2026-09-08：0.1.3 标准一键更新

用户明确拒绝每个版本手工复制 Library 文件和操作 launchctl 的流程。新增 update 子命令，下载新版后固定执行 node "$HOME/Downloads/dsh-companion.mjs" update。重复 setup 且已有设置一致也会转入更新，不再请求或消费配对码。Companion Devices 新增独立下载/复制更新命令区域，无需生成 ticket。

更新器检查私有安装、精确 plist 契约、保存 Node 运行时及安装/候选版本，拒绝降级；暂存和备份后停止已知 LaunchAgent，在 daemon 停止锁内原子替换，启动后检查新版的新 bootId、Device、版本、活 PID 和私有 daemon.lock。本地 ready 不等于 WSS 或隧道在线。替换/启动失败安全回滚；不能确认停止时保留备份和绑定安装身份、哈希的 journal。旧版 0.1.0–0.1.2 回滚只证明 launchctl 注册；极端 SIGKILL 遗留不明锁不自动删除。updater 不写 Keychain/config/runtime-state；实际 daemon 停启可更新 observations，但不由更新器重置预算。

23 项新增更新器测试包括正常更新、同内容幂等、磁盘新版但后台旧版修复、未注册恢复、版本探测失败/降级拒绝、停止失败、原子替换失败回滚、bootstrap/ready 失败回滚、恢复材料保留、7 类无效 ready、原子状态文件替换竞争、并发锁、symlink/模式/归属检查。全量 CLI 105 项、Plugin 39 项通过，类型检查和打包通过；打包 CLI 的 update 分派在 Linux 安全拒绝 macOS 生命周期操作。

刷新现有隔离 GUI，更新面板不依赖 ticket 显示；复制按钮出现成功反馈。读取浏览器剪贴板的自动化请求因权限未完成而超时，已通过导航取消，不宣称验证真实 Mac 剪贴板。下载返回 200，版本 0.1.3，包含完整 updater，SHA-256 与本地构建一致：6c86aaad31cc8cab859c765adc83a301c337e44d5ebe8c5e5e05da2851c2ef4c。真实 Mac 更新仍待用户执行确认。未改 Better Sidebar 源码，未更新或重启稳定 DSH。
