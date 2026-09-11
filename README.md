# DSH Companion

一个 DSH Host/Web 插件和一个 Device CLI（目前支持 macOS），让 Device 上的浏览器访问开发机的 loopback 服务：

```text
Device 127.0.0.1:5173 → SSH → devbox 127.0.0.1:5173
```

两端端口始终相同，只绑定字面量 `127.0.0.1`。不修改 Bifrost、系统代理、浏览器代理或用户 SSH 配置。

## 交付与兼容边界

- `packages/plugin`：`dsh-companion`，Host、Local Services 卡片和 Companion Devices 设置。只消费 Better Sidebar 的公开 `registerTab` 接口。
- `packages/cli`：`dsh-companion-cli`，单文件 JS bundle（包含 ws），统一入口为 launch；保留 setup/install、update、daemon、status、restart、uninstall 兼容命令。
- CLI 要求 macOS 和**外部安装的 Node.js 22+**。没有附带原生 Node 运行时，没有 codesign/notarization，不是无需运行时的独立 App。
- Host 管理接口要求 DSH 的公开 `connection.requestRejection` 登录契约；已在 DSH 0.1.2-rc.1 隔离实例验证。缺失契约时返回 503，而不是降级为匿名管理。
- 服务注册、查询和 Lease 生命周期属于当前 Host 的统一控制面，不依赖 Task Workspace、Agent cwd 或 Session。Better Sidebar 只是卡片容器；其公开 0.13.1 类型是固定开发依赖。
- 自动化验证不能替代真实 Device 的 Apple SSH、Keychain、launchd、睡眠唤醒和断网验收；发布门禁见 [macOS 验收清单](docs/macos-acceptance.md)。

## Device 统一启动入口

1. Device 需要已安装且路径稳定的 Node.js 22+，以及可非交互登录开发机的本机 SSH alias。Host Key 必须由用户核验，Companion 不托管 SSH 私钥。
2. 登录 DSH → Settings → **Companion Devices**，填写 Device 实际可访问的 HTTPS origin，复制“启动命令”。无需手动下载 CLI，也不区分安装或更新。
3. 在 Device 执行，例如：

dsh.example.internal 只是示例，请使用页面生成的真实地址。


```bash
curl --disable -fsS --proto '=https' https://dsh.example.internal/api/companion/bootstrap.sh | bash -s -- https://dsh.example.internal
```

首次运行会询问 SSH alias，显示验证码并打开 DSH。在网页核对该验证码并点击“允许此 Device”，之后自动完成本地安装和启动。配对凭证不经过 argv，写入 macOS Keychain。

之后始终重复同一条命令：脚本获取此 Host 的最新 bundle，校验 SHA-256；本地有效配对则停止已知旧进程、替换并启动，不需要重新授权。Host 不同、权限谱系改变或凭证失效时，会明确请求确认及新的浏览器授权。新授权不继承旧 Lease；网络失败不会被当作重新配对的理由。

地址必须已在 DSH 的 trustedHosts 中，反向代理需支持 WSS。Device 上的 127.0.0.1 指 Device 自己，不是 devbox。HTTP 只默认允许 loopback；可信测试网络可在页面明确勾选 --allow-insecure-http，不会忽略 HTTPS 证书错误。下载哈希保证脚本与 bundle 一致，不能代替 TLS 或来源信任。

### 配对与测试 Host 生命周期

配对和 Authority 保存在 $DSH_HOME/companion/state.json。同一数据目录的普通停止/启动保留它们；另一个管理项目、清空数据或新建测试 Home 属于不同 Host，不能自动接收旧凭证。开发时应固定 PDM 项目 ID 和 Home；干净包验证 Home 不应充当真实 Device 的长期配对环境。

Device 被拒绝认证时关闭自有 SSH，持久显示 needs_pairing，而非把后台存活当作配对成功。重新执行统一命令会校验并恢复；不复制两个 Host 的数据库、不恢复已撤销的授权。Device 卡片中的 CLI 版本来自最近一次成功认证的 `device.hello`；Device 升级后须至少连接一次才会刷新。

详细恢复边界见 [统一启动与恢复](docs/macos-cli-update.md)。旧 setup/update 命令仅保留兼容用途，不是推荐用户入口。

## Local Services

在 Better Sidebar 的 New tab 菜单打开 **Local Services**。每个 Session 看到同一个 Host 全局列表。

- 注册服务只声明名称、端口和协议，**不授权转发**。同一 Host 端口只有一个活跃声明；再次注册该端口会刷新原声明，而不是创建 Task 副本。
- 选择明确 Device，再创建 TTL-bound Forward Lease。默认和最长 TTL 都是一周（7 天）；AI 的 `ttl_minutes` 范围为 1–10080，省略时为 10080。已有 Lease 不因升级、重复打开、重新检查或重启而续期。
- 到期或停止后可直接“重新开启转发”。操作创建新 Lease，并等待同一 Device、同一端口的旧 Lease 关闭 ACK；旧 generation、到期时间和 tombstone 均保留。
- Preferred Device 只是 UI 默认选择，不授权、不迁移，也不故障转移。一个 Device 的本地端口全局独占；冲突不会换端口或终止未知进程。
- 卡片展示 Desired/Observed、generation、Device WSS、SSH child、Listener ownership 和可选 Remote TCP probe。Listener 存在不等于应用健康。
- 重启通过 close ACK → 新 generation open，保留 Lease ID 和原始到期时间。
- Task、Session 结束或 Task 归档都不关闭 Lease。撤销 Device、注销服务或 TTL 到期会关闭对应授权。
- WSS 失联会先关闭 Companion 自有 SSH。重连后 Host 根据全局 Desired State 下发新的 fenced Open，使仍有效的 Lease 自动恢复；不会自行创建、迁移或续期授权。

AI 工具仍保留 `task_service_register`、`task_service_unregister`、`task_forward_open`、`task_forward_close`、`task_forward_list`、`task_forward_restart` 名称以兼容既有 Agent，但 `task_` 前缀不再表示 Task scope。工具不解析 Agent cwd，也不接受任意 SSH 命令、远端地址或参数。

当前 Host 使用 state schema v2。首次读取 v1 状态时，会按端口把 Task 声明折叠为全局声明，保留最新活跃声明的名称和协议，并把既有 Lease 关联到该声明；迁移结果会原子写回。管理入口为 `GET /api/companion/snapshot`、`POST /api/companion/services` 以及 `/api/companion/services/:serviceId/...`。`/tasks/:taskId/...` 路径仅供缓存客户端兼容，其中 `taskId` 不参与权限或数据筛选。

### 停止转发与注销服务

- `task_forward_close({ lease_id })` / 卡片“停止转发”：仅撤销指定 Lease，服务声明和其他 Device 的 Lease 保留。重复请求不增加关闭代次。
- `task_service_unregister({ service_id })` / 卡片“注销服务”：原子归档全局声明并关闭其所有 Device 的 Open Lease；保留关闭 tombstone、命令及观测。重复注销不创建新关闭代次。
- 两项操作都不终止 devbox 应用、不撤销 Device 配对、不修改 SSH 配置。注销后重新注册相同端口会生成新 service id，不继承旧授权。
- API 返回 Closed 表示授权已撤销，不代表 Device 已停止端口。`task_forward_list` 中 `close_confirmed` 只有在当前 generation 观测到 closed、SSH exited、listener missing 时为 true。注销后的 Lease 仍可查询。
- 离线 Device 在重连时对账关闭，不允许旧 Open 命令复活。

## 运维与恢复

```bash
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" status
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" restart
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" uninstall
```

控制通道的普通网络故障持续退避重连，没有次数上限；间隔指数增长并带抖动，最长 30 秒。Host 心跳默认每 15 秒一次，连续约三个周期无消息即断开并重连。Device 睡眠期间允许离线，唤醒后检查失效连接和已过期的重连计时；不修改系统睡眠设置。稳定连接一分钟后重置控制通道退避级别。

`SSH_EXITED`、启动/命令超时、链路丢失和 listener 丢失等 Forward Instance 瞬态故障也持续退避重试，最长间隔 30 秒；成功后连续失败计数归零。Host 持续重发未确认的幂等 operation，并在每次新 Connection Session 收到 `recovering` 快照后重新下发 fenced Open。有效 Lease 的普通瞬态恢复没有固定次数预算。

配对拒绝、Authority 改变、证书/协议错误、控制会话被替换，以及本地凭证、状态持久化或 SSH 清理失败仍需人工处理。SSH 认证、Host Key、端口冲突、策略拒绝、Device 撤销与 Lease 到期也不会自动绕过。普通网络故障不触发重新配对；重试从不创建新 Lease、迁移 Device、变更端口或延长 TTL。

status 包含本地持久快照，不是实时健康证明；显示最后连接/断线时间、受限原因码、HTTP/关闭码、是否阻断控制通道自动重试和下次重连时间，不记录原始错误、响应正文或凭证。“立即重试/重新检查”只用于人工加速或永久错误处理，不再是普通断线后的必要恢复步骤。

用户数据：`~/Library/Application Support/DSH Companion/`；日志：`~/Library/Logs/DSH Companion/`；LaunchAgent：`~/Library/LaunchAgents/dev.deepseek.dsh-companion.plist`。卸载先停止自有 LaunchAgent，再删除本地凭证/配置/bundle/runtime 状态，保留日志/control 目录；**不会代替 DSH 中的 Device 撤销**。

SSH alias 只支持字母/数字/点/横线/下划线，不支持任意 `user@host`。用户在 Device 选择本机已有 alias；系统 OpenSSH 原生读取用户与系统 SSH 配置，处理 Include、Match、ProxyCommand、ProxyJump、密钥、Agent、GSSAPI 和 KnownHostsCommand。Companion 不运行 ssh -G，不解析或重写配置，不识别 Kerberos 模板，也不直接调用 klist/kinit。

连接/认证语义复用用户手动 SSH 的配置，但后台转发角色有明确边界：

- 独立的 foreground master 和私有 ControlPath，不复用、接管或关闭用户已有 master。
- BatchMode、无 TTY、无远程命令及 LocalCommand、Agent/X11/TUN 转发；主连接严格校验 Host Key。需要首次登录或交互认证时，先在 Device 终端完成认证。
- 主连接用 ClearAllForwardings 清除其配置中的 LocalForward/RemoteForward/DynamicForward；认证后通过不读取配置的控制请求，仅添加 Lease 指定的同端口 IPv4 loopback 转发。ClearAllForwardings 也会清除 CLI 的 -L，因此连接和添加 listener 分成两步。
- 控制响应不单独证明成功：还必须验证私有 socket、master PID 及该 PID 的唯一指定 listener。默认总启动期限 30 秒；失败或取消须先完成清理。
- 正常停止向当前存活、由本执行器创建的独立进程组发送 TERM，必要时 KILL。master 已退出后不再按其旧 PGID 发信号；无法确认退出时保留证据并报告清理失败。崩溃恢复只向已验证的私有 control socket 发送 exit，不按磁盘保存的 PID/PGID 强杀进程；V2 记录允许回收认证完成但尚未添加 listener 的 master。

用户的本机 SSH 配置属于可信代码：其中的 ProxyCommand、Match exec 等可以像手动 SSH 一样运行本机程序，并有其自身副作用。Host 无权下发这类配置或命令。Companion 不承诺约束自定义脚本主动 daemonize、脱离进程组或管理外部服务的行为，也不替用户管理脚本启动的独立后台服务。这是原生 SSH 兼容，不是脚本沙箱。

## 构建与测试

Linux 原生集成测试需要系统 openssh-server、ssh-keygen 和 lsof；测试创建临时 loopback sshd 与临时密钥，不使用个人 SSH 密钥或修改 ~/.ssh/config。Device 跳过这组 Linux 隔离测试，真实 Device 转发另行验收。

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

CLI：`packages/cli/lib/cli.mjs`。插件内下载产物：`packages/plugin/lib/companion-cli.mjs`。插件构建从同一仓库 CLI 源码生成下载文件，不在运行时下载 npm 包或远端代码。不要将“可构建”或 Linux fake SSH 测试当作 macOS 生产验收。

稳定 DSH 安装、升级和重启必须通过 PDM 的稳定更新队列/idle gate。此仓库的隔离验证不授权更改稳定 Host。
