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
- 选择明确 Device，再创建 TTL-bound Forward Lease。默认 2 小时，最长 8 小时。
- Preferred Device 只是 UI 默认选择，不影响授权、迁移或故障转移。
- 一个 Device 的本地端口全局独占；冲突不会换端口，也不会杀未知占用进程。
- 卡片内“诊断详情”展示 Desired/Observed、generation、Device WSS、SSH child、Listener ownership 和可选 Remote TCP probe。CLI 的远端 TCP probe 关闭，不能把监听成功描述成应用健康。
- 重启通过 close ACK → 新 generation open，保留 Lease ID 和原始到期时间。
- Session 结束不关闭 Lease；归档 Task、撤销 Device、TTL 到期会关闭。
- WSS 失联关闭自有 SSH；重连先上报快照，再等待 Host 对账授权，不自行复活旧命令。

AI 工具限定为 `task_service_register`、`task_forward_open`、`task_forward_list`、`task_forward_restart`，从调用 Agent 的 cwd 精确解析所属 Task，不提供任意 SSH 命令、远端地址或参数执行能力。

## 运维与恢复

```bash
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" status
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" restart
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" uninstall
```

status 包含本地持久快照，不是实时健康证明。restart 只重启进程，**不重置持久重连预算**。WSS 五次重试耗尽后停止自动重试；用户主动重跑统一命令，在验证原配对有效后显式触发重连，不重置 Forward Instance 的持久重试预算。daemon 支持 SIGHUP 请求重新连接。不得对未经核实的 PID 发信号。转发瞬态故障初次失败后最多五次自动重试；认证、Host Key、端口冲突、未知策略错误需人工处理。显式重新检查允许一次尝试，不重置累计预算。

用户数据：`~/Library/Application Support/DSH Companion/`；日志：`~/Library/Logs/DSH Companion/`；LaunchAgent：`~/Library/LaunchAgents/dev.deepseek.dsh-companion.plist`。卸载先停止自有 LaunchAgent，再删除本地凭证/配置/bundle/runtime 状态，保留日志/control 目录；**不会代替 DSH 中的 Device 撤销**。

SSH alias 只支持字母/数字/点/横线/下划线，不支持任意 `user@host`。执行器读取可信本机 `ssh -G` 配置后只复制窄白名单到私有配置，包括 GSSAPIAuthentication 和受限的 PreferredAuthentications。`Match exec` 属于用户本机 SSH 配置求值的信任边界。

从 0.1.7 起，识别以下固定的 Kerberos 取票后直连模板（principal 从可信本机配置中取得，不能由 Host 下发）：

```sshconfig
ProxyCommand bash -lc '/usr/bin/klist -s || /usr/bin/kinit -k -t ~/.keytab user@EXAMPLE.COM; exec nc %h %p'
```

该模板不会作为 shell 执行：Companion 以固定 argv 调用系统 klist，必要时调用 kinit，然后让 SSH 直接连接解析出的 HostName/Port。也接受 `/bin/bash` 和 `/usr/bin/nc` 的对应写法。系统 kinit 使用现有 keytab；Companion 不读取、保存或上传其内容。每个认证命令默认最多 5 秒，且受整体启动期限约束。已有有效票据不会重复 kinit；失败输出脱敏的 SSH_KERBEROS_FAILED、SSH_KERBEROS_TIMEOUT 或 SSH_KERBEROS_UNAVAILABLE。

不执行 login-shell profile、不继承其中的额外环境初始化、不运行 nc，也不接受任意 ProxyCommand、ProxyJump、自定义 keytab 路径、shell 替换或追加命令。此适配仅覆盖固定模板的取票与直连语义，并非完整 shell 兼容层。SSH 仍禁用 ProxyCommand/ProxyJump、Agent/X11 转发及 GSSAPI 凭证委派，强制 Host Key 校验及同端口 IPv4 loopback listener。需要其他跳板/代理的环境必须单独设计。

## 构建与测试

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

CLI：`packages/cli/lib/cli.mjs`。插件内下载产物：`packages/plugin/lib/companion-cli.mjs`。插件构建从同一仓库 CLI 源码生成下载文件，不在运行时下载 npm 包或远端代码。不要将“可构建”或 Linux fake SSH 测试当作 macOS 生产验收。

稳定 DSH 安装、升级和重启必须通过 PDM 的稳定更新队列/idle gate。此仓库的隔离验证不授权更改稳定 Host。
