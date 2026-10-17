# dsh-restart

DeepSeek Harness（DeepSeek CLI / 桌面客户端）一键重启插件：改完插件或配置后，不用再手动关掉重开客户端。

## 功能

- **`restart_host` 工具**：对话里让 AI 重启宿主（"帮我重启加载新插件"）。调用前强制走 approval 确认（approval 缺席时拒绝，fail-closed）。
- **对话框「重启」按钮**：输入区工具行一键重启，点击即确认。
- **`/restart/api` HTTP 路由**：`POST trigger {confirm:true}` / `POST status`，带浏览器信任围栏。

## 各端行为

| 宿主形态 | 行为 |
| --- | --- |
| CLI（`dsh --profile web` 等） | 触发后派生分离看门狗（`%TEMP%\dsh-restart\watchdog.mjs`），宿主优雅退出（`ctx.appExit(0)`）后按**原命令行**在**原端口**重启；浏览器页面自动重连，会话跨进程恢复。web profile 未带 `--no-open` 时自动补上，避免重复开标签页。 |
| 桌面客户端 | **整客户端自动重启**（v0.2.2）：看门狗经 relay 跳板**脱离客户端进程树**（`taskkill /T` 沿父链追杀，树内子进程必被连带杀掉），从树外延迟 `taskkill /T /F` 强杀客户端进程树（含宿主自身），随后直接拉起客户端 exe（剥掉 `ELECTRON_RUN_AS_NODE` 还原 GUI 模式，**不带 `windowsHide`**——`CREATE_NO_WINDOW` 会令 Electron 首窗口以隐藏状态创建）。杀进程失败时放弃重启避免双开，由用户手动重开。 |

## 配置（cordis.patch.yml insert.config）

```yaml
- insert:
    - id: restart
      name: dsh-restart
      config:
        delayMs: 800    # 触发后延迟退出毫秒数（让响应先送达浏览器）
        respawn: true   # CLI 宿主退出后是否自动重启（桌面端始终交给 Electron）
```

## 安装

```bash
dsh plugin add dsh-restart          # npm
dsh plugin add <本地目录>            # 本地开发
```

## 安全模型

- `restart_host` 工具调用强制走宿主 approval 确认（缺席时 fail-closed 拒绝）。
- `/restart/api` 沿用 dsh-emotion 同款浏览器信任围栏（Host 必须为 loopback/受信主机、拒绝跨站）；本机进程可直接访问（loopback 信任模型），与官方本地信任边界一致。
- 重启会中断运行中的任务；会话与工作区数据落盘保留，重启后自动恢复。

## 开发

```bash
npm install
npm run build   # tsc: src/*.ts → lib/*.js
npm test        # vitest
```

注意 `lib/client.js` 必须保持无模块语法的脚本形态（esnext/bundler 构建，见 tsconfig）。

## License

MIT
