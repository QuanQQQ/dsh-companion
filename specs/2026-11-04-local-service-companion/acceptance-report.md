# Local Service与Companion验收记录

验收日期：2026-11-10。运行基线为DSH 0.2.1-rc.5，交付包为dsh-companion、dsh-companion-cli、dsh-dev-services 0.2.0-rc.2。安装包在本地构建，未发布npm。

## 工程检查

| 检查 | 结果 |
| --- | --- |
| Companion类型检查、单元与HTTP集成 | 通过；109项测试 |
| Companion CLI类型检查与SSH/launchd fixture | 通过；186项测试 |
| dev-services常规测试 | 33项通过，5项条件跳过 |
| 真实自有systemd与health检查 | 12项通过；覆盖上述5项条件场景 |
| 三包prepack检查和构建 | 通过 |
| gpt-6-astra独立审查 | 必要阻塞已修复，定向复查通过 |

真实systemd检查使用测试自有unit和进程，验证持久生命周期、listener归属、有界重启及停止边界。CLI检查使用隔离SSH/launchd fixture，不修改真实Mac配置。

## 隔离浏览器验收

gpt-6.1-terra在独立DSH_HOME中验证原生侧栏。自有服务依次完成创建、显式命令确认、启动、日志查看、重启、停止、刷新回读和移除；整个流程回读同一服务ID。重启确认进程更换，停止确认监听关闭。没有注册Device或创建转发Lease。

rc.2另验证无Device和Lease时的移除成功提示为“服务已移除”，记录removalComplete=true，活跃列表为空。命令未确认时启动按钮不可用，未选择Device时不会自动授予转发。

## 安装与保存

Companion和dev-services的rc.2包已通过官方plugin manager安装到常驻DSH 0.2.1-rc.5。当前启动批次无插件加载错误；未登录的管理API保持拒绝访问。既有Browser Fleet、Worktree和移动密码插件的版本与包manifest校验一致，原profile patch校验一致；旧版与新版DSH均在运行。

原始开发现场和完整共享Git已有恢复验证的私有归档。运行插件从独立安装包加载；源码、测试与设计记录通过Git保存。合入结果、正式仓库位置和临时目录清理证据保存在部署记录中。

## 未验证范围

真实Mac端安装或升级、两台设备的实际数据路径、休眠与断网恢复尚未验证。Linux readiness及设备本地TCP probe不能证明应用业务可用。此次交付未自动配对设备或迁移旧版转发授权。
