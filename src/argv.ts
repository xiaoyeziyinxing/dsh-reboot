// dsh-restart 纯逻辑：进程形态判定、重启命令行构建、看门狗脚本源码。
// 独立成模块便于 vitest 覆盖（不触碰真实 process / 不真 spawn）。

/** 重启策略：CLI 看门狗重启 / 桌面端杀进程树后由看门狗拉起客户端 / 仅退出 */
export type RestartMode = 'respawn' | 'desktop' | 'exit-only'

/** 宿主进程的最小结构类型（测试可注入假进程） */
export interface ProcessLike {
  pid?: number
  send?: unknown
  connected?: boolean
  env?: Record<string, string | undefined>
}

/**
 * 桌面端判定：Host 是 Electron 以 Node 模式拉起的 IPC 子进程（spawn stdio 末位 'ipc'）。
 * 只认 IPC 通道（process.send 为函数且 connected）：安装版 dsh.cmd 本身就以
 * ELECTRON_RUN_AS_NODE=1 运行 CLI，env 判据会把 CLI web 宿主误判成桌面端。
 * 桌面端不复活宿主而是整客户端重启：宿主任何退出（含 code 0）在 Electron 侧都会走
 * fail→恢复对话框（host-process.ts:230），没人拉起进程；改为看门狗在客户端进程树
 * 退出后直接拉起客户端 exe（剥掉 ELECTRON_RUN_AS_NODE，否则拉起的是 Node 模式）。
 */
export function isDesktopChild(proc: ProcessLike = process): boolean {
  return typeof proc.send === 'function' && proc.connected === true
}

/**
 * 构建看门狗重启宿主的命令行（argv 尾部，不含 execPath）：
 * 原样保留；仅 web profile 且未带 --no-open 时补一个，避免重启后另开重复标签页
 * （原标签页会自动重连，官方 server-restart.e2e 证实会话跨进程恢复）。
 * 非 web profile 不注入未知 flag（headless/tui 的命令行不含 --no-open）。
 */
export function buildRespawnArgs(argvTail: readonly string[], profile?: string): string[] {
  const args = [...argvTail]
  if (profile === 'web' && !args.includes('--no-open')) args.push('--no-open')
  return args
}

/** 决策表：桌面端整客户端重启；CLI 看 respawn 开关 */
export function decideRestart(input: { desktop: boolean; respawn: boolean }): RestartMode {
  if (input.desktop) return 'desktop'
  return input.respawn ? 'respawn' : 'exit-only'
}

/**
 * 看门狗脚本源码：触发时写入 %TEMP%\dsh-restart\watchdog.mjs，以分离子进程运行。
 * 三个子命令（v0.2.1）：
 * - relay <script> <rest...>：换皮跳板——spawn 自身副本后立即退出。桌面端强杀客户端进程树
 *   （taskkill /T 沿父链追杀）时，若看门狗还是 Host 的子进程必被连带杀掉（v0.2.0 实测只关
 *   不启的原因）；跳板秒退后副本 PPID 指向死进程，taskkill 树遍历找不到它 → 保命。
 * - kill <pid> <delayMs> <execPath> <cwd> <strip> <args...>：从树外延迟强杀 pid 进程树，
 *   等其退出后按 execPath 分离重启（strip=1 剥 ELECTRON_RUN_AS_NODE 还原 GUI 模式）。
 * - respawn <pid> <execPath> <cwd> <strip> <args...>：等 pid 自行退出（CLI 宿主 appExit
 *   优雅退出）后重启，30s 上限。零依赖 ESM，勿手改。
 */
export const WATCHDOG_SCRIPT = `// dsh-restart watchdog — 由 dsh-restart 插件生成，勿手改。
import { spawn } from 'node:child_process'
const [, , action, ...rest] = process.argv
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const envOf = (strip) => {
  const env = { ...process.env }
  if (strip) delete env.ELECTRON_RUN_AS_NODE
  return env
}
const launch = (execPath, cwd, strip, args) => {
  // 注意：绝不能加 windowsHide——CREATE_NO_WINDOW 会让 STARTUPINFO 带 SW_HIDE，
  // Electron/Chromium 据此把首窗口建为隐藏（v0.2.1 实测重启后客户端无窗口）。
  // 本插件的进程都是 GUI 子系统的 exe 跑 Node 模式，本就没有控制台，无需隐藏。
  const child = spawn(execPath, args, {
    detached: true, stdio: 'ignore', cwd, env: envOf(strip),
  })
  child.unref()
  process.exit(0)
}
if (action === 'relay') {
  const [script, ...sub] = rest
  const child = spawn(process.execPath, [script, ...sub], {
    detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env, windowsHide: true,
  })
  child.unref()
  process.exit(0)
}
if (action === 'kill') {
  // kill 布局带 delayMs 位；respawn 无（见下），两者位数不同故各自解构
  const [pidArg, delayArg, execPath, cwd, stripArg, ...hostArgs] = rest
  const pid = Number(pidArg)
  void (async () => {
    await sleep(Number(delayArg) || 0)
    if (process.platform === 'win32') {
      // 看门狗已脱离目标进程树（relay 跳板），taskkill 不会反噬自身
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try { process.kill(pid, 'SIGTERM') } catch { /* noop */ }
    }
    const deadline = Date.now() + 15_000
    while (alive(pid) && Date.now() < deadline) await sleep(200)
    if (alive(pid)) process.exit(1)  // 杀不掉：放弃重启，避免双开
    launch(execPath, cwd, stripArg === '1', hostArgs)
  })()
} else if (action === 'respawn') {
  // 注意 respawn 无 delay 位：execPath/cwd/strip 从 rest[1..3] 取（与 kill 布局不同）
  const [rPid, rExec, rCwd, rStrip, ...rArgs] = rest
  void (async () => {
    const deadline = Date.now() + 30_000
    while (alive(Number(rPid)) && Date.now() < deadline) await sleep(200)
    if (alive(Number(rPid))) process.exit(1)  // 宿主未按期退出：放弃重启，避免端口双开
    launch(rExec, rCwd, rStrip === '1', rArgs)
  })()
}
`
