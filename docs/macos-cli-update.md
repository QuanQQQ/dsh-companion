# 将已安装的 Mac Companion 更新到 0.1.2

适用于已完成 setup、后台 LaunchAgent 已加载的 0.1.0/0.1.1 安装。0.1.2 修复 OpenSSH 默认混合大小写键名导致的 SSH_CONFIG_UNSAFE。无需修改 SSH 配置。

## 下载与更新

先从隔离 DSH 的 Companion Devices 页面重新下载 CLI，保存为 `~/Downloads/dsh-companion.mjs`，覆盖旧下载。不要重新执行 setup 或 uninstall；setup 不负责升级，uninstall 会删除本地配对凭证。

下面操作会短暂停止此 Mac 的 Companion 和它负责的转发。它只替换固定 CLI bundle，保留 Keychain、config.json、runtime-state.json 和原 LaunchAgent plist，不修改代理或 SSH 配置。旧 bundle 会保留为唯一命名的备份。

在 Mac Terminal 执行，不使用 sudo：

```bash
(
  set -e
  src="$HOME/Downloads/dsh-companion.mjs"
  app="$HOME/Library/Application Support/DSH Companion"
  [ "$(node "$src" --version)" = "dsh-companion 0.1.2" ] || { echo "请先下载 0.1.2 CLI"; exit 1; }
  [ -f "$app/dsh-companion.mjs" ] && [ ! -L "$app/dsh-companion.mjs" ]
  backup="$(mktemp "$app/cli-backup.XXXXXX")"
  staged="$(mktemp "$app/cli-update.XXXXXX")"
  trap 'rm -f "$staged"' EXIT
  cp "$app/dsh-companion.mjs" "$backup"
  cp "$src" "$staged"
  chmod 700 "$staged"
  printf '旧程序备份：%s\n' "$backup"
  /bin/launchctl bootout "gui/$(id -u)/dev.deepseek.dsh-companion"
  mv "$staged" "$app/dsh-companion.mjs"
  /bin/launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.deepseek.dsh-companion.plist"
)
```

任一步失败都会停止后续步骤。若出现错误，保留输出和备份并停止，不要删除 Keychain、手工删除锁、重复配对或跳过失败的停止操作。若 bootstrap 失败，磁盘上的新版与旧备份仍在，但后台服务可能未运行，需要单独诊断。

## 验证

```bash
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" --version
node "$HOME/Library/Application Support/DSH Companion/dsh-companion.mjs" status
```

固定安装路径的版本应为 `dsh-companion 0.1.2`。等待页面显示 Device 在线，再点服务卡片的“重新检查”。该动作不会延长原 Lease 的到期时间。若 Lease 已到期，需由用户重新授权创建新 Lease。

上述更新步骤是用户在 Mac 上显式执行的运维流程，不是自动升级器；尚未在本次 Linux 会话中执行真实 launchctl 操作。
