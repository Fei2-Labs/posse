# Windows 开发环境踩坑记录

> **Purpose**: 记录在 Volvo 公司 Windows 环境下开发 Posse 时遇到的问题和解决方案。

---

## 1. Electron 二进制安装失败（ffmpeg.dll not found）

**症状**: 运行 `pnpm start` 报错 "The code execution cannot proceed because ffmpeg.dll was not found"

**根因**: 公司网络有 TLS 拦截（self-signed cert in chain），`electron` 包的 `install.js` 无法从 GitHub 下载 Electron 二进制文件。zip 缓存可能存在于 `%LOCALAPPDATA%\electron\Cache\` 但未被解压。

**修复步骤**:

```powershell
# 1. 检查缓存是否已有 zip
Get-ChildItem "$env:LOCALAPPDATA\electron\Cache"

# 2. 手动解压到 node_modules
$dest = "node_modules\.pnpm\electron@<VERSION>\node_modules\electron\dist"
New-Item -ItemType Directory -Path $dest -Force
Expand-Archive -Path "$env:LOCALAPPDATA\electron\Cache\electron-v<VERSION>-win32-x64.zip" -DestinationPath $dest -Force

# 3. 写入 path.txt（electron 的 index.js 靠这个文件定位二进制）
"electron.exe" | Out-File -Encoding ascii -NoNewline "node_modules\.pnpm\electron@<VERSION>\node_modules\electron\path.txt"

# 4. 验证
$env:NODE_OPTIONS=''; node -e "console.log(require('electron'))"
```

**预防**: 如果在有正常网络的环境下先 `pnpm install` 一次，缓存会留在 `%LOCALAPPDATA%\electron\Cache\`。

---

## 2. Daemon 进程随 App 退出而死亡（Windows Job Object）

**症状**: 关闭 Posse app 后 daemon 也消失了，live sessions 丢失。macOS 无此问题。

**根因**: Electron 在 Windows 上会把子进程放入同一个 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）。当 Electron 退出时 Windows 终止整个 Job，即使子进程设置了 `detached: true` + `child.unref()`。

**修复**: 在 Windows 上用 `cmd.exe /c start /b` 启动 daemon，使其脱离 Electron 的 Job Object：

```typescript
if (process.platform === 'win32') {
  const child = spawn('cmd.exe', ['/c', 'start', '/b', '', process.execPath, daemonScript], {
    detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  child.unref();
} else {
  const child = spawn(process.execPath, [daemonScript], {
    detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  child.unref();
}
```

**涉及文件**: `src/main/pty-daemon-client.ts`（startDaemon）、`src/main/pty-daemon.ts`（self-respawn）

---

## 3. NODE_OPTIONS 冲突

**症状**: `pnpm build` 报错 `--use-system-ca is not allowed in NODE_OPTIONS`

**根因**: 公司环境设置了全局 `NODE_OPTIONS=--use-system-ca`，某些 Node 版本不支持。

**修复**: 构建前清除：

```powershell
$env:NODE_OPTIONS=''; pnpm build
```

---

## 4. electron-builder rebuild 失败（self-signed cert）

**症状**: `pnpm build` 在 electron-builder 的 `@electron/rebuild` 步骤报 `SELF_SIGNED_CERT_IN_CHAIN`

**根因**: electron-builder 尝试下载 Electron headers 来重编译 node-pty，被公司 TLS 拦截。

**变通**: 如果 node-pty 已经编译好（之前在正常网络下安装过），可以跳过 rebuild 或用 `$env:NODE_TLS_REJECT_UNAUTHORIZED='0'`（仅开发环境）。TypeScript 编译和 esbuild 打包不受影响。
