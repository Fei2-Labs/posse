# 远程访问配置 - Cloudflare Tunnel

## 访问信息

| 项目 | 值 |
|------|-----|
| 公网地址 | `https://<your-domain>` |
| 本地端口 | 9800 |
| 隧道名称 | `<your-tunnel-name>` |
| 隧道 ID | `<your-tunnel-id>` |

## 配置原则

- 仓库内的 `cloudflared-config.yml` 只是模板，用于 GitHub 提交，不保证可直接运行
- 本机真实配置请放在 `frp/cloudflared-config.local.yml` 或 `frp/cloudflared-config.private.yml`
- 真实 tunnel 名称、域名、`credentials-file` 绝对路径不要提交到仓库

## 快速开始

### 1. 启动 DuoCLI
先确保 DuoCLI 桌面应用已启动，它会自动在 `http://localhost:9800` 启动服务。

### 2. 启动 Cloudflare Tunnel

先复制模板并填写你自己的 tunnel 名称、域名和本机凭证绝对路径，再执行：

```bash
cd /path/to/DuoCLI/frp
cp cloudflared-config.yml cloudflared-config.local.yml
```

然后编辑 `cloudflared-config.local.yml`：

```bash
# 启动
./start-cloudflared.sh

# 查看状态
./status-cloudflared.sh

# 停止
./stop-cloudflared.sh
```

### 3. 手机访问

打开手机浏览器，访问：
```
https://<your-domain>
```

输入 Token 即可连接。

## 一键全启

双击桌面上的 `DuoCLI一键启动.command`，会依次启动：
1. cc-connect
2. Cloudflare Tunnel
3. DuoCLI 桌面应用

## 脚本说明

| 脚本 | 功能 |
|------|------|
| `start-cloudflared.sh` | 启动 Cloudflare Tunnel（带检查） |
| `stop-cloudflared.sh` | 停止 Cloudflare Tunnel |
| `status-cloudflared.sh` | 查看运行状态 |
| `cloudflared-config.yml` | Git 仓库模板配置 |
| `cloudflared-config.local.yml` | 本机私有配置（推荐） |
| `创建桌面启动器.command` | 生成桌面 AppleScript 启动器 |

## 配置文件

| 文件 | 用途 |
|------|------|
| `cloudflared-config.yml` | 模板配置 |
| `cloudflared-config.local.yml` | 本机真实入口配置 |
| `~/.cloudflared/cert.pem` | Cloudflare 登录凭证 |
| `~/.cloudflared/<your-tunnel-id>.json` | Tunnel 凭证 |

## 与旧方案 (FRP) 的区别

| 对比项 | FRP (旧) | Cloudflare Tunnel (新) |
|--------|----------|----------------------|
| 公网地址 | `http://<your-server>:9800` | `https://<your-domain>` |
| HTTPS | ❌ 无 | ✅ 自动 |
| 需要自己的服务器 | ✅ 阿里云 | ❌ 不需要 |
| 需要开放端口 | ✅ 7000/9800/42100 | ❌ 不需要 |
| 依赖 | frpc 二进制 | cloudflared (brew install cloudflared) |

## 开机自启动（可选）

使用 launchd：

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.duocli.cloudflared.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.duocli.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>tunnel</string>
        <string>--config</string>
        <string>/path/to/DuoCLI/frp/cloudflared-config.yml</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/DuoCLI/frp/cloudflared.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/DuoCLI/frp/cloudflared-error.log</string>
</dict>
</plist>
EOF
```

加载并启动：
```bash
launchctl load ~/Library/LaunchAgents/com.duocli.cloudflared.plist
```

## 常见问题

### 1. Tunnel 连不上
- 检查 `cloudflared` 是否已安装：`which cloudflared`
- 检查凭证文件是否存在：`ls ~/.cloudflared/cert.pem`
- 查看日志：`cat cloudflared.log`
- 检查本机私有配置是否仍是模板占位符：`./status-cloudflared.sh`

### 2. 手机无法访问
- 确认 Tunnel 正在运行：`./status-cloudflared.sh`
- 确认 DuoCLI 本地服务已启动（端口 9800）
- 尝试 `curl https://<your-domain>` 测试

### 3. 重新登录 Cloudflare
```bash
cloudflared tunnel login
```
