# DSH Companion

一个 DSH Host/Web 插件和一个 macOS CLI，让 Mac Chrome 访问开发机 Task 的 loopback 服务：

```text
Mac 127.0.0.1:5173 → SSH → devbox 127.0.0.1:5173
```

两端端口始终相同，只绑定字面量 `127.0.0.1`。不修改 Bifrost、系统代理、浏览器代理或用户 SSH 配置。

## 交付与兼容边界

- `packages/plugin`：`dsh-companion`，Host、Task Services 卡片和 Companion Devices 设置。只消费 Better Sidebar 的公开 `registerTab` 接口。
- `packages/cli`：`dsh-companion-cli`，单文件 JS bundle（包含 ws），统一入口为 launch；保留 setup/install、update、daemon、status、restart、uninstall 兼容命令。
- CLI 要求 macOS 和**外部安装的 Node.js 22+**。没有附带原生 Node 运行时，没有 codesign/notarization，不是无需运行时的独立 App。
- Host 管理接口要求 DSH 的公开 `connection.requestRejection` 登录契约；已在 DSH 0.1.2-rc.1 隔离实例验证。缺失契约时返回 503，而不是降级为匿名管理。
- Task Workspace 必须由 DSH profile 单独安装并提供公开 HTTP Task API；它不是本包的 JavaScript 模块依赖，也不要求其名称已发布到 npm。Better Sidebar 是卡片容器；其公开 0.13.1 类型是固定开发依赖，源码构建不依赖工作区外的参考目录。
- 自动化验证不能替代真实 Mac 的 Apple SSH、Keychain、launchd、睡眠唤醒和断网验收；发布门禁见 [macOS 验收清单](docs/macos-acceptance.md)。

## Mac 统一启动入口

1. Mac 需要已安装且路径稳定的 Node.js 22+，以及可非交互登录开发机的本机 SSH alias。Host Key 必须由用户核验，Companion 不托管 SSH 私钥。
2. 登录 DSH → Settings → **Companion Devices**，填写 Mac 实际可访问的 HTTPS origin，复制“启动命令”。无需手动下载 CLI，也不区分安装或更新。
3. 在 Mac 执行，例如：

dsh.example.internal 只是示例，请使用页面生成的真实地址。


```bash
curl --disable -fsS --proto '=https' https://dsh.example.internal/api/companion/bootstrap.sh | bash -s -- https://dsh.example.internal
```

首次运行会询问 SSH alias，显示验证码并打开 DSH。在网页核对该验证码并点击“允许此 Mac”，之后自动完成本地安装和启动。配对凭证不经过 argv，写入 macOS Keychain。

之后始终重复同一条命令：脚本获取此 Host 的最新 bundle，校验 SHA-256；本地有效配对则停止已知旧进程、替换并启动，不需要重新授权。Host 不同、权限谱系改变或凭证失效时，会明确请求确认及新的浏览器授权。新授权不继承旧 Lease；网络失败不会被当作重新配对的理由。

地址必须已在 DSH 的 trustedHosts 中，反向代理需支持 WSS。Mac 上的 127.0.0.1 指 Mac 自己，不是 devbox。HTTP 只默认允许 loopback；可信测试网络可在页面明确勾选 --allow-insecure-http，不会忽略 HTTPS 证书错误。下载哈希保证脚本与 bundle 一致，不能代替 TLS 或来源信任。

### 配对与测试 Host 生命周期

配对和 Authority 保存在 $DSH_HOME/companion/state.json。同一数据目录的普通停止/启动保留它们；另一个管理项目、清空数据或新建测试 Home 属于不同 Host，不能自动接收旧凭证。开发时应固定 PDM 项目 ID 和 Home；干净包验证 Home 不应充当真实 Mac 的长期配对环境。

Mac 被拒绝认证时关闭自有 SSH，持久显示 needs_pairing，而非把后台存活当作配对成功。重新执行统一命令会校验并恢复；不复制两个 Host 的数据库、不恢复已撤销的授权。

详细恢复边界见 [统一启动与恢复](docs/macos-cli-update.md)。旧 setup/update 命令仅保留兼容用途，不是推荐用户入口。

## Task Services

选择当前 Task 的会话，在 Better Sidebar 的 New tab 菜单打开 **Task Services**。

- 注册服务只声明 Task、名称、端口和协议，**不授权转发**。
- 选择明确 Device，再创建 TTL-bound Forward Lease。Host 插件 0.1.10 起默认一周（7 天），最长一周；AI 的 `ttl_minutes` 范围为 1–10080，省略时为 10080。页面保留 30 分钟、2 小时、8 小时、24 小时和一周选项。
- 新默认值只影响新建 Lease；已有 Lease 的到期时间不会因升级、重复打开、重新检查或重启而延长。需要更长授权时，停止原 Lease 后显式重新创建。
- Preferred Device 只是 UI 默认选择，不影响授权、迁移或故障转移。
- 一个 Device 的本地端口全局独占；冲突不会换端口，也不会杀未知占用进程。
- 卡片内“诊断详情”展示 Desired/Observed、generation、Device WSS、SSH child、Listener ownership 和可选 Remote TCP probe。CLI 的远端 TCP probe 关闭，不能把监听成功描述成应用健康。
- 重启通过 close ACK → 新 generation open，保留 Lease ID 和原始到期时间。
- Session 结束不关闭 Lease；归档 Task、撤销 Device、TTL 到期会关闭。
- WSS 失联关闭自有 SSH；重连先上报快照，再等待 Host 对账授权，不自行复活旧命令。

AI 工具包括 `task_service_register`、`task_service_unregister`、`task_forward_open`、`task_forward_close`、`task_forward_list`、`task_forward_restart`，从调用 Agent 的 cwd 精确解析所属 Task，不提供任意 SSH 命令、远端地址或参数执行能力。

### 停止转发与注销服务

这些工具和页面操作由 Host 插件 0.1.9 提供，沿用协议 v1；Mac CLI 0.1.8 无需为此升级。

- `task_forward_close({ lease_id })` / 卡片“停止转发”：仅撤销指定 Lease，服务声明和其他 Device 的 Lease 保留。重复请求不增加关闭代次。
- `task_service_unregister({ service_id })` / 卡片“注销服务”：原子归档当前 Task 的声明并关闭其所有 Device 的 Open Lease；保留关闭 tombstone、命令及观测。页面要求确认全部 Device 的影响。重复注销不创建新关闭代次。
- 两项操作都不终止 devbox 应用、不撤销 Device 配对、不修改 SSH 配置。重新注册相同端口会生成新 service id，不继承旧授权。
- API 返回 Closed 表示授权已撤销，不代表 Mac 已停止端口。`task_forward_list` 中 `close_confirmed` 只有在当前 generation 观测到 closed、SSH exited、listener missing 时为 true。注销后的 Lease 仍可查询，页面“已注销服务的转发关闭记录”保留待确认状态和重新检查入口。
- 离线 Device 在重连时对账关闭，不允许旧 Open 命令复活。Task 已归档也允许 AI 查询、停止及注销，但不允许新增转发。
- Host 管理路由 `POST /api/companion/tasks/:taskId/services/:serviceId/unregister` 要求已认证、可信来源的 JSON 请求；与 AI 工具一样校验服务所属 Task。

## 运维与恢复

```bash
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" status
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" restart
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" uninstall
```

status 包含本地持久快照，不是实时健康证明。restart 只重启进程，**不重置持久重连预算**。WSS 五次重试耗尽后停止自动重试；用户主动重跑统一命令，在验证原配对有效后显式触发重连，不重置 Forward Instance 的持久重试预算。daemon 支持 SIGHUP 请求重新连接。不得对未经核实的 PID 发信号。转发瞬态故障初次失败后最多五次自动重试；认证、Host Key、端口冲突、未知策略错误需人工处理。显式重新检查允许一次尝试，不重置累计预算。

用户数据：`~/Library/Application Support/DSH Companion/`；日志：`~/Library/Logs/DSH Companion/`；LaunchAgent：`~/Library/LaunchAgents/dev.deepseek.dsh-companion.plist`。卸载先停止自有 LaunchAgent，再删除本地凭证/配置/bundle/runtime 状态，保留日志/control 目录；**不会代替 DSH 中的 Device 撤销**。

SSH alias 只支持字母/数字/点/横线/下划线，不支持任意 `user@host`。用户在 Mac 选择本机已有 alias；系统 OpenSSH 原生读取用户与系统 SSH 配置，处理 Include、Match、ProxyCommand、ProxyJump、密钥、Agent、GSSAPI 和 KnownHostsCommand。Companion 不运行 ssh -G，不解析或重写配置，不识别 Kerberos 模板，也不直接调用 klist/kinit。

连接/认证语义复用用户手动 SSH 的配置，但后台转发角色有明确边界：

- 独立的 foreground master 和私有 ControlPath，不复用、接管或关闭用户已有 master。
- BatchMode、无 TTY、无远程命令及 LocalCommand、Agent/X11/TUN 转发；主连接严格校验 Host Key。需要首次登录或交互认证时，先在 Mac 终端完成认证。
- 主连接用 ClearAllForwardings 清除其配置中的 LocalForward/RemoteForward/DynamicForward；认证后通过不读取配置的控制请求，仅添加 Lease 指定的同端口 IPv4 loopback 转发。ClearAllForwardings 也会清除 CLI 的 -L，因此连接和添加 listener 分成两步。
- 控制响应不单独证明成功：还必须验证私有 socket、master PID 及该 PID 的唯一指定 listener。默认总启动期限 30 秒；失败或取消须先完成清理。
- 正常停止向当前存活、由本执行器创建的独立进程组发送 TERM，必要时 KILL。master 已退出后不再按其旧 PGID 发信号；无法确认退出时保留证据并报告清理失败。崩溃恢复只向已验证的私有 control socket 发送 exit，不按磁盘保存的 PID/PGID 强杀进程；V2 记录允许回收认证完成但尚未添加 listener 的 master。

用户的本机 SSH 配置属于可信代码：其中的 ProxyCommand、Match exec 等可以像手动 SSH 一样运行本机程序，并有其自身副作用。Host 无权下发这类配置或命令。Companion 不承诺约束自定义脚本主动 daemonize、脱离进程组或管理外部服务的行为，也不替用户管理脚本启动的独立后台服务。这是原生 SSH 兼容，不是脚本沙箱。

## 构建与测试

Linux 原生集成测试需要系统 openssh-server、ssh-keygen 和 lsof；测试创建临时 loopback sshd 与临时密钥，不使用个人 SSH 密钥或修改 ~/.ssh/config。Mac 跳过这组 Linux 隔离测试，真实 Mac 转发另行验收。

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

CLI：`packages/cli/lib/cli.mjs`。插件内下载产物：`packages/plugin/lib/companion-cli.mjs`。插件构建从同一仓库 CLI 源码生成下载文件，不在运行时下载 npm 包或远端代码。不要将“可构建”或 Linux fake SSH 测试当作 macOS 生产验收。

稳定 DSH 安装、升级和重启必须通过 PDM 的稳定更新队列/idle gate。此仓库的隔离验证不授权更改稳定 Host。
