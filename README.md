# DuoCLI — 手机电脑实时同步的 AI 编程终端 | Use Claude Code on Your Phone, Sync with Desktop in Real-time

> 躺在床上写代码，蹲在马桶上 debug，洗着澡还能看 AI 跑任务
> Code from your bed, debug from the bathroom, monitor AI tasks while showering

<p align="center">
  <img src="docs/images/main-ui.png" alt="DuoCLI Main Interface" width="800"/>
</p>

<p align="center">
  <a href="https://github.com/saddism/DuoCLI/releases"><img src="https://img.shields.io/github/v/release/saddism/DuoCLI?style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/saddism/DuoCLI?style=flat-square" alt="License"></a>
  <a href="https://github.com/saddism/DuoCLI/stargazers"><img src="https://img.shields.io/github/stars/saddism/DuoCLI?style=flat-square" alt="Stars"></a>
</p>

---

**[中文](#中文介绍) | [English](#english-introduction)**

---

<a name="中文介绍"></a>
## 中文介绍

### 一句话描述

一个为 AI 编程时代设计的多终端管理器。基于 Electron，专为 Claude Code、Codex CLI、Gemini CLI、Kimi 等 AI 编程助手的多开工作流而打造。

### 核心卖点

**手机和电脑共享同一个终端。** 连上同一个 WiFi，手机上打的每一个字电脑上实时出现，电脑上 Claude Code 的每一行输出手机上同步滚动。不是远程桌面，不是屏幕投射——是真正的同一个终端会话，双向实时同步。

### 最近更新（2026-02-21）

- **Android 远程调试神器** — 远程开发时看不到手机界面？现在可以直接在手机端查看 Android 设备实时截图、点击操控、输入文字（支持中文），彻底解决远程调试无法看到 UI 的痛点
- **全屏控制模式** — 截图全屏展示，点击即操控，支持自动刷新（3/5/10/30秒），远程调试体验接近真机
- **远程文字输入** — 通过 ADBKeyboard 向 Android 设备输入中英文，无需触碰手机
- **自定义 ADB 命令** — 直接在手机端执行任意 adb shell 命令，部署应用、查看日志一气呵成
- **手机端会话状态和桌面端完全同步**：黄灯工作中、绿灯待确认、灰灯已读/不活跃
- **手机端支持直接改会话标题**：点击详情页标题即可重命名

### 为什么需要 DuoCLI

**离开电脑 ≠ 停止编程**

AI 编程助手跑一个任务经常要好几分钟。以前你只能干坐在电脑前等，或者走开了就不知道进度。现在：

- 让 Claude Code 重构一个模块 → 去沙发上躺着，手机上看它实时输出
- AI 跑完了问你 "要不要继续？" → 手机上直接打 `y` 回车，不用跑回电脑前
- 半夜想到一个 bug → 床上掏出手机，直接在运行中的终端里操作
- 上厕所的时候 → 手机上继续盯着 AI 干活，顺便给它下一步指令

**不需要重开终端，不需要重启上下文。** 你的手机就是电脑终端的延伸，走到哪带到哪。

**同时，DuoCLI 也解决了终端跑 AI 的老痛点：**

- **窗口混乱** — 同时开着 Claude、Codex、Gemini，一堆 "zsh" 标签根本分不清谁是谁
- **回滚困难** — AI 改了一堆代码，效果不对想回退，但已经搞不清改了哪些文件
- **对话丢失** — 终端关了就没了，之前 AI 说了什么、改了什么，全部消失
- **重复配置** — 每个 AI 工具都要单独配 API Key，明明机器上已经有了

### Android 远程调试

> **远程开发最大的痛点：看不到手机界面。**
>
> 你在异地用 SSH 连着开发机，Claude Code 帮你写好了代码，`adb install` 也成功了——但你根本不知道 App 跑起来长什么样，UI 对不对，有没有崩溃。以前你只能干等，或者让别人帮你看，或者放弃远程回到电脑旁边。
>
> **现在不需要了。**

DuoCLI 内置 Android 远程调试功能，通过手机端 PWA 直接操控连接在开发机上的 Android 设备：

- **实时截图** — 一键获取 Android 设备当前画面，全屏展示，比例完整
- **点击操控** — 点击截图的任意位置，对应坐标实时发送到手机，点完自动刷新截图
- **自动刷新** — 设置 3/5/10/30 秒间隔自动截图，像看直播一样监控 App 运行状态
- **文字输入** — 支持中英文输入，通过 ADBKeyboard 精准发送到 Android 设备
- **自定义命令** — 执行任意 `adb shell` 命令：安装 APK、查看进程、清除数据、触发 deeplink……

```
你在外地 → 手机打开 DuoCLI → 点击"手机设备" → 看到 Android 实时画面 → 点击操控 → 部署验证
```

**典型场景：**
- Claude Code 帮你改了 UI，`adb install` 后直接在手机上看效果，不用回到电脑旁
- 远程调试崩溃：截图看到错误弹窗，执行 `adb logcat` 命令查日志
- 自动化测试：让 AI 写脚本，你在手机上实时看执行过程

#### 使用方式

1. 开发机连接 Android 设备（USB 或 WiFi ADB）
2. 手机端打开 DuoCLI，点击右上角 📱 进入设备页
3. 选择设备 → 点 📷 获取截图 → 点 ⛶ 进入全屏控制模式
4. 开启 🖱 远程控制后，点击截图即可操控手机

### 手机同步功能

#### 工作原理

```
┌──────────┐     WiFi / 局域网      ┌──────────┐
│  手机浏览器  │ ◄──── WebSocket ────► │  电脑桌面端  │
│  (PWA)    │     实时双向同步       │ (Electron) │
└──────────┘                       └──────────┘
                同一个终端会话
           手机输入 ⟷ 电脑输入 完全等价
```

- **零配置连接** — 电脑启动 DuoCLI 后自动开启局域网服务，手机浏览器输入地址即可连接
- **真正的双向同步** — 不是投屏，是共享同一个 PTY 进程。手机上按 `Ctrl+C`，电脑上的进程也会中断
- **断线自动重连** — WiFi 切换、手机锁屏后重新打开，2 秒内自动恢复连接，终端历史完整保留
- **手机端完整功能** — 创建/切换/删除会话、上传文件（最大 50MB）、快捷键栏（方向键、Tab、Ctrl+C 等）
- **Web Push 通知** — 检测到「任务完成 / 需要你决策 / 会话结束」时，手机收到推送
- **iMessage 通知（可选）** — macOS 可同步发 iMessage 给你，离开浏览器也能收到提醒
- **iOS 深度适配** — 全屏模式、键盘自适应、触摸滚动，原生 App 般的体验
- **PWA 离线支持** — 添加到主屏幕后像原生 App 一样使用，静态资源自动缓存

#### 使用方式

1. 电脑启动 DuoCLI，底部状态栏会显示局域网地址（如 `http://192.168.1.100:9800`）
2. 手机浏览器打开该地址
3. 输入 Token 登录（Token 在电脑端首次启动时自动生成，存储在 `~/.duocli-mobile/config.json`）
4. 开始使用 — 手机上看到的就是电脑上的终端，打字、滚动、切换会话，一切实时同步

#### 可选：开启 iMessage 通知（macOS）

```bash
DUOCLI_IMESSAGE_TO="你的手机号或邮箱" npm start
# 可选：DUOCLI_IMESSAGE_SERVICE=SMS
```

- 未设置 `DUOCLI_IMESSAGE_TO` 时，仅使用 Web Push。
- 触发场景：任务完成、需要你决策、会话结束。

### 截图

**桌面端主界面**
<p align="center">
  <img src="docs/images/main-ui.png" alt="主界面" width="700"/>
</p>

**手机端 AI 工具选择** — 支持 Claude、Codex、Gemini、Kimi 等多种 AI 编程助手
<p align="center">
  <img src="docs/images/mobile-ai-selector.jpg" alt="手机端 AI 工具选择" width="350"/>
</p>

**手机端实时操作 Claude Code** — 躺在床上也能写代码
<p align="center">
  <img src="docs/images/mobile-claude-demo.jpg" alt="手机端 Claude Code 操作" width="350"/>
</p>

**AI 配置自动扫描**
<p align="center">
  <img src="docs/images/ai-config.png" alt="AI 配置" width="700"/>
</p>

### 安装

#### 源码构建

```bash
git clone https://github.com/saddism/DuoCLI.git
cd DuoCLI

# 安装依赖
npm install

# 编译原生模块（node-pty）
npm run rebuild

# 开发模式运行
npm start

# 构建安装包
npm run build:mac   # macOS
npm run build:win   # Windows（需在 Windows 上执行）
npm run build:linux # Linux
```

#### 系统要求

- macOS / Windows / Linux
- Node.js >= 18
- Windows 需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（编译 node-pty）

### 全部功能

#### 手机实时同步

- 局域网 WebSocket 双向同步，手机和电脑共享同一个终端进程
- 手机端支持创建/切换/删除会话、上传文件、快捷键操作
- Web Push 通知，AI 任务完成时手机推送提醒
- 支持通知触发：任务完成、需要决策、会话结束
- macOS 可选 iMessage 通知（通过环境变量启用）
- PWA 支持，添加到主屏幕后像原生 App 使用
- Token 认证，保障安全性
- 断线自动重连，历史缓冲区完整回放
- iOS 全屏适配、键盘自适应、触摸滚动

#### 多终端会话管理

- 创建多个独立终端，每个可指定预设命令（Claude、Codex、Gemini、Kimi 等）
- 支持普通模式和全自动模式（Claude `--dangerously-skip-permissions`、Codex `--full-auto`、Gemini/Kimi `--yolo`）
- 会话列表实时显示标题、最后活跃时间和工作目录
- 会话置顶、手动重命名、未读标记
- 三色状态指示灯：🟡 工作中 → 🟢 等待输入 → ⚪ 已读，状态自动流转
- 关闭应用时自动检测运行中的终端并弹出确认提示

#### 催工模式（Auto-Continue）

让 AI 不停歇地干活。配置一段催工文本，DuoCLI 按设定间隔自动发送给终端，让 Claude Code 等 AI 助手持续工作不停顿。

- **多行催工文本** — 支持复杂的多行指令，不只是简单的 "continue"
- **可配置发送延迟** — 文字写入后等待指定秒数再发送回车，避免长文本粘贴失败
- **自动同意权限提示** — 检测到 CLI 的 "Do you want to..." 确认弹窗时自动选择 Yes，可配置延迟
- **每会话独立配置** — 每个终端会话有自己的催工设置，互不干扰
- **配置持久化** — 催工文本和参数自动保存，重启不丢失
- **手机端远程控制** — 手机上也能开关催工、修改配置

#### AI 智能标题

- 自动调用 AI 分析终端输出，生成简短的中文标题
- 支持多种 AI 后端：Anthropic Claude、OpenAI、Google Gemini、DeepSeek、MiniMax、ZhipuAI、本地 Ollama
- 自动扫描本机已有的 AI 工具配置，零配置即用

#### 目录树与文件操作

- 左侧目录树实时显示工作目录结构，支持展开/折叠
- 右键菜单：复制绝对路径、在 Finder 中打开、用编辑器打开、插入路径到终端
- 目录行悬浮 📂 按钮，一键在 Finder 中打开
- 底部状态栏实时显示最近修改的文件

#### 其他

- 终端输出中的文件路径自动识别为可点击链接，点击用编辑器打开
- 内置 6 套配色方案 + 自动配色：VS Code Dark、Monokai、Dracula、Solarized Dark、One Dark、Nord
- 自定义 CLI 预设管理，保存常用的命令行组合
- 终端尺寸智能自适应，窗口缩放、面板拖拽后自动重新计算行列数
- 剪贴板图片/文件粘贴，直接将图片路径或文件路径插入终端

### 使用方法

1. 启动后在顶部设置**工作目录**
2. 选择**预设命令**（Claude、Codex、Gemini 等，或留空打开普通终端）
3. 选择**配色方案**
4. 点击 **"+ 新建终端"**

#### AI 配置

DuoCLI 不提供任何 AI 服务，也不需要额外配置 API Key — 只是读取你本机已有的 AI 工具配置。你原来能用什么，这里就能用什么。

切换到右侧 **"AI"** 标签页，点击 **"扫描并测试"**，自动检测并验证本机可用的 AI 服务。

支持自动扫描的配置来源：

| AI 工具 | 配置文件路径 |
|---------|-------------|
| Claude Code | `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.json`、`~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/.env` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Aider | `~/.aider/env.sh` |
| DeepSeek | Shell 环境变量 `DEEPSEEK_API_KEY` |
| MiniMax | Shell 环境变量 `MINIMAX_API_KEY` |
| ZhipuAI | Shell 环境变量 `ZHIPUAI_API_KEY` |
| Ollama | 本地 `http://127.0.0.1:11434` |
| Shell 环境变量 | `~/.zshrc`、`~/.bashrc` 中的 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等 |

---

<a name="english-introduction"></a>
## English Introduction

### One-liner

A multi-terminal manager designed for the AI coding era. Built on Electron, crafted for multi-session workflows with Claude Code, Codex CLI, Gemini CLI, Kimi, and other AI coding assistants.

### Core Selling Point

**Your phone and computer share the same terminal.** Connect to the same WiFi, and every keystroke on your phone appears on your computer in real-time. Every line of output from Claude Code on your computer scrolls simultaneously on your phone. Not remote desktop, not screen mirroring — it's a true shared terminal session with bidirectional real-time sync.

### Latest Updates (2026-02-21)

- **Android Remote Debugging** — Can't see your phone's UI during remote development? Now you can view real-time Android screenshots, tap to control, and type text (including Chinese) directly from your phone — solving the #1 pain point of remote mobile development
- **Fullscreen Control Mode** — Screenshots displayed fullscreen, tap to control, auto-refresh (3/5/10/30s), remote debugging experience close to hands-on
- **Remote Text Input** — Send Chinese and English text to Android devices via ADBKeyboard, no need to touch the phone
- **Custom ADB Commands** — Execute any `adb shell` command from your phone: deploy APKs, check logs, all in one flow
- **Mobile session status now matches desktop semantics**: yellow = running, green = awaiting input, gray = inactive/read
- **Rename sessions directly on mobile**: tap the session title in detail view

### Why You Need DuoCLI

**Leaving your computer ≠ Stopping coding**

AI coding assistants often take several minutes to run a task. Previously, you'd either sit idly waiting or walk away and lose track of progress. Now:

- Let Claude Code refactor a module → Lie on the couch and watch it output in real-time on your phone
- AI finishes and asks "Continue?" → Type `y` and hit enter on your phone, no need to run back to your desk
- Think of a bug at midnight → Pull out your phone in bed and operate directly in the running terminal
- While in the bathroom → Keep monitoring AI's work on your phone and give it the next command

**No need to reopen terminals, no need to restart contexts.** Your phone is an extension of your computer terminal, take it wherever you go.

**Meanwhile, DuoCLI also solves the old pain points of running AI in terminals:**

- **Window chaos** — Running Claude, Codex, Gemini simultaneously, a bunch of "zsh" tabs that you can't tell apart
- **Rollback difficulty** — AI changed a bunch of code, effects aren't right and you want to revert, but can't figure out what files were changed
- **Conversation loss** — Terminal closes and it's gone. What the AI said and changed before, all disappears
- **Repeated configuration** — Every AI tool needs its own API Key configuration, even though your machine already has them

### Android Remote Debugging

> **The biggest pain point of remote development: you can't see the phone's UI.**
>
> You're SSH'd into a dev machine from another location. Claude Code wrote the code, `adb install` succeeded — but you have no idea what the app looks like, whether the UI is correct, or if it crashed. Previously you'd have to wait, ask someone else to check, or give up and go back to your desk.
>
> **Not anymore.**

DuoCLI has built-in Android remote debugging. Control Android devices connected to your dev machine directly from the mobile PWA:

- **Live screenshots** — Capture the current Android screen instantly, displayed fullscreen with correct aspect ratio
- **Tap to control** — Tap anywhere on the screenshot, coordinates are sent to the device in real-time, screenshot auto-refreshes after each tap
- **Auto-refresh** — Set 3/5/10/30 second intervals for automatic screenshots, monitor your app like a live stream
- **Text input** — Chinese and English input via ADBKeyboard, sent precisely to the Android device
- **Custom commands** — Run any `adb shell` command: install APKs, inspect processes, clear data, trigger deeplinks…

```
You're away → Open DuoCLI on phone → Tap "Device" → See Android live → Tap to control → Deploy & verify
```

**Typical scenarios:**
- Claude Code updated your UI, `adb install` done — check the result on your phone without going back to your desk
- Remote crash debugging: screenshot shows the error dialog, run `adb logcat` to get logs
- Automated testing: let AI write scripts, watch execution in real-time from your phone

#### How to Use

1. Connect Android device to dev machine (USB or WiFi ADB)
2. Open DuoCLI on your phone, tap 📱 in the top-right to enter Device page
3. Select device → tap 📷 for screenshot → tap ⛶ for fullscreen control mode
4. Enable 🖱 remote control, then tap the screenshot to control the device

### Mobile Sync Features

#### How It Works

```
┌─────────────┐     WiFi / LAN       ┌─────────────┐
│ Mobile      │ ◄─── WebSocket ─────►│ Desktop     │
│ Browser     │    Real-time Sync    │ (Electron)  │
│ (PWA)       │                      │             │
└─────────────┘                      └─────────────┘
              Shared Terminal Session
       Mobile Input ⟷ Desktop Input Equally Valid
```

- **Zero-config connection** — DuoCLI automatically starts a LAN service when launched; just enter the address in your mobile browser
- **True bidirectional sync** — Not screen mirroring, but sharing the same PTY process. Press `Ctrl+C` on your phone, the process on your computer also interrupts
- **Auto-reconnect** — WiFi switching, phone screen lock, reopen within 2 seconds to automatically restore connection with complete terminal history
- **Full mobile functionality** — Create/switch/delete sessions, upload files (up to 50MB), shortcut bar (arrow keys, Tab, Ctrl+C, etc.)
- **Web Push notifications** — Phone receives push when "task complete / decision needed / session ended" is detected
- **iMessage notifications (optional)** — macOS can send iMessage alerts, so you get notified even outside the browser
- **Deep iOS optimization** — Full-screen mode, keyboard adaptation, touch scrolling, native app-like experience
- **PWA offline support** — Add to home screen for native app-like usage, static resources automatically cached

#### Usage

1. Launch DuoCLI on your computer; the LAN address will be displayed in the status bar (e.g., `http://192.168.1.100:9800`)
2. Open the address in your mobile browser
3. Enter the Token to log in (Token is auto-generated on first desktop launch, stored in `~/.duocli-mobile/config.json`)
4. Start using — what you see on your phone is your computer's terminal; typing, scrolling, switching sessions, everything syncs in real-time

#### Optional: Enable iMessage Notifications (macOS)

```bash
DUOCLI_IMESSAGE_TO="your-phone-or-email" npm start
# Optional: DUOCLI_IMESSAGE_SERVICE=SMS
```

- Without `DUOCLI_IMESSAGE_TO`, only Web Push is used.
- Triggers: task complete, decision needed, session ended.

### Screenshots

**Desktop Main Interface**
<p align="center">
  <img src="docs/images/main-ui.png" alt="Main Interface" width="700"/>
</p>

**Mobile AI Tool Selection** — Supports Claude, Codex, Gemini, Kimi and more
<p align="center">
  <img src="docs/images/mobile-ai-selector.jpg" alt="Mobile AI Tool Selection" width="350"/>
</p>

**Mobile Claude Code Operation** — Code from your bed
<p align="center">
  <img src="docs/images/mobile-claude-demo.jpg" alt="Mobile Claude Code Demo" width="350"/>
</p>

**AI Configuration Auto-Scan**
<p align="center">
  <img src="docs/images/ai-config.png" alt="AI Configuration" width="700"/>
</p>

### Installation

#### Build from Source

```bash
git clone https://github.com/saddism/DuoCLI.git
cd DuoCLI

# Install dependencies
npm install

# Compile native modules (node-pty)
npm run rebuild

# Run in development mode
npm start

# Build installers
npm run build:mac   # macOS
npm run build:win   # Windows (run on Windows)
npm run build:linux # Linux
```

#### System Requirements

- macOS / Windows / Linux
- Node.js >= 18
- Windows requires [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (for compiling node-pty)

### Full Features

#### Mobile Real-time Sync

- LAN WebSocket bidirectional sync — phone and computer share the same terminal process
- Mobile support for creating/switching/deleting sessions, uploading files, shortcut operations
- Web Push notifications — phone push alerts when AI tasks complete
- Notification triggers: task complete, decision needed, session ended
- Optional iMessage notifications on macOS (via environment variable)
- PWA support — add to home screen for native app-like usage
- Token authentication for security
- Auto-reconnect with complete history buffer replay
- iOS full-screen adaptation, keyboard adaptation, touch scrolling

#### Multi-Terminal Session Management

- Create multiple independent terminals, each with customizable preset commands (Claude, Codex, Gemini, Kimi, etc.)
- Support for normal and fully automatic modes (Claude `--dangerously-skip-permissions`, Codex `--full-auto`, Gemini/Kimi `--yolo`)
- Session list displays title, last active time, and working directory in real-time
- Pin sessions, manual rename, unread indicators
- Three-color status indicator: 🟡 Working → 🟢 Awaiting input → ⚪ Read, auto-transitions
- Auto-detect running terminals and prompt for confirmation when closing the app

#### Auto-Continue Mode

Keep your AI working non-stop. Configure a prompt message and DuoCLI will automatically send it to the terminal at set intervals, keeping Claude Code and other AI assistants working continuously.

- **Multi-line prompt text** — Support complex multi-line instructions, not just a simple "continue"
- **Configurable send delay** — Wait specified seconds after text input before sending Enter, preventing long text paste failures
- **Auto-approve permission prompts** — Automatically selects Yes when CLI shows "Do you want to..." confirmation dialogs, with configurable delay
- **Per-session configuration** — Each terminal session has its own auto-continue settings, independent of others
- **Persistent configuration** — Auto-continue text and parameters are saved automatically, survive restarts
- **Remote control from mobile** — Toggle auto-continue and modify settings from your phone

#### AI Smart Titles

- Automatically call AI to analyze terminal output and generate short titles
- Support for multiple AI backends: Anthropic Claude, OpenAI, Google Gemini, DeepSeek, MiniMax, ZhipuAI, local Ollama
- Auto-scan existing AI tool configurations on your machine, zero-config ready to use

#### File Tree & File Operations

- Left sidebar file tree displays working directory structure in real-time, with expand/collapse
- Context menu: copy absolute path, open in Finder, open in editor, insert path into terminal
- Hover 📂 button on directories to open in Finder instantly
- Bottom status bar shows recently modified files in real-time

#### Others

- File paths in terminal output automatically recognized as clickable links, open in editor on click
- 6 built-in color schemes + auto-color: VS Code Dark, Monokai, Dracula, Solarized Dark, One Dark, Nord
- Custom CLI preset management, save frequently used command combinations
- Smart terminal resizing — auto-recalculates rows and columns after window resize or panel drag
- Clipboard image/file paste — directly insert image paths or file paths into the terminal

### How to Use

1. Set the **working directory** at the top after launching
2. Select a **preset command** (Claude, Codex, Gemini, etc., or leave blank for normal terminal)
3. Select a **color scheme**
4. Click **"+ New Terminal"**

#### AI Configuration

DuoCLI doesn't provide any AI services and doesn't require additional API Key configuration — it simply reads your existing AI tool configurations. If it worked before, it works here.

Switch to the **"AI"** tab on the right, click **"Scan & Test"**, and it will automatically detect and verify available AI services on your machine.

Supported auto-scan configuration sources:

| AI Tool | Configuration File Path |
|---------|------------------------|
| Claude Code | `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.json`, `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/.env` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Aider | `~/.aider/env.sh` |
| DeepSeek | Shell environment variable `DEEPSEEK_API_KEY` |
| MiniMax | Shell environment variable `MINIMAX_API_KEY` |
| ZhipuAI | Shell environment variable `ZHIPUAI_API_KEY` |
| Ollama | Local `http://127.0.0.1:11434` |
| Shell Environment | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc. in `~/.zshrc`, `~/.bashrc` |

---

## Project Structure | 项目结构

```
src/
├── main/                    # Electron main process | 主进程
│   ├── index.ts             # Entry, IPC registration, window creation | 入口，IPC 注册，窗口创建
│   ├── pty-manager.ts       # node-pty terminal management | 终端管理
│   ├── remote-server.ts     # Mobile sync service (Express + WebSocket) | 手机同步服务
│   ├── ai-config.ts         # AI config auto-scan & management | AI 配置自动扫描
│   └── ollama.ts            # AI calls (title generation / diff summary) | AI 调用
├── preload/
│   └── index.ts             # contextBridge security bridge | 安全桥接
├── renderer/                # Renderer process (UI) | 渲染进程
│   ├── app.ts               # App state & interaction logic | 应用状态与交互
│   ├── terminal-manager.ts  # xterm.js terminal management | 终端管理
│   ├── index.html           # Page structure | 页面结构
│   └── styles.css           # Styles | 样式
└── mobile/client/           # Mobile PWA | 手机端 PWA
    ├── index.html           # Mobile page | 移动端页面
    ├── app.js               # Mobile logic (WebSocket, terminal, session) | 移动端逻辑
    ├── style.css            # Mobile styles (iOS adaptation) | 移动端样式
    └── sw.js                # Service Worker (offline cache + Push) | 离线缓存
```

## Tech Stack | 技术栈

- **Electron** — Desktop app framework | 桌面应用框架
- **node-pty** — Native pseudo-terminal | 原生伪终端
- **xterm.js** — Terminal UI rendering (desktop + mobile shared) | 终端 UI 渲染
- **Express + WebSocket** — Mobile sync service | 手机同步服务
- **Web Push** — Mobile push notifications | 手机推送通知
- **Service Worker** — PWA offline support | PWA 离线支持
- **TypeScript** — Full project type safety | 全项目类型安全
- **esbuild** — Renderer process bundling | 渲染进程打包

## License | 许可证

[MIT](LICENSE)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/saddism">大壮好大 (saddism)</a>
</p>
