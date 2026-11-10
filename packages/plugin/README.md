# DSH Companion 原生集成

版本0.2.0-rc.2，运行时DSH0.2.1-rc.5。此包提供原生Local Services右侧栏、Companion Devices设置、设备配对与同端口转发；与dsh-dev-services包配合管理Linux应用。

管理HTTP接口只接受原生owner-browser身份；signed API Peer保持Agent权限。浏览器启动先读取owner-only固定配置review，用户确认digest后，Host在同一次请求中授予不可序列化的配置绑定proof，启动前重新校验。Agent的Linux与managed转发操作遵守真实Workspace和sandboxPolicy边界。

Companion capability仅负责managed声明ensure/retire，不替代设备选择或TTL授权。设备WebSocket使用独立配对凭据。不同DSH_HOME是独立Host，原有配对数据不自动迁移。

CLI包含在lib/companion-cli.mjs。设备从Companion Devices页面复制统一启动命令，在自己的设备上执行并核对授权码。需要外部Node.js22+与macOS。

完整操作、状态和恢复说明见仓库README及docs/。工程和隔离浏览器验收不代替真实Device端到端验收。升级运行实例时按部署流程备份配置与状态，使用官方plugin manager安装。
