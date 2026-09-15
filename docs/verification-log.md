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

## 2026-09-08：0.1.4 统一拉取启动与配对恢复

用户不接受先下载 CLI、再区分 setup/update。Companion Devices 改为生成一条 curl-to-bash 命令。Host 公开代码与非秘密 Authority 身份；请求授权、秘密轮询、登录后验证码核对/批准分离。请求本身不授信，批准事务拒绝任何已有 installationId，包括已撤销的记录，不能继承旧 Lease。

统一 launch 检查原 Host 和 credential，匹配则强制替换/启动已知进程；换 origin/epoch 不读取或发送旧 token，失效凭证须明确确认后重新批准。普通网络/策略失败保留原配对。配对切换使用新的 installation/Device 和空新 epoch runtime，旧 Keychain 在新初始化成功前保留；私有 journal 支持同命令恢复，并绑定实际安装版本以支持新版入口恢复旧版事务。needs_pairing 在 daemon 停止/重启后保留；明确 SIGHUP 重试仍不能绕过 Host 授权。

复现并修复空 Home 尚未配对时 Authority 未落盘的问题。真实文件测试确认同 Home 重建 service 后 Device 和 token 有效，不同 Home 拒绝旧 token。调查原配对“消失”：3083 production-local 原 Home 有旧 Device；3084 package-validation 是另一份空数据库。通过 PDM 启动原 3083 Home，启动前后 Authority、Device ID、tokenHash、installationIdHash 不变。原 Mac C06XMG02WC（CLI 0.1.1）仍显示离线，原 Lease 已按 TTL 关闭；没有替它续期或迁移。

CLI 130 项、Plugin 67 项通过，类型检查、构建、prepack 和 diff 检查通过。包含真实 bash/Node/shasum 脚本测试（替身 Darwin/curl/TTY）、浏览器批准契约、文件持久化、身份失配、撤销、拒绝、网络、取消、回滚、不明锁、损坏备份和跨版本 journal 恢复。Mac 生命周期 runner 为注入测试，不是 Apple 系统验证。

在现有 http://127.0.0.1:3083 刷新实页，验证单命令和旧 Device 显示。实际点击发现批准/拒绝客户端漏 Content-Type 导致 415；复用 jsonPost 修复并增加客户端回归。修复后网页核对验证码→批准→一次性交付 ready→Device verify 200 完整通过；仅测试 Device 随即撤销，无新 Lease。修正复选框与卡片布局后重新打包。

匿名 bootstrap.sh、bootstrap/cli.mjs 和 identity 返回 200；devices 保持 401。下载 SHA-256 与打包 CLI 一致：cff487196af05461aa63fd18495927ab89ea59dbe160a3cee8be71ace88c3114。PDM 开发远程策略为已启用、10.0.0.0/8、PIN 已配置，3083 实际监听 0.0.0.0。devbox 向自身 LAN URL 的额外探测被既有 HTTP 代理以 403 拒绝；没有改代理或绕过路由，不把 loopback 验证称为 Mac 端可达验证。

最终插件 tgz：2f6669aa01096aa96128db2d1bc2c5b13bce9ddad85936dbce3b623f67c0ccae；CLI tgz：c5637c6f54cf426cb75d0ba5d47a88eb192388be1f961f0b541215cfc4d1c3d9。PDM 干净包验证未对 0.1.4 重跑；真实 Mac 的统一命令、Keychain、launchd、SSH 和睡眠唤醒仍待验收。未修改 Better Sidebar 源码，未改变稳定 Host。

## 2026-09-08：0.1.5 修复路径别名下 CLI 静默退出

用户在 Mac 执行统一命令后没有任何输出，Host 仍只记录旧 CLI。用真实 0.1.4 bundle 的 Node 子进程复现：真实路径 --version 正常，经符号链接目录启动则退出码 0、stdout 为空。入口判断将已被 Node 规范化的 import.meta.url 与未解析符号链接的 argv 路径比较；macOS 常见的 /var → /private/var 临时目录别名会触发这一缺陷。没有读取用户 Mac，因此真实 Mac 的具体路径仍待重跑确认。

入口改为比较两端 realpath，保持普通模块导入及非文件 argv 不执行 CLI。统一 launch 在开始检查前立即输出版本与进度。新增真实子进程测试覆盖直接路径、目录别名、preserve-symlinks-main 和仅导入；测试临时目录明确使用 ESM，与发布 .mjs 一致。CLI 132 项和 Plugin 67 项通过，类型检查与打包通过。

从运行中的 3083 公开入口实际下载 0.1.5，验证直接路径、目录别名、文件别名及 preserve-symlinks-main 四种方式均输出正确版本；别名路径 launch 输出进度并在 Linux 明确拒绝 Mac 生命周期操作。bootstrap 中的动态 SHA-256 与下载字节一致：b0e3be3bdd3d0485972a4036a0116a76abe6c2d4e6f4bfac13c5389af4bef42a。下载路由每次读取 bundle 并生成摘要，无需重启 Host。

插件 tgz SHA-256：d15527fa3c443969868af658c3d7263c9d2335dfa49f5bcaa96b11a7921b35db；CLI tgz：43b750e3eb6a811442c2ed0cb80a02fada49b67460f41b38d1131c6da2b6c86b。未触及配对数据、Better Sidebar、代理设置或稳定 Host。Mac 实机重跑及上线仍需用户确认。

## 2026-09-08：0.1.6 等待异步停止与恢复 stopping journal

Mac 报告 update journal phase=stopping、oldVersion=0.1.3、targetVersion=0.1.5；daemon-status 为 stopped、版本 0.1.3，install/daemon/reclaim 三个锁均不存在。这将失败范围定位到停止确认阶段，不能仅凭最终快照区分 launchctl 返回异常与检查早于收尾。

两项回归先失败并产生相同的笼统 recovery 错误：bootout 返回后旧 daemon 才异步写 stopped/删除锁；launchd 接受停止后仍短暂报告 loaded。修复为注销和已验证锁拥有者的收尾分别有界等待，默认各 10 秒。等待不持有 acquisition mutex，不反复 bootout，不删除活 PID 的锁；未知状态、PID 探测失败、锁身份变化仍拒绝。更新、软件回滚和显式配对切换采用同一停止边界。

真实文件夹具覆盖用户提供的 stopping＋旧版 stopped＋无锁现场，下一次调用从保存 journal 恢复旧程序后完成更新，配对/config/runtime 保持不变。另覆盖永不退出、注销超时、等待中 nonce 改变。错误输出增加 STOP_REQUEST_FAILED、STOP_REGISTRATION_UNKNOWN、STOP_REGISTRATION_TIMEOUT、DAEMON_STOP_TIMEOUT、DAEMON_LOCK_UNVERIFIABLE 等安全分类，不传播原始命令 stderr，不再让用户改跑下载 CLI 的 update 子命令。

CLI 138 项、Plugin 67 项通过，类型检查、打包、git diff 检查通过。3083 公开下载返回 200，经符号链接运行输出 dsh-companion 0.1.6；bootstrap 摘要与实际下载字节匹配：3aa8df8324296402386a5de36b29f169c1a9cbbbcc17d9e658d4824ec847706c。插件 tgz：9a133c9eddfcd10ddc7b327002de5d8c1d0d0664d285e7f3ad43efa53b9f536c；CLI tgz：b8a4dc85b65cf46862e86069d1a3fcfe20d5bbd1548777d8c96336fc1146b9df。

Mac 再次运行后的实际恢复和在线状态仍待用户确认。没有删除用户锁或恢复文件，没有改配对、代理、Better Sidebar 或稳定 Host，也没有为下载替换重启 3083。

## 2026-09-08：0.1.7 受限 Kerberos 预认证适配

用户提供的本地 devbox SSH alias 使用 bash -lc 包装 klist -s、必要时通过 ~/.keytab 调用 kinit，然后 exec nc %h %p。该固定模板被原 ProxyCommand 一律拒绝规则挡住；私有 SSH 配置同时没有复制 GSSAPIAuthentication。以匿名同型配置复现 SSH_UNSUPPORTED_PROXY，再加入受限适配。

只识别文档中的固定语法，提取受限 principal；不执行配置中的 shell/profile/nc，而是通过 shell:false、绝对系统程序路径及固定 argv 做本地 Authentication Preflight，再用受控 SSH 直连。系统 kinit 可使用现有 keytab，Agent/Companion 不读取或保存其内容。继承验证过的 GSSAPIAuthentication/PreferredAuthentications，仍强制禁止 ProxyCommand、ProxyJump、Agent/X11 转发与 GSSAPI 凭证委派，并保留严格 Host Key、同端口 loopback 和 listener 所有权证据。

新增测试覆盖有票据跳过 kinit、无票据取票、取票失败不启动 SSH且不泄漏 stderr、实际 OpenSSH -G 两次解析保留认证策略、额外命令/替换/路径/代理参数/跳板拒绝、认证命令超时中止、检查期间取消不再取票或启动。真实 ssh -G 只读取测试配置，不连目标、不执行 Kerberos；klist/kinit 使用注入 runner。CLI 145 项、Plugin 67 项通过，类型检查、打包、diff 检查通过。

3083 实际公开下载为 0.1.7，经路径别名运行版本正确；bootstrap 摘要与下载匹配：f79f9992570d66b35033f82e32c4aa4a2ae161019c92a75ef4a8837d080a2b6f。插件 tgz：04b8750f182750f0d6290dbbc5edddb9b9dd75bf8013f840a40611eee40ea606；CLI tgz：93d73f111873ef7d08a343dc0583ce62f94e80bf7b0f6aa9ad0a41b8b7d707f5。未修改 SSH 配置、keytab、Bifrost、Better Sidebar 或稳定 Host，未重启 3083。

不宣称完成 Mac 实际取票/5173 浏览器验收；适配不支持依赖 login-shell profile 的额外环境初始化。升级不续期 Lease或重置 Forward Instance 的累计预算；现有 Open Lease 可在页面点击“重新检查”明确授权一次尝试。

## 2026-09-09：0.1.8 原生 SSH 配置

按照用户要求，删除 ssh -G 解析器、私有白名单配置和 0.1.7 的 Kerberos 模板适配。系统 SSH 原生读取可信本地连接/认证配置；Companion 不直接执行 klist/kinit。架构与信任边界见 [原生 SSH 配置决策](adr/0001-native-ssh-configuration.md)。

先以临时隔离 sshd 和匿名 ProxyCommand 复现 SSH_UNSUPPORTED_PROXY，再改为 forwarding-free master + hermetic mux forward。真实 ProxyCommand、ProxyJump、配置中的 L/R/D 转发隔离、LocalCommand 抑制、实际端口冲突分类和正常代理后代退出均通过。未读取个人 keytab/SSH 密钥，未修改用户 SSH 配置。契约测试保留 listener/PID/socket、超时、取消、恢复、无法证实所有权不杀进程等保护，并增加 mux 失败和认证后取消的保护。V2 记录可安全关闭已认证但无 listener 的 master。

CLI 139 项、Plugin 67 项通过，类型检查与打包通过。格式检查发现删除旧解析器留下的 EOF 空行，清理后完整门禁重跑成功。0.1.8 插件 tgz SHA256 为 3f870cc2cadcec983df1c84b2e93a305ffb49530c114c4ae24c8c7f0d051918a，CLI tgz 为 6ff098c31b36e68fe420ca0570533f8811afed6602e35171e2481e9ac0c24a07。

3083 公开下载 HTTP 200，实际 bundle 经路径别名运行输出 dsh-companion 0.1.8；bootstrap 摘要与 bundle 一致：2146d3eed1842b5fb04d72d1d61af8dc4be29af8b5730559a573aa399dc412aa。未重启 3083、未更改稳定 Host、Bifrost 或 Better Sidebar。真实 Mac 取票及浏览器 5173 数据路径仍待验收；升级不续期 Lease，现有 Open Lease 可点击“重新检查”显式尝试。

## 2026-09-09：0.1.9 开发——停止转发与注销服务

新增 task_forward_close 与 task_service_unregister；停止保留声明，注销在同一事务中归档声明并撤销所有 Device 的 Open Lease。保留关闭 tombstone、命令与观测，重复注销不增代，归档服务不再接受新 Open。停止/注销均不终止 devbox 应用。页面增加显式操作、全 Device 范围确认和注销后的关闭记录；AI 列表通过匹配 generation 的 closed/exited/missing 观测提供 close_confirmed。

新增回归覆盖跨 Task 拒绝、重复调用、持久化失败回滚、并发打开/注销、重载与重新注册不继承权限、HTTP 登录/来源/JSON 校验、AI 工具执行和真实 WebSocket close/ACK。CLI 139 项 + Plugin 75 项共 214 项通过，类型检查、两包构建和 git diff --check 通过。WebSocket 测试使用 fake tunnel executor，不等同于真实 Mac UI 验收。

浏览器访问原 3083 返回连接拒绝；PDM 起初报告项目 stopped，随后启动返回 Unknown development project，最新项目列表已无 dsh-companion-production-local。因此未重建该环境、未声称完成浏览器验收。实现保留在 feat/service-lifecycle；Host 插件版本 0.1.9，Mac CLI 仍为 0.1.8；未推送或排队本次改动，未改 Sidebar/Task Workspace 参考源码。

## 2026-09-09：新隔离实例的 AI 与浏览器验收

按用户要求创建 PDM 项目 dsh-companion-lifecycle-test，分配 3083，使用新的独立 Home。组合为 Companion 0.1.9 工作树、正式 npm Sidebar 0.18.0、已发布的 Task Workspace 0.3.2 tarball、Codex Connect 0.1.0-alpha.4.29；不引用 Sidebar/Task Workspace 的参考源码。启动后 Codex doctor 确认与 DSH 0.1.2-rc.1 兼容；按此前用户授权仅复制当前 Codex 账户的独立认证快照，权限 0600，不改源认证或主动刷新令牌。Mac 配对没有迁移。

新建专用验收 Task。GPT-6-Astra 真实会话调用 task_service_register、task_service_unregister、task_forward_list 三个工具，确认声明已移除。正式 Sidebar 的公开 Task Services 标签正常加载。另用未建立 SSH 的离线模拟 Device 验证页面：停止转发将指定 Lease 变为 Closed/user/g2，并保留服务；未确认注销时声明仍在，确认后卡片移除，历史 Lease 仍可查询，关闭记录显示待确认停止。未将授权撤销误报为 Mac listener 已关闭。模拟 Device 已撤销。

验收中断后 PDM 报告该实例 stopped，通过 PDM start 恢复相同 Home 后核对持久状态，再完成注销，不重建或清空数据。测试地址为 http://10.37.230.238:3083/mobile-auth，Agent 验证地址为 http://127.0.0.1:3083/。真实 Mac 的进程与 listener 停止仍需在新 Home 配对后验证。本次未改稳定版或排队发布 0.1.9。

## 2026-09-09：0.1.9 发布前验证

用户基于验收结果授权合入 main 并通过 PDM 排队更新。发布前重跑锁文件检查、两包类型检查、214 项测试（CLI 139、Plugin 75）、两包构建和 diff 检查，全部通过。Sidebar peer 范围补入已在新实例实际验收的 ^0.18.0，同时保留 ^0.13.1。发布目标仅为 Companion 0.1.9，Mac CLI 保持 0.1.8；依赖源码不随本次发布合并或替换。后续安装必须由 PDM 空闲门禁执行，验证与排队结果以管理器的不可变发布记录为准。

## 2026-09-09：0.1.10 开发——默认一周 TTL

用户要求适配常见的一周开发周期。Host 默认和最大 TTL 统一为 604800000 ms，AI 省略 ttl_minutes 时使用 10080，页面默认一周并保留 30 分钟、2 小时、8 小时、24 小时选项。Host、AI 和页面共享默认常量。已有 Lease 不迁移、不续期，重新加载、重复打开、重新检查、重启都保留原到期时间。协议 v1 与 Mac CLI 0.1.8 无需升级。

新增六项回归覆盖最小/最大值、非法 TTL、精确到期边界、旧两小时 Lease 重载及操作不续期、新 Lease 默认七天、AI 默认与上限、HTTP 默认与上限、浏览器分钟换算、实际 WebSocket 下旧 CLI 接收七天期限。两包类型检查、全量测试、构建和 diff 检查通过。

通过 PDM 启动原 dsh-companion-lifecycle-test，刷新 http://127.0.0.1:3083/ 后实测 TTL 选中“一周（7 天）”、值为 10080；独立离线夹具的 HTTP 创建结果精确为七天，超过上限 1 ms 返回 400。测试声明已注销，模拟 Device 已撤销，没有运行 SSH 或延长真实 Device 的授权。改动保留在 feat/week-ttl，未推送或排队发布 0.1.10。

## 2026-09-09：0.1.10 发布前验证

用户授权发布一周 TTL 版本。发布前重跑两包类型检查、220 项测试（Plugin 81、CLI 139）、两包构建及 diff 检查，全部通过；源码行为与 3083 功能验收版本一致。发布对象仅为 Companion 0.1.10，Mac CLI 保持 0.1.8。通过 main 的精确提交进入 PDM 独立 Companion 发布流程，实际安装与重启由空闲门禁决定；制品、哈希和队列状态以 PDM 发布记录为准。

## 2026-09-10：0.1.11 开发——到期后重新开启转发

用户截图暴露 Closed 且关闭未确认时页面只有“重新检查关闭”，无法继续开发。卡片增加“重新开启转发”，离线 Device 也能显式申请新 Lease；保留服务和旧到期时间，新 TTL 从申请时开始。Host 对同 Device、同端口的旧关闭建立 ACK 屏障，旧关闭失败不下发新 Open，新 Lease 的重新检查会重试旧关闭；恢复持久状态后屏障仍在。创建时补处理尚未被周期扫描关闭的过期 Lease。Host/UI 按持久数组插入顺序选择最新 Lease，避免同毫秒关闭重开后重复创建或展示旧记录。

新增六项回归：过期扫描竞态和跨重载 ACK 屏障、旧关闭失败重试、同毫秒重复请求及 UI 选择、已撤销 Device/已注销服务拒绝、离线卡片按钮和 TTL 请求、真实 WebSocket 先关后开及迟到旧命令不影响新隧道。Plugin 87 + CLI 139 共 226 项测试、类型检查、构建和 diff 检查通过。

通过 PDM 重启原 3083 隔离实例前，确认仅有验收 Task、零开放 Lease、零在线 Device。实际浏览器中用无 SSH 的独立夹具验证两个按钮同时显示，点击重新开启生成新的一周 Lease，服务声明及旧到期时间不变，并展示等待关闭的提示。夹具声明已注销、模拟 Device 已撤销；未操作用户截图中的 3334 服务。改动保留在 fix/reopen-expired-forward，未发布或排队 0.1.11；真实 Mac 运行依赖 Device 在线，未将排队申请视为隧道已恢复。

## 2026-09-10：CLI 0.1.9 开发——控制通道持续重连

用户反馈整夜后离线，手动重跑才恢复。源码确认旧 daemon 将普通 WSS 断线限制为五次重试，耗尽后进程仍存活，launchd 无法恢复连接；缺少当晚 Mac 诊断，未断言这就是该次离线的唯一原因。

将控制循环提取到 connection.ts，普通网络故障及 HTTP 408/429/5xx 持续指数退避，带抖动且间隔不超过 30 秒。超出旧上限的持久计数仍可连接，稳定心跳一分钟后重置退避。唤醒后检查过期的重连期限和心跳；不修改 macOS 睡眠设置。撤销、认证/Authority、TLS/协议及本地清理/凭证/持久化错误仍停止；安全阻断跨进程保留，重连必须等待旧 SSH 清理。迟到旧 socket 回调不能污染新连接。CLI status 提供白名单断线原因、时间、状态码、下次重连时间，不保存原始错误或凭证。Forward Instance 重试预算和 Lease TTL 均不改变。

两包类型检查、250 项测试（Plugin 87、CLI 163）、构建和 diff 检查通过；PDM dsh-companion-lifecycle-test 的 check 通过。新增覆盖超过五次失败、模拟八小时睡眠及唤醒、健康心跳退避复位、认证/安全停止、清理屏障、停止与重复事件、旧持久状态迁移和诊断脱敏。真实 Node HTTP/WebSocket 测试在连续七次 503 后第八次握手成功，无人工重新启动。

通过 PDM 启动原 3083 隔离实例；实际浏览器下载 bootstrap/cli.mjs，与引导脚本内及本地构建 SHA-256 一致：d15cc5759fc6eeeb84e92fab500977833e6394c9ef5a09b54bcf3ac91acf0428；本地执行该分发 bundle 的 --version 输出 0.1.9。未连接用户 Mac、未操作真实 Lease、未发布或排队 Stable。仍保留前次 Host 0.1.11 重新开启入口的未发布改动。真实 Mac 断网/整夜睡眠、Keychain 和 launchd 行为尚需验收；Host 发布后，用户须在 Mac 重跑原 Host 的统一命令安装新版 CLI，不能把 Host 更新当成 Mac 已升级。

## 2026-09-10：通用设备称呼统一为 Device

用户要求用 Device 表示其他设备。统一 Task Services 描述与地址映射、Companion Devices 启动/配对/批准/空状态提示、AI 指导、CLI 配对恢复提示和操作文档中的通用 Mac 称呼。保留实际 macOS 支持限制、Keychain/launchd 技术名称、历史验收记录及用户自定义名称；未改变协议、配对数据或声明跨平台支持。启动区域明确提示当前 CLI 支持 macOS。

新增 device-terminology.spec.ts 防止通用称呼回退并确保平台限制仍在。251 项测试（Plugin 88、CLI 163）、类型检查、构建通过；最终文案再经 PDM check（code 0）验证。刷新 3083 后，实际页面显示 Device 转发控制面、在 Device 上执行命令及 macOS 支持说明。未发布或排队 Stable。

## 2026-09-10：Host 0.1.11 / CLI 0.1.9 发布前验证

用户授权合并发布重新开启转发、控制通道持续重连与 Device 统一文案。发布前重新运行两包类型检查、251 项测试（Plugin 88、CLI 163）、构建和 diff 检查，全部通过；分发 bundle 的 --version 为 0.1.9。保留上述 3083 页面、分发与真实 WebSocket 验收证据；没有把模拟睡眠视为真实设备整夜验收。

源码合入 main 并推送后，通过 dsh-companion-package-validation 的 PDM 安全更新队列交付 Host 0.1.11，实际安装和重启等待空闲门禁。精确制品及队列状态以 PDM 返回记录为准。Stable 生效后，Device 须重跑原 Host 的统一启动命令安装 CLI 0.1.9；Host 更新不自动替换 Device 端进程。

## 2026-09-10：Host 0.1.12 开发——握手版本与重启恢复复核

用户提供的统一启动输出表明 Device 端已通过本地 bootId、PID 与状态文件校验启动 CLI 0.1.9。Stable Host 设备列表仍显示 0.1.8，原因是 Host 只在首次配对时保存 companionVersion，后续 device.hello 虽携带运行版本却未更新元数据；此前将设备列表版本解释为当前运行版本不成立。

Host 现于认证成功的 device.hello 中校验并持久化 companionVersion，Device 卡片因而反映最近一次成功握手的运行版本；非法版本拒绝且不覆盖上次有效值。新增服务持久化及真实 Device WebSocket 握手回归。

另新增真实 Node HTTP/WebSocket 测试：CLI 先连接 Host，Host 以 1001 正常停机并完全释放监听端口；CLI 对端口拒绝持续重试，Host 在同一端口恢复后无需 SIGHUP 或重跑命令即可重新握手。该测试通过，说明 CLI 0.1.9 的正常 DSH 重启路径未发现逻辑缺口；首次退避约 2 秒，累计退避最长 30 秒，实际恢复时间还包含 Host 启动耗时。缺少问题发生当时的 Device 本地 status/log，无法判定用户观察是等待不足、当时安装进程差异或其他环境故障。若 0.1.9 再现，应先保留 status 输出与本地日志再重跑统一命令。

3083 隔离 Host 用浏览器工具尝试原生 Authorization WebSocket 功能验收，但运行器隔离了 Node 内建模块，未降低 Host 认证要求或输出 token；三次模拟 Device 均已撤销。服务层、真实 DeviceHub WebSocket 和真实 CLI WebSocket 自动化测试构成当前行为证据。

## 2026-09-10：Host 0.1.12 发布前验证

用户此前已授权发布并要求继续处理重启恢复反馈。发布前重跑两包类型检查、254 项测试（Plugin 90、CLI 164）、两包构建、diff 检查及 dsh-companion-package-validation 的 PDM check，全部通过。Host 0.1.12 仅修正最近认证握手版本的校验、持久化及展示；分发的 Device CLI 保持 0.1.9，控制通道行为未修改。源码合入 main 并推送后通过 PDM 安全更新队列交付，实际安装与 Host 重启等待空闲门禁。

## 2026-09-11：Host 0.1.13 / CLI 0.1.10 开发——全局服务与持续转发恢复

用户确认服务注册不需要 Task 维度，并反馈普通转发断线后必须手动“重新检查”。代码复核发现三项相互叠加的原因：CLI Forward Instance 在连续六次实现失败后写入 RETRY_EXHAUSTED；Host operation 在三次未确认投递后写入 DELIVERY_EXHAUSTED；新 Device Connection Session 清空 enabled Lease 集合后上报 persisted recovering，Host 却把 starting/recovering 当作已收敛，因而不再下发 Open。

Host 0.1.13 将 Service 与 Lease 改为 Host 全局状态，移除 Task Workspace 运行依赖和 cwd 解析；state schema v2 在首次加载时按端口折叠 v1 Task 声明并原子写回。全局 UI 使用 `/api/companion/snapshot` 与 `/api/companion/services`；旧 task_ 工具名、Sidebar tab id 和 `/tasks/:taskId/...` HTTP 路径作为不参与 scope 的兼容入口。Task、Session 结束或归档不再关闭 Lease。

CLI 0.1.10 对 SSH_EXITED、启动/命令超时、LINK_LOST 和 LISTENER_MISSING 持续退避重试，最长间隔 30 秒，成功后连续失败计数归零。Host 持续重发未确认的幂等 operation，并把新 Connection Session 的 recovering/starting 视为需要 fresh fenced Open；旧 CLI 上报 RETRY_EXHAUSTED 时也能由 Host 自动重新启用。认证、Host Key、端口冲突、策略、撤销和到期仍不自动绕过。

本地 `pnpm -r check` 通过：Plugin 92 项、CLI 164 项，类型检查和两包构建成功；插件 PDM check 也通过 92 项，分发 bundle `--version` 为 0.1.10。`dsh-companion-lifecycle-test`（http://127.0.0.1:3083/）以既有 v1 Home 启动并迁移，浏览器无 console error；在一个 Session 注册 `Global smoke service:55201` 后，另一个 Session 的 Local Services 立即看到同一声明，随后注销并重启 Host，迁移后的全局空列表与历史关闭记录仍可加载。没有在该隔离 Home 配对真实 Mac，因此真实断网、睡眠唤醒和 Apple SSH 行为仍须按 macOS 验收清单执行。本开发验收阶段未提交、未发布、未排队或修改 Stable。

## 2026-09-11：Host 0.1.13 发布与 Stable 排队

发布提交 `18db338792e087994871cf613c9290c77c3152a3` 已推送至远端 main。首次使用多插件联调项目 `dsh-companion-lifecycle-test` 发布时，干净安装因未授权的传递依赖 lifecycle script `node-pty@1.1.0` 被 PDM 拒绝；该尝试没有生成 Pending 更新。没有为无关依赖扩大 allowBuilds，而是使用既有单插件发布项目 `dsh-companion-package-validation` 重新执行检查、归档、构建、干净 DSH_HOME 安装及启动验证。

PDM 生成并晋级制品 `dsh-companion-0.1.13-dfc9573f64f6.tgz`，SHA-256 为 `dfc9573f64f6875f99186758fb0b5b69b89595f47abca04927e1e5207871ffcd`，allowBuilds 为空。该精确制品已进入 Stable 安全更新队列，状态为 `waiting-for-idle`；实际安装和 Host 重启由 idle gate/quiet window 决定，本记录不把排队描述为已上线。

## 2026-09-12：Host 0.1.15 / CLI 0.1.11 开发——本地故障后持续恢复

用户在 Mac 浏览器仍直连 Stable Web 时看到 Device 离线。Host 同时存在来自 Mac 网段的 3080 浏览器连接，但 Device API 的最近控制通道活动停在 03:40:34。保留现场后，Mac 本地 status 显示 LaunchAgent 已加载、daemon 观察为 `needs_attention`、`lastDisconnectReason=LOCAL_ERROR`、`automaticRetryBlocked=true`，运行版本为 CLI 0.1.9。该证据确认“整机/浏览器在线”和“Companion 控制通道在线”是两种独立状态，并定位到旧 CLI 把控制器本地故障永久阻断的恢复缺口。

CLI 0.1.11 对控制器本地故障先同步失效连接并等待自有 SSH 清理，再按有界退避持续重连；SSH 清理失败仍转为终态 `CLEANUP_FAILED`，不会带着未确认的 listener 重连。新 daemon 在 `controller.initialize()` 完成 SSH 所有权恢复后，解除旧版遗留的 `LOCAL_ERROR` 阻断；认证、Authority、TLS、协议、凭证及状态写入阻断保持终态。Device Settings 把模糊的“在线/离线”改为“控制通道在线/Companion 未连接”，并明确浏览器在线不代表 Companion 已连接。

本地 `pnpm -r check` 通过：Plugin 95 项、CLI 168 项，类型检查和两包构建成功；PDM 项目 `dsh-companion-lifecycle-test` 的 Plugin check 通过。隔离 Web `http://127.0.0.1:3083/` 实测新状态说明和时间标签加载正常，console 无错误；最终构建的分发 bundle 为 CLI 0.1.11，SHA-256 为 `d48bd2c0640441622cb10398bbe449821bd0060306f85c24e5fdb8bf6301af68`。用户重跑 Stable 统一启动命令后，真实 Mac 已从 CLI 0.1.9 更新到 0.1.10，Host 确认 Device 在线且两条现有 Forward Instance 保持 running。CLI 0.1.11 尚未安装到真实 Mac，因此真实故障恢复仍保留为未完成的 macOS 发布验收；本阶段未提交、未发布、未排队或修改 Stable 插件。

## 2026-09-12：Host 0.1.15 / CLI 0.1.11 发布与 Stable 排队

发布提交 `50a9b23acd236417ebcb9af72a6fb71d03ac6428` 已推送至远端 main。PDM 单插件项目 `dsh-companion-package-validation` 对该发布提交执行检查、归档重建、干净 DSH_HOME 安装和启动验证后，生成并晋级制品 `dsh-companion-0.1.15-940c59e36a3e.tgz`，SHA-256 为 `940c59e36a3e5d848f7d098f9fddbff9a9eb073e97172c0e37a229215235252a`，allowBuilds 为空。

该精确制品已进入 Stable 安全更新队列，状态为 `waiting-for-idle`，入队时间为 `2026-09-12T06:34:54.644Z`。实际安装和 Host 重启继续由 idle gate/quiet window 决定；排队成功不表示 Stable 已安装 0.1.15，也不表示真实 Mac 已运行 CLI 0.1.11。

## 2026-09-15：Host 0.1.16 / CLI 0.1.12 开发——区分 SSH 退出与 stdio 关闭

Stable 0.1.15 已于 2026-09-14 15:22:41 +08:00 安装，真实 Mac 也已运行 CLI 0.1.11，但用户再次观察到 Companion 未连接。保留现场后，Device status 显示 `cleanup_failed`、`lastDisconnectReason=CLEANUP_FAILED`、`automaticRetryBlocked=true`，最后控制通道活动为 2026-09-15 12:30:13 +08:00。Host 最后观察到 3120 为 `recovering/SSH_EXITED`，3334 为 running；Mac 现场没有 3120/3334 listener，也没有 Companion SSH 进程，只有 daemon 存活，而 runtime-state 仍保留 3334 的 running/controlPath。

现场与清理代码共同定位到退出证明的层级错误：Node `ChildProcess` 的 `exit` 已证明自有 SSH 主进程及其 listener 消失，但旧实现继续等待可能被后代进程持有的 stdout/stderr 管道触发 `close`；超时后把实际已完成的清理误报为 `CLEANUP_FAILED`。CLI 0.1.12 将退出证明改为主进程 `exit`，`close` 仍负责最终流排空和退出回调；真正没有退出的进程仍执行 TERM→KILL，并在两次有界等待后保持 `SSH_STOP_TIMEOUT/CLEANUP_FAILED`。

新增“主进程已退出但 stdio 延迟 close”和“control socket 消失且保存 PID 不存在时清理孤儿 owner 目录”回归测试，并保留 live/reused PID、无法退出、stopAll 部分失败和元数据篡改阻断测试。本地 `pnpm -r check` 通过：Plugin 95 项、CLI 170 项，类型检查和两包构建成功；PDM 单插件项目 `dsh-companion-package-validation` check 通过。最终开发 bundle 为 CLI 0.1.12，SHA-256 为 `671c853736e35ced8be4b28e900ffb0e1c9512e1e9a4f5871ae000f751e8eeff`。本阶段尚未提交、发布、排队或修改 Stable；真实 Mac 仍保留故障现场，未用未发布代码作生产验收。

## 2026-09-15：Host 0.1.16 / CLI 0.1.12 发布与 Stable 排队

发布提交 `7c3e4fd4a4122672327e16929927bb72edd7b296` 已推送至远端 main。PDM 单插件项目 `dsh-companion-package-validation` 对该提交重新执行检查、归档重建、干净 DSH_HOME 安装和启动验证，生成并晋级制品 `dsh-companion-0.1.16-50b0ee6849f3.tgz`，SHA-256 为 `50b0ee6849f38e593e0801f12d5cc581851e77ad645e6c512826ac554b59160f`，allowBuilds 为空。

该精确制品于 `2026-09-15T05:04:42.606Z` 进入 Stable 安全更新队列，状态为 `waiting-for-idle`。队列应用前 Stable 仍为 Host 0.1.15，真实 Mac 仍为 CLI 0.1.11；Host 安装 0.1.16 后，Device 必须重跑该页面的统一启动命令，才能安装 CLI 0.1.12 并执行本次孤儿目录安全恢复。

## 2026-09-15：Host 0.1.17 / CLI 0.1.13 开发——有界重试 control 目录删除竞态

Stable 0.1.16 已于 `2026-09-15T05:09:59.756Z` 安装，真实 Mac 已运行 CLI 0.1.12。用户在 Mac 持续使用且未睡眠时再次看到 Companion 未连接；最后控制通道活动为 20:28:50 +08:00。Mac status 显示 `cleanup_failed`、`lastDisconnectReason=CLEANUP_FAILED`、`automaticRetryBlocked=true`。现场没有 3120、3334、4327 listener 或 Companion SSH 进程，只有 daemon 存活；3120 和 4327 的 control 目录已删除，3334 仅遗留私有 `owner.json` 且 control socket 已消失，runtime-state 仍把三个实例记为 running。

SSH 主进程已经退出且只有一个目录保留，证明 `stopAll()` 失败发生在退出后的目录删除阶段。CLI 0.1.13 对 `EBUSY`、`EMFILE`、`ENFILE`、`ENOTEMPTY`、`EPERM` 执行 25/50/100 毫秒的三次有界重试；非白名单错误或第四次失败继续保留 owner 证据并阻断连接。`CLEANUP_FAILED` status 新增白名单化 `lastCleanupErrorCode`，AggregateError 会提取首个安全子错误码，不持久化路径、原始 message 或其他任意内容。

新增瞬态删除竞态成功重试、重试耗尽保留 owner，以及嵌套 `ENOTEMPTY` 诊断测试。本地 `pnpm -r check` 通过：Plugin 95 项、CLI 172 项，类型检查和两包构建成功；PDM 单插件项目 `dsh-companion-package-validation` check 通过。最终开发 bundle 为 CLI 0.1.13，SHA-256 为 `29dea036506fac4da024edc7005b770b152dca8e7bea76aa910d331d0f33870c`。真实 Mac 重跑现有 0.1.12 统一启动命令后，control 通道在线，3120、3334、4327 全部恢复 running。本阶段尚未提交、发布、排队或修改 Stable。
