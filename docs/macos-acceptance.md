# macOS 发布验收门禁

本清单适用于 DSH Companion 0.1.x 的真实 Mac 验收。Linux fake runner、Node 单测和隔离 Web 验证不证明 Apple 系统行为。未提供每项证据前，不得称为 macOS 生产验收通过。

## 环境

记录 macOS 版本、CPU 架构、Node 绝对路径/版本、Apple OpenSSH 版本、DSH Runtime/依赖版本、两个制品的 SHA-256。使用独立 Device 和测试 Task，不操作他人 Lease 或稳定 Host 生命周期。

## 必测行为

- [ ] 下载固定 bundle，验证 hash，与插件提供的 CLI 一致。
- [ ] setup 隐藏配对码；检查进程 argv、plist、配置、日志没有 token 或配对码。
- [ ] Keychain 写入/读取/删除；锁定、拒绝访问时停止，不退化成明文文件。
- [ ] 重复 setup 拒绝覆盖；失败 bootout/Keychain 回滚保留必要恢复材料。
- [ ] LaunchAgent 登录启动；Node 路径不可用和配置损坏有明确诊断，不循环产生副作用。
- [ ] Mac Chrome 请求 localhost:5173 实际到达 devbox 127.0.0.1:5173，两个端口相同。
- [ ] lsof 确认只监听 127.0.0.1，不能出现 0.0.0.0 或 IPv6 wildcard；不存在额外 forward。
- [ ] 认证失败、未知/变化 Host Key、端口被第三方占用均停止自动恢复。
- [ ] 网络抖动/WSS 丢失关闭自有 SSH，重连先快照；临时重试不超过预算且重启不会清零。
- [ ] 手动 restart 的 close 已确认后才 open；TTL 没有延长。
- [ ] Task 归档、Device 撤销、TTL 到期、旧 session 重放无法继续或复活转发。
- [ ] 在 intent、spawn、ready、ACK、close 各阶段崩溃；launchd 对子进程的清理及持久化恢复证据。
- [ ] 控制 socket 被替换、PID 复用、监听器不属于自有 SSH 时拒绝接管/杀进程。
- [ ] 睡眠唤醒和时钟前后跳后先检查到期，不自动续期。
- [ ] uninstall 只删除自有本地资源；远端 Device 明确需要另行撤销。
- [ ] Bifrost、系统代理、浏览器代理和用户 SSH 配置与安装前一致。

## 发布限制

JS CLI 依赖外部 Node.js 22+，不附带签名原生运行时；没有 Apple codesign/notarization。不能宣传免 Node 安装或 Gatekeeper 公证通过。若需要无需运行时的一键系统软件，应增加可验证的双架构签名制品构建流程。

长期 operation ledger/tombstone 历史、daemon 崩溃窗口、慢盘/事件循环阻塞下 TTL 关闭延迟均需要压力与故障注入测试。Mac 无法验证时保留未勾选项，报告具体缺失证据。
