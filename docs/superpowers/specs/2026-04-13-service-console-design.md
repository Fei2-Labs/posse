# DuoCLI 固定服务控制台设计

日期：2026-04-13

## 目标

在 DuoCLI 桌面端新增一个固定的“服务控制台”页面，统一管理与 DuoCLI 配套的三个服务：

1. `cc-connect`
2. `FRP`
3. DuoCLI 手机远程服务

其中 `cc-connect` 需要支持配置飞书 `app_id` 和 `app_secret`，并在保存后自动重启生效。

## 非目标

- 不做“任意脚本面板”或通用脚本执行器。
- 不提供“启动 DuoCLI.app”按钮。应用已经运行时再启动自身没有实际价值。
- 不把服务控制入口混进现有 `AI` 配置页，避免语义污染。
- 不改造成独立系统设置窗口，仍保持在主界面右侧边栏内完成操作。

## 用户体验

右侧边栏新增一个 `服务` tab，放在 `会话 / 历史 / AI` 同级。

页面包含 3 个固定卡片：

### 1. cc-connect 卡片

展示内容：

- 当前状态：未安装 / 运行中 / 已停止 / 异常
- 配置文件路径
- 飞书 `app_id`
- 飞书 `app_secret`

操作按钮：

- `启动`
- `停止`
- `重启`
- `保存并重启`

交互约束：

- 页面加载时读取当前 `cc-connect/config.toml` 中的飞书配置并回填。
- `app_secret` 默认使用密码输入框。
- 点击“保存并重启”时先校验两个字段都非空，再写回配置文件。
- 保存成功后自动重启 `cc-connect`，并刷新状态。

### 2. FRP 卡片

展示内容：

- 当前状态：运行中 / 已停止 / 异常
- 配置路径 `frp/frpc.toml`
- 说明“用于将本地 9800 暴露到外网”

操作按钮：

- `启动`
- `停止`
- `重启`

交互约束：

- 启动和停止通过仓库内现有脚本执行：
  - `frp/start-frp.sh`
  - `frp/stop-frp.sh`
- 状态通过进程探测判断，不依赖脚本输出文案。
- 如果 9800 服务未启动，沿用现有脚本行为，由主进程把失败信息返回给界面。

### 3. 手机远程服务卡片

展示内容：

- 当前状态：运行中 / 已停止 / 异常
- 当前端口，默认 `9800`
- 当前局域网访问地址

操作按钮：

- `重启`

交互约束：

- 当前仓库里的手机远程服务由主进程启动，服务控制台主要承担状态展示和重启能力。
- 不增加“关闭”按钮，避免误关后导致桌面端核心能力失效。

## 技术设计

## 1. 渲染层

涉及文件：

- `src/renderer/index.html`
- `src/renderer/app.ts`
- `src/renderer/styles.css`

改动点：

- 新增 `服务` tab 和对应内容容器。
- 新增 3 个服务卡片的表单和按钮。
- 新增一个统一的状态刷新函数，在切换到 `服务` tab 时主动拉取最新状态。
- 所有按钮操作都通过 preload 暴露的 IPC API 调用主进程，不直接执行系统命令。

## 2. Preload

涉及文件：

- `src/preload/index.ts`

新增 API：

- `serviceConsoleGetState()`
- `serviceConsoleControl(service: string, action: string)`
- `ccConnectGetConfig()`
- `ccConnectSaveConfig(config)`

原则：

- renderer 不直接接触文件系统和子进程。
- 所有返回值都保持明确结构，避免 renderer 猜测异常字符串。

## 3. 主进程

涉及文件：

- `src/main/index.ts`
- `src/main/cc-connect-manager.ts`
- 可选新增 `src/main/service-console.ts`

### 3.1 cc-connect

在 `CcConnectManager` 中补充能力：

- 读取 `cc-connect/config.toml` 中的飞书配置
- 更新 `app_id` / `app_secret`
- 提供启动 / 停止 / 重启 / 状态接口

实现约束：

- 先读取原文件，再做最小文本替换，不重写整个 TOML 结构。
- 仅更新 `[[projects.platforms]]` 下 `type = "feishu"` 对应的 `[projects.platforms.options]` 段。
- 如果飞书配置段不存在，则报错，不在本次需求里做 TOML 结构自动修复。

### 3.2 FRP

主进程增加固定控制逻辑：

- 启动：执行 `frp/start-frp.sh`
- 停止：执行 `frp/stop-frp.sh`
- 重启：先停再启
- 状态：通过 `pgrep -f "frpc.*frpc.toml"` 判断

实现约束：

- 启动脚本需使用非阻塞方式执行，因为 `start-frp.sh` 会以前台方式挂住 `frpc`。
- 主进程返回结构化结果：`ok`、`status`、`message`。
- 不把脚本输出直接当成状态来源，只作为错误信息补充展示。

### 3.3 手机远程服务

利用现有主进程内的远程服务能力：

- 查询当前监听端口和局域网地址
- 提供重启方法

实现方式：

- 优先复用 `remote-server.ts` 已有实例和状态。
- 如果当前实现没有显式重启入口，则在主进程增加一个受控重启包装方法，而不是在 renderer 侧重启应用。

## 状态模型

服务控制台统一返回如下结构：

```ts
type ServiceStatus = {
  id: "cc-connect" | "frp" | "remote-server";
  title: string;
  installed?: boolean;
  running: boolean;
  statusText: string;
  detail?: string;
};
```

其中：

- `cc-connect` 额外附带飞书配置和配置路径
- `frp` 额外附带脚本路径和配置路径
- `remote-server` 额外附带端口、局域网地址

## 错误处理

- 配置保存失败时，保留用户输入，不清空表单。
- `cc-connect` 未安装时，不阻止查看配置，但禁用启动相关按钮。
- `FRP` 启动失败时，展示脚本 stderr 或超时错误。
- 手机远程服务重启失败时，展示主进程返回的错误信息。

## 测试与验证

最少需要覆盖以下验证：

1. `cc-connect` 配置读取正确，页面能回填 `app_id` 和 `app_secret`
2. 修改飞书配置后，`config.toml` 对应字段被正确替换
3. 点击“保存并重启”后，`cc-connect` 进程被重启且状态刷新
4. `FRP` 运行中和未运行两种状态能正确识别
5. 点击 `FRP` 启动 / 停止 / 重启后，状态能正确变化
6. 手机远程服务卡片能显示当前访问地址和端口
7. 手机远程服务重启后，页面能重新拿到可用地址

运行验证要求：

- 至少执行一次桌面端构建或开发启动，确认 renderer 和 main 均无编译错误
- 至少手动验证一次 `cc-connect` 保存并重启
- 至少手动验证一次 `FRP` 启停

## 分阶段实现建议

1. 先补主进程和 preload 的服务控制 API
2. 再补 renderer 的 `服务` tab UI
3. 最后做联调与状态刷新

这样可以避免先写 UI 后发现主进程状态模型不稳定。
