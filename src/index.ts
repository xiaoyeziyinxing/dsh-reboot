// dsh-restart 宿主入口（函数型插件）：一键重启 DeepSeek Harness 宿主进程。
// 动机：改插件/改配置后必须重启宿主进程才能生效，人工重启太繁琐。
//
// 两端策略（v0.1.0）：
// - CLI 宿主（dsh --profile web 等）：先派生分离看门狗子进程（%TEMP%\dsh-restart\watchdog.mjs，
//   轮询宿主 pid 消失后按原 argv 重启；web 缺 --no-open 时补上避免重复开标签），再经
//   ctx.appExit(0) 优雅退出（launcher 的 bounded shutdown：dispose 完成后自然退 0）。
//   端口不变 → 浏览器页面自动重连，会话跨进程恢复（官方 server-restart.e2e 证实）。
// - 桌面端（Host 为 Electron Node 模式 IPC 子进程）：宿主任何退出（含 code 0）在 Electron
//   侧都走 fail→恢复对话框（host-process.ts:230），没人拉起进程。v0.2.x 改为整客户端重启：
//   看门狗经 relay 跳板脱离宿主进程树（否则 taskkill /T 沿父链追杀会连带杀掉它——v0.2.0
//   实测只关不启的原因），从树外延迟强杀客户端进程树（Electron 主进程=宿主父进程），再
//   拉起客户端 exe（剥 ELECTRON_RUN_AS_NODE 还原 GUI 模式）。
//
// 触发面：restart_host 工具（LLM，tools/pre-execute 一律 ask 确认，approval 缺席 fail-closed）
// + /restart/api 路由（对话框「重启」按钮，用户点击即确认）。
// helper 由 vendor.ts 内联（npm dsh 包滞后/受限，见 vendor.ts 头注）

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sz from '@deepseek-ai/schemastery'
import { defineTool } from './vendor.js'
import { WATCHDOG_SCRIPT, buildRespawnArgs, decideRestart, isDesktopChild } from './argv.js'

export const name = 'restart'
export const inject = ['tools']
export const removable = true

/** 插件配置（cordis.patch.yml insert.config；缺省字段由宿主按 Config schema 填默认值） */
export interface RestartConfig {
  /** 触发后延迟退出毫秒数：让 HTTP 响应先送达浏览器再断流，默认 800 */
  delayMs?: number
  /** CLI 宿主退出后是否由看门狗按原命令行重启（桌面端始终交给 Electron），默认 true */
  respawn?: boolean
}

export const Config: sz<RestartConfig> = sz.object({
  delayMs: sz.number().default(800),
  respawn: sz.boolean().default(true),
})

// ---- 宿主服务的最小结构类型（不依赖 cordis 类型包，保持零宿主依赖）----
interface HostCtx {
  on(event: string, listener: (...args: any[]) => unknown): void
  effect(fn: () => unknown, name?: string): void
  get(service: string): unknown
  inject?(deps: string[], cb: (svcCtx: HostCtx) => void): void
  tools: { register(tool: unknown): unknown }
}

export function apply(ctx: HostCtx, config: RestartConfig = {}): void {
  const delayMs = Math.max(0, config.delayMs ?? 800)
  const respawnEnabled = config.respawn !== false
  const desktop = isDesktopChild()
  const profileName = (() => {
    const pc = ctx.get('profileContext') as { name?: string } | undefined
    return typeof pc?.name === 'string' ? pc.name : undefined
  })()
  let restarting = false

  // 优雅退出：appExit 是 launcher 在根上下文提供的 bounded shutdown
  // （runProfile→provideCmdline；dsh-cmdline 的 parseCmdline 同样从插件 ctx 读取，是官方支持的取法）。
  const gracefulExit = (): void => {
    const appExit = ctx.get('appExit') as ((code: number) => void) | undefined
    if (typeof appExit === 'function') { appExit(0); return }
    // 极旧宿主缺 appExit：回退 SIGTERM（profile-boot 注册 SIGTERM→interrupt(0)），再不行硬退
    try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(0) }
  }

  /** 写看门狗脚本到 %TEMP%\dsh-restart\watchdog.mjs（relay/kill/respawn 三模式，见 argv.ts） */
  const writeWatchdogScript = (): string => {
    const dir = join(tmpdir(), 'dsh-restart')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'watchdog.mjs')
    writeFileSync(script, WATCHDOG_SCRIPT)
    return script
  }

  /**
   * 桌面端：经 relay 跳板派生树外看门狗，由它延迟强杀客户端进程树再拉起客户端 exe。
   * 关键：看门狗不能是宿主（进程树内）的存活子进程——taskkill /T 沿父链追杀会把它连带
   * 杀掉（v0.2.0 实测只关不启的原因）；relay 秒退后副本 PPID 指向死进程，树遍历够不着。
   */
  const spawnDesktopWatchdog = (): boolean => {
    try {
      const script = writeWatchdogScript()
      // relay 后的副本执行：kill <electronPid> <delayMs> <exe> <exeDir> <strip=1>
      const sub = ['kill', String(process.ppid), String(delayMs),
        process.execPath, dirname(process.execPath), '1']
      const relay = spawn(process.execPath, [script, 'relay', script, ...sub], {
        detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
      })
      relay.unref()
      console.log(`[restart] desktop watchdog relayed (kill pid ${String(process.ppid)} in ${String(delayMs)}ms)`)
      return true
    } catch (e) {
      console.log('[restart] desktop watchdog spawn failed:', (e as Error)?.message)
      return false
    }
  }

  /** CLI：原地派生看门狗等宿主优雅退出后按原命令行重启（宿主自行 appExit，无人杀树，无需跳板） */
  const spawnCliWatchdog = (): boolean => {
    try {
      const script = writeWatchdogScript()
      const tail = buildRespawnArgs(process.argv.slice(1), profileName)
      const child = spawn(process.execPath,
        [script, 'respawn', String(process.pid), process.execPath, process.cwd(), '0', ...tail], {
        detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
      })
      child.unref()
      console.log(`[restart] cli watchdog armed (host pid ${String(process.pid)}, ${String(tail.length)} args)`)
      return true
    } catch (e) {
      console.log('[restart] cli watchdog spawn failed:', (e as Error)?.message)
      return false
    }
  }

  /** 统一重启入口（工具与 HTTP 共用）；重复触发直接回报进行中 */
  const scheduleRestart = (source: string): { mode: string; watchdog: boolean | null; note: string } => {
    if (restarting) return { mode: 'already', watchdog: null, note: '重启已在进行中' }
    restarting = true
    const mode = decideRestart({ desktop, respawn: respawnEnabled })
    let watchdog: boolean | null = null
    if (mode === 'desktop') {
      // 强杀+拉起全部由树外看门狗执行（含延迟）；宿主只负责把看门狗送出进程树
      watchdog = spawnDesktopWatchdog()
      if (!watchdog) {
        // 跳板都没起来：退回优雅退出，Electron 恢复对话框至少还能手动重启
        setTimeout(gracefulExit, delayMs)
      }
    } else {
      // CLI：宿主始终自行优雅退出（flush 存储），看门狗只负责拉起
      watchdog = spawnCliWatchdog()
      setTimeout(gracefulExit, delayMs)
    }
    const note = mode === 'desktop'
      ? (watchdog ? '桌面端：客户端即将关闭并自动重新启动。' : '看门狗启动失败，客户端将退出，需手动重新打开。')
      : mode === 'respawn'
        ? (watchdog ? '宿主即将重启，页面将自动恢复。' : '看门狗启动失败，宿主将退出，需手动重启。')
        : '宿主将退出（respawn 已关闭，需手动重启）。'
    console.log(`[restart] scheduled by ${source}: mode=${mode} profile=${profileName ?? '?'} pid=${String(process.pid)}`)
    return { mode, watchdog, note }
  }

  // ① LLM 工具：restart_host（高危：pre-execute 一律 ask，见下方守卫）
  try {
    ctx.effect(function* () {
      yield ctx.tools.register(defineTool({
        name: 'restart_host',
        description: '重启 DeepSeek Harness 宿主（用于加载更新后的插件或配置）。'
          + '会中断运行中的任务（会话保留）；dsh web 场景会在原端口自动重启并恢复页面，'
          + '桌面端会直接关闭并自动重启整个客户端。调用前必须先征得用户同意。',
        parameters: {},
        output: { type: 'json' },
        execute: () => scheduleRestart('tool'),
      }))
    }, 'restart.tools')
  } catch (e) { console.log('[restart] tools effect failed:', (e as Error)?.message) }

  // ② 守卫：restart_host 一律 ask（approval 缺席时 fail-closed 降级为 deny）
  try {
    ctx.on('tools/pre-execute', async (exec: unknown, next: () => unknown): Promise<unknown> => {
      const e = exec as { name?: string; tool?: string } | undefined
      const toolName = String(e?.name ?? e?.tool ?? '')
      if (toolName !== 'restart_host') return next()
      return {
        kind: 'ask',
        reason: '[dsh-restart] 重启宿主进程会中断运行中的任务（会话保留），确认重启？',
        displayReason: {
          en: 'Restart the host process? Running tasks will be interrupted; sessions are preserved.',
          zh: '重启宿主进程会中断运行中的任务（会话保留），确认重启？',
        },
      }
    })
  } catch (e) { console.log('[restart] guard failed:', (e as Error)?.message) }

  // ③ UI API：/restart/api 前缀路由（POST JSON，{ok:true,value} 信封），供对话框按钮触发。
  // webServer/webRuntime 仅桌面端与 dsh web 存在：用 ctx.inject 声明依赖，缺席时内层插件
  // 保持 PENDING（headless 场景静默跳过），不拖累 restart 本体加载。
  const mountUiApi = (svcCtx: HostCtx): void => {
    const webServer = svcCtx.get('webServer') as { register?: (r: unknown) => void } | undefined
    if (typeof webServer?.register !== 'function') {
      console.log('[restart] webServer unavailable, UI api skipped')
      return
    }
    // bind 保留 this：WebServer.register 是 class 方法，裸解引用调用会丢 this（emotion 实测踩坑）
    const registerRoute = webServer.register.bind(webServer)
    const webRuntime = svcCtx.get('webRuntime') as { trustedHosts?: string[] } | undefined
    const trustedHosts = webRuntime?.trustedHosts ?? []
    const json = (res: any, status: number, body: unknown) => {
      if (res.headersSent === true) { res.destroy?.(); return }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const ok = (res: any, value: unknown) => json(res, 200, { ok: true, value })
    const fail = (res: any, status: number, code: string, message: string) => json(res, status, { ok: false, error: { code, message } })
    // 浏览器信任围栏（对齐 dsh-emotion isTrustedApiRequest 的 API 分支）：
    // Host 头必须是 loopback 或受信主机；跨站一律拒；origin 缺省放行（桌面 shell 为 dsh-app://app）
    const loopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]'
      || (/^127(\.\d{1,3}){3}$/.test(hostname) && hostname.split('.').every((p) => Number(p) <= 255))
    const fence = (req: any): boolean => {
      try {
        const host = req.headers?.host
        if (!host) return false
        const hostUrl = new URL(`http://${host}`)
        if (!loopback(hostUrl.hostname)) {
          const trusted = trustedHosts.some((entry) => {
            try { return new URL(`http://${entry}`).hostname === hostUrl.hostname } catch { return false }
          })
          if (!trusted) return false
        }
        if (req.headers['sec-fetch-site'] === 'cross-site') return false
        const origin = req.headers.origin
        if (origin === undefined || origin === 'dsh-app://app') return true
        try { return new URL(origin).hostname === hostUrl.hostname } catch { return false }
      } catch { return false }
    }
    const readBody = async (req: any): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        total += Buffer.from(chunk).length
        if (total > 65536) throw new Error('request body too large')
        chunks.push(Buffer.from(chunk))
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return {}
      return JSON.parse(text)  // 非法 JSON 由外层 catch 兜底
    }
    const api: Record<string, (payload: any) => unknown | Promise<unknown>> = {
      status: async () => ({
        mode: decideRestart({ desktop, respawn: respawnEnabled }),
        desktop, pid: process.pid, delayMs,
      }),
      trigger: async (payload) => {
        if (payload?.confirm !== true) throw new Error('需要 {confirm:true} 才能触发重启')
        return scheduleRestart('ui')
      },
    }
    svcCtx.effect(() => registerRoute({
      kind: 'prefix',
      path: '/restart/api',
      handler: async (req: any, res: any) => {
        try {
          if (!fence(req)) return fail(res, 403, 'forbidden', 'forbidden')
          if (req.method !== 'POST') return fail(res, 405, 'method-error', 'method not allowed')
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith('/restart/api/') ? pathname.slice(13) : undefined
          if (!method || method.includes('/')) return fail(res, 404, 'not-found', 'unknown restart api method')
          const handler = method && Object.hasOwn(api, method) ? api[method] : undefined
          if (typeof handler !== 'function') return fail(res, 404, 'not-found', `unknown restart api method "${method}"`)
          ok(res, await handler(await readBody(req)))
        } catch (e) {
          fail(res, 400, 'bad-request', e instanceof Error ? e.message : String(e))
        }
      },
    }), 'restart: /restart/api route')
    console.log('[restart] UI api mounted at /restart/api')
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer', 'webRuntime'], mountUiApi)
    } else {
      mountUiApi(ctx)  // 旧运行时无 ctx.inject：直接尝试，缺席则记日志跳过
    }
  } catch (e) { console.log('[restart] ui api mount failed:', (e as Error)?.message) }

  console.log(`[restart] mounted (tool+guard+ui-api, desktop=${String(desktop)}, respawn=${String(respawnEnabled)})`)
}
