# 一键更新已安装的 Mac Companion

从包含 update 命令的新版下载包（0.1.3 起）更新已安装的 Companion，包括 0.1.0–0.1.2。无需先卸载、重新配对或手工操作 LaunchAgent。

## 唯一更新命令

在 DSH → Companion Devices 的“更新 Companion”区域下载新版 CLI，覆盖 `~/Downloads/dsh-companion.mjs`，然后在 Mac 运行：

```bash
node "$HOME/Downloads/dsh-companion.mjs" update
```

每次更新都使用这条命令。update 使用正在执行的下载包，不从未知地址自动获取或执行代码；只重启旧安装路径的程序不会更新软件。

也可以重跑最初的 setup 命令：CLI 检测到已有配置且 Host、SSH alias、指定 Node 路径相同时，自动转入 update，不再要求新配对码。参数与旧配对不符时会拒绝，不能通过更新静默切换 Host 或 SSH alias。

## 自动处理

- 校验完整安装、私有文件、原 LaunchAgent plist 和已保存的 Node.js 22+ 运行时。
- 在停止前暂存并验证新版；内容相同且没有待恢复事务时不重复替换或重启。
- 停止固定用户 LaunchAgent，确认 daemon 停止后原子替换 bundle，再启动原 LaunchAgent，并等待目标版本的新本地启动标识。不会只凭 launchctl 返回 0 宣称新版已启动。
- 保留 Device 身份、Keychain、配置、原 Lease 到期时间和持久重试预算；不读写 SSH 配置或代理设置。
- 更新期间会短暂停止此 Mac 的转发。本地启动成功不等于 WSS 已在线；等待页面的 Device 在线后，如服务仍需处理，点击“重新检查”。

## 失败与恢复

常规替换或启动失败会尝试恢复旧 bundle 并重新启动旧服务。无法确认停止或回滚失败时保留备份和更新记录，输出具体错误，不强行覆盖、删除凭证或按未知 PID 杀进程。正常错误退出后，可再次运行同一条 update 命令处理待恢复事务。

SIGKILL、断电或文件被外部改动可能留下无法证明归属的 `.install.lock` / `daemon.lock.reclaim`。这类异常会安全停止并要求检查，不自动删除不明锁；不承诺所有系统级故障都可无人工恢复。待恢复更新记录存在时，setup/uninstall 不会破坏它。

## 查看版本

```bash
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" --version
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" status
```

本地 loaded/status 不代表 SSH 或远端应用健康。真实 macOS launchctl 行为仍以实机验收结果为准。
