# 统一启动与恢复

用户入口是 DSH → Settings → Companion Devices 生成的同一条拉取执行命令。无须手动下载 CLI、选择 setup/update、复制 Library 文件或执行 launchctl。

```bash
curl --disable -fsS --proto '=https' https://YOUR_DSH_HOST/api/companion/bootstrap.sh | bash -s -- https://YOUR_DSH_HOST
```

请使用页面生成的真实 origin。需要 Device 已有 Node.js 22+，初次询问本机 SSH alias。HTTPS 验证不会被绕过；测试 HTTP 必须明确许可。脚本只清理自己创建的临时目录，下载完整 bundle 并核对与脚本绑定的 SHA-256 后执行。SHA-256 不替代 TLS 和对脚本来源的信任。

## 首次运行

终端显示非秘密验证码，并打开 DSH。登录后到 Companion Devices，核对自己的 Device 终端验证码，勾选确认并允许。后台通过随机轮询能力获取凭证并存入 Keychain，不在 argv、URL、配置或日志中放配对秘密。授权请求本身不授予任何 Lease。

## 再次运行

拉取当前 Host 的新 bundle，先检查 Host 身份及已保存凭证。有效配对直接安全停止已知旧进程、更新并启动新进程，即使文件版本已相同也重新启动。原配对、配置、Forward Lease 和运行诊断保留。用户主动运行命令且 Host 验证成功后，可触发一次明确的 WSS 重连，区别于后台自动重试。

## 后台断线恢复

CLI 0.1.9 起，普通断网、心跳超时、HTTP 408/429/5xx 持续退避重连，最长间隔 30 秒；睡眠唤醒后处理已过期的重连计时。CLI 0.1.10 起，SSH 退出、启动/命令超时、链路或 listener 丢失等 Forward Instance 瞬态故障也持续退避重试。CLI 0.1.11 起，控制器本地故障会先关闭并确认自有 SSH，再持续退避重连；旧版本遗留的 `LOCAL_ERROR` 阻断仅在新 daemon 完成 SSH 所有权恢复检查后解除。CLI 0.1.12 以 SSH 主进程 `exit` 作为 listener 释放证明，不再因后代进程延迟关闭继承的 stdout/stderr 管道而误报 `CLEANUP_FAILED`。重启恢复遇到仅剩私有 `owner.json`、control socket 已消失的目录时，只有保存的 PID 也被 `ps` 明确证明不存在才删除孤儿元数据；PID 仍存在、复用或无法查询都保持阻断。CLI 0.1.13 对主进程退出后 control socket 同时消失造成的私有目录删除竞态执行三次短暂有界重试；只有 `EBUSY`、`EMFILE`、`ENFILE`、`ENOTEMPTY` 或 `EPERM` 会重试，其他错误和重试耗尽仍停止自动连接。status 额外记录白名单化的 `lastCleanupErrorCode`，不写入路径或原始错误。主进程确实无法退出或所有权无法确认时仍停止自动连接。所有自动重试最长间隔 30 秒，成功后连续失败计数归零；不会取消 Device 睡眠、创建新的 Lease 或延长已有 TTL。

Host 0.1.13 在新的 Connection Session 收到 persisted `recovering` 快照后重新下发 fenced Open，并持续重发未确认的幂等 operation。CLI 与 Host 两端都升级后，普通断线恢复不需要点击“重新检查”。认证、Host Key、端口占用、策略拒绝、撤销和到期仍安全停止自动恢复。

CLI 修复必须安装到 Device；单独升级 Host 不会替换已运行的 CLI。Host 分发新版后，在 Device 重跑该 Host 页面生成的统一命令，并用已安装 CLI 的 `--version` 确认版本为 0.1.13 或更新。status 中的 `nextReconnectAt`、`lastDisconnectReason` 等是持久诊断，不等同实时在线；认证、证书、协议、凭证、状态写入或清理失败等安全阻断不会因后台重启自动清除。

## Host 改变或配对失效

同一 DSH_HOME 的普通重启保留配对；另一个测试 Home 是不同 Authority。统一入口先读取公开身份；不会把旧 token 发送到改变的 origin。身份重建或凭证被拒绝时，终端明确要求确认，再通过新的浏览器批准重新绑定。新安装身份和 Device 不继承旧 Lease。旧凭证在新绑定本地启动成功前保留用于回滚；不会先卸载旧安装。

WSS 收到凭证拒绝或 Authority 不匹配时，关闭自有 SSH，记录 needs_pairing 并停止自动认证尝试。后台进程存在不代表仍被 Host 信任。普通网络失败不会被当成新的配对授权。

## 中断和失败

替换及配对切换有私有备份、哈希和事务记录。常规失败尝试回滚；再次运行同一条统一命令可处理可验证的未完成配对事务。Ctrl-C/SIGTERM 会请求取消并等待本地清理；不能取消已经由管理员完成的远端批准，必要时在页面撤销没有使用的 Device。

停止请求返回不等于 daemon 已完成收尾。统一启动分别给 LaunchAgent 注销、已验证旧 daemon 的锁释放提供默认 10 秒轮询窗口；只等待，不重复发送停止请求或回收活 PID 的锁。等待时释放自己的 acquisition mutex；锁身份变化、未知注册状态或 PID 探测权限错误立即拒绝。已停机但留下 stopping journal 的安装仍由同一启动命令恢复。

不明锁、文件归属改变、损坏记录或不能确认停止时会安全拒绝并保留恢复材料。SIGKILL/断电残留不明 .install.lock 或 daemon.lock.reclaim 不会被盲目删除。不要通过删锁、删 Keychain、关 Host Key 校验或杀未知 PID 绕过。

新版本的本地 bootId、Device、版本、活 PID 和锁证明本地初始化；不等同 WSS、SSH、监听端口或应用健康。旧版回滚只可证明 LaunchAgent 注册。

## 测试实例运维

开发固定 PDM 项目 ID 和数据 Home，每个 Home 同时只运行一个 Host。清洁验证/另建项目使用隔离的数据库，不将两个实例的 state.json 合并或共享。稳定 DSH 的变更仍须 PDM 队列，统一 Device 启动脚本不会更改稳定 Host。
