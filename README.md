# DSH Companion

一个 DSH Host/Web 插件和一个 macOS CLI，让 Mac Chrome 访问开发机 Task 的 loopback 服务：

```text
Mac 127.0.0.1:5173 → SSH → devbox 127.0.0.1:5173
```

两端端口始终相同，只绑定字面量 `127.0.0.1`。不修改 Bifrost、系统代理、浏览器代理或用户 SSH 配置。

## 交付与兼容边界

- `packages/plugin`：`dsh-companion`，Host、Task Services 卡片和 Companion Devices 设置。只消费 Better Sidebar 的公开 `registerTab` 接口。
- `packages/cli`：`dsh-companion-cli`，单文件 JS bundle（包含 ws），提供 setup/install、daemon、status、restart、uninstall。
- CLI 要求 macOS 和**外部安装的 Node.js 22+**。没有附带原生 Node 运行时，没有 codesign/notarization，不是无需运行时的独立 App。
- Host 管理接口要求 DSH 的公开 `connection.requestRejection` 登录契约；已在 DSH 0.1.2-rc.1 隔离实例验证。缺失契约时返回 503，而不是降级为匿名管理。
- Task Workspace 必须提供公开 HTTP Task API。Better Sidebar 是卡片容器。
- 自动化验证不能替代真实 Mac 的 Apple SSH、Keychain、launchd、睡眠唤醒和断网验收；发布门禁见 [macOS 验收清单](docs/macos-acceptance.md)。

## Mac 安装与配对

1. 确认 Mac 的 Node.js 22+ 路径稳定。Companion 安装时记录绝对路径，后续删除该 Node 会导致 LaunchAgent 启动失败。
2. 配置并验证一个本机 SSH alias（例如 `devbox`）。已知 Host Key 必须由用户通过可信途径验证并保存，认证须可非交互进行。Companion 不接受未知 Host Key、不托管 SSH 私钥。
3. 登录 DSH → Settings → **Companion Devices** → **配对 Device**。下载“此版本 CLI”到 Downloads。
4. 编辑页面里的 DSH 地址为 **Mac 实际可访问的 HTTPS origin**，填入本机 SSH alias。`127.0.0.1` 在 Mac 上指 Mac 本身，不是远端 devbox。
5. 在 Mac 执行页面命令，例如：

```bash
node "$HOME/Downloads/dsh-companion.mjs" setup --server https://dsh.example.internal --ssh-host devbox
```

按隐藏提示输入一次性配对码。代码不进入 argv；Device token 经 stdin 写入 macOS Keychain，不写入配置/plist/日志。setup 复制固定 bundle、记录 Node 绝对路径并启用用户 LaunchAgent。

HTTP 只默认允许 loopback。非 loopback 的 HTTP 需要明确 `--allow-insecure-http`，此时凭证在网络上是明文，仅供可信测试网络使用。不自动忽略 HTTPS 证书错误。

setup/install 是初装而不是升级：遇到已存在或不完整安装会拒绝覆盖。失败会尝试回滚本地资源；远端 ticket 可能已消费、Device 可能已创建，需要在 DSH 撤销后重新配对。保留恢复材料的部分回滚错误不能忽略。

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

status 包含本地持久快照，不是实时健康证明。restart 只重启进程，**不重置持久重连预算**。WSS 五次重试耗尽后需要人工处理；daemon 支持 SIGHUP 请求重新连接。不得对未经核实的 PID 发信号。转发瞬态故障初次失败后最多五次自动重试；认证、Host Key、端口冲突、未知策略错误需人工处理。显式重新检查允许一次尝试，不重置累计预算。

用户数据：`~/Library/Application Support/DSH Companion/`；日志：`~/Library/Logs/DSH Companion/`；LaunchAgent：`~/Library/LaunchAgents/dev.deepseek.dsh-companion.plist`。卸载先停止自有 LaunchAgent，再删除本地凭证/配置/bundle/runtime 状态，保留日志/control 目录；**不会代替 DSH 中的 Device 撤销**。

SSH alias 只支持字母/数字/点/横线/下划线，不支持任意 `user@host`。执行器读取可信本机 `ssh -G` 配置后只复制窄白名单到私有配置；拒绝 ProxyCommand/ProxyJump 和额外转发。依赖跳板的环境需要专门设计，不能静默放宽限制。`Match exec` 属于用户本机 SSH 配置求值的信任边界。

## 构建与测试

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

CLI：`packages/cli/lib/cli.mjs`。插件内下载产物：`packages/plugin/lib/companion-cli.mjs`。插件构建从同一仓库 CLI 源码生成下载文件，不在运行时下载 npm 包或远端代码。不要将“可构建”或 Linux fake SSH 测试当作 macOS 生产验收。

稳定 DSH 安装、升级和重启必须通过 PDM 的稳定更新队列/idle gate。此仓库的隔离验证不授权更改稳定 Host。
