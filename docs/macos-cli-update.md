# 统一启动与恢复

用户入口是 DSH → Settings → Companion Devices 生成的同一条拉取执行命令。无须手动下载 CLI、选择 setup/update、复制 Library 文件或执行 launchctl。

```bash
curl --disable -fsS --proto '=https' https://YOUR_DSH_HOST/api/companion/bootstrap.sh | bash -s -- https://YOUR_DSH_HOST
```

请使用页面生成的真实 origin。需要 Mac 已有 Node.js 22+，初次询问本机 SSH alias。HTTPS 验证不会被绕过；测试 HTTP 必须明确许可。脚本只清理自己创建的临时目录，下载完整 bundle 并核对与脚本绑定的 SHA-256 后执行。SHA-256 不替代 TLS 和对脚本来源的信任。

## 首次运行

终端显示非秘密验证码，并打开 DSH。登录后到 Companion Devices，核对自己的 Mac 终端验证码，勾选确认并允许。后台通过随机轮询能力获取凭证并存入 Keychain，不在 argv、URL、配置或日志中放配对秘密。授权请求本身不授予任何 Lease。

## 再次运行

拉取当前 Host 的新 bundle，先检查 Host 身份及已保存凭证。有效配对直接安全停止已知旧进程、更新并启动新进程，即使文件版本已相同也重新启动。原配对、配置、Forward Lease 和 Forward Instance 重试预算保留。用户主动运行命令且 Host 验证成功后，可触发一次明确的 WSS 重连，区别于后台自动重试。

## Host 改变或配对失效

同一 DSH_HOME 的普通重启保留配对；另一个测试 Home 是不同 Authority。统一入口先读取公开身份；不会把旧 token 发送到改变的 origin。身份重建或凭证被拒绝时，终端明确要求确认，再通过新的浏览器批准重新绑定。新安装身份和 Device 不继承旧 Lease。旧凭证在新绑定本地启动成功前保留用于回滚；不会先卸载旧安装。

WSS 收到凭证拒绝或 Authority 不匹配时，关闭自有 SSH，记录 needs_pairing 并停止自动认证尝试。后台进程存在不代表仍被 Host 信任。普通网络失败不会被当成新的配对授权。

## 中断和失败

替换及配对切换有私有备份、哈希和事务记录。常规失败尝试回滚；再次运行同一条统一命令可处理可验证的未完成配对事务。Ctrl-C/SIGTERM 会请求取消并等待本地清理；不能取消已经由管理员完成的远端批准，必要时在页面撤销没有使用的 Device。

不明锁、文件归属改变、损坏记录或不能确认停止时会安全拒绝并保留恢复材料。SIGKILL/断电残留不明 .install.lock 或 daemon.lock.reclaim 不会被盲目删除。不要通过删锁、删 Keychain、关 Host Key 校验或杀未知 PID 绕过。

新版本的本地 bootId、Device、版本、活 PID 和锁证明本地初始化；不等同 WSS、SSH、监听端口或应用健康。旧版回滚只可证明 LaunchAgent 注册。

## 测试实例运维

开发固定 PDM 项目 ID 和数据 Home，每个 Home 同时只运行一个 Host。清洁验证/另建项目使用隔离的数据库，不将两个实例的 state.json 合并或共享。稳定 DSH 的变更仍须 PDM 队列，统一 Mac 启动脚本不会更改稳定 Host。
