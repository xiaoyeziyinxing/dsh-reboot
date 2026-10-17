import { describe, expect, it } from 'vitest'
import { WATCHDOG_SCRIPT, buildRespawnArgs, decideRestart, isDesktopChild } from '../src/argv.js'

describe('isDesktopChild', () => {
  it('带 IPC 通道且 connected → 桌面端（Electron Node 模式子进程）', () => {
    expect(isDesktopChild({ send: () => {}, connected: true })).toBe(true)
  })

  it('有 send 但已断开（connected=false）→ 不算桌面端', () => {
    expect(isDesktopChild({ send: () => {}, connected: false })).toBe(false)
  })

  it('ELECTRON_RUN_AS_NODE=1 但无 IPC → 不算桌面端（安装版 dsh.cmd 本身如此运行 CLI）', () => {
    expect(isDesktopChild({ env: { ELECTRON_RUN_AS_NODE: '1' } })).toBe(false)
  })

  it('ELECTRON_RUN_AS_NODE 其他值 + 无 IPC → 不算', () => {
    expect(isDesktopChild({ env: { ELECTRON_RUN_AS_NODE: '0' } })).toBe(false)
  })

  it('普通 node 进程 → 否', () => {
    expect(isDesktopChild({ env: {} })).toBe(false)
  })
})

describe('buildRespawnArgs', () => {
  it('web profile 未带 --no-open → 追加，避免重启后重复开标签', () => {
    expect(buildRespawnArgs(['bin.js', '--profile', 'web', '--port', '3080'], 'web'))
      .toEqual(['bin.js', '--profile', 'web', '--port', '3080', '--no-open'])
  })

  it('web profile 已带 --no-open → 原样', () => {
    expect(buildRespawnArgs(['bin.js', '--profile', 'web', '--no-open'], 'web'))
      .toEqual(['bin.js', '--profile', 'web', '--no-open'])
  })

  it('非 web profile → 原样（不注入未知 flag）', () => {
    expect(buildRespawnArgs(['bin.js', '--profile', 'headless', '任务'], 'headless'))
      .toEqual(['bin.js', '--profile', 'headless', '任务'])
  })

  it('profile 未知 → 原样（宁多开标签不冒险）', () => {
    expect(buildRespawnArgs(['bin.js', '--profile', 'demo'], undefined))
      .toEqual(['bin.js', '--profile', 'demo'])
  })

  it('空 argv 尾 + web → [--no-open]', () => {
    expect(buildRespawnArgs([], 'web')).toEqual(['--no-open'])
  })
})

describe('decideRestart', () => {
  it('桌面端 → desktop（整客户端重启，无视 respawn 开关）', () => {
    expect(decideRestart({ desktop: true, respawn: true })).toBe('desktop')
    expect(decideRestart({ desktop: true, respawn: false })).toBe('desktop')
  })

  it('CLI + respawn 开 → respawn', () => {
    expect(decideRestart({ desktop: false, respawn: true })).toBe('respawn')
  })

  it('CLI + respawn 关 → exit-only', () => {
    expect(decideRestart({ desktop: false, respawn: false })).toBe('exit-only')
  })
})

describe('WATCHDOG_SCRIPT', () => {
  it('relay 跳板：spawn 自身副本后立即退出，使其 PPID 指向死进程躲过 taskkill /T 树追杀', () => {
    expect(WATCHDOG_SCRIPT).toContain("if (action === 'relay')")
    expect(WATCHDOG_SCRIPT).toContain('[script, ...sub]')
    expect(WATCHDOG_SCRIPT).toContain('child.unref()')
    // relay 分支必须先于 kill/respawn 的 rest 解构（否则 relay 参数会被误读）
    const relayIdx = WATCHDOG_SCRIPT.indexOf("if (action === 'relay')")
    const destructureIdx = WATCHDOG_SCRIPT.indexOf('const [pidArg, delayArg, execPath, cwd, stripArg, ...hostArgs] = rest')
    expect(relayIdx).toBeGreaterThan(-1)
    expect(destructureIdx).toBeGreaterThan(relayIdx)
  })

  it('kill 模式：延迟 taskkill /T /F（win32）并等目标退出，杀不掉则放弃避免双开', () => {
    expect(WATCHDOG_SCRIPT).toContain("if (action === 'kill')")
    expect(WATCHDOG_SCRIPT).toContain("spawn('taskkill', ['/PID', String(pid), '/T', '/F']")
    expect(WATCHDOG_SCRIPT).toContain('15_000')
    expect(WATCHDOG_SCRIPT).toContain('process.exit(1)')
  })

  it('respawn 模式：等宿主自行退出，30s 上限', () => {
    expect(WATCHDOG_SCRIPT).toContain('30_000')
  })

  it('strip=1 剥 ELECTRON_RUN_AS_NODE（桌面端还原 GUI 模式）', () => {
    expect(WATCHDOG_SCRIPT).toContain('if (strip) delete env.ELECTRON_RUN_AS_NODE')
  })

  it('重启前继承环境并分离启动，且绝不 windowsHide（CREATE_NO_WINDOW 会令 Electron 首窗口隐藏）', () => {
    expect(WATCHDOG_SCRIPT).toContain('detached: true')
    expect(WATCHDOG_SCRIPT).toContain('const env = { ...process.env }')
    const launchIdx = WATCHDOG_SCRIPT.indexOf('const launch =')
    const launchBody = WATCHDOG_SCRIPT.slice(launchIdx, WATCHDOG_SCRIPT.indexOf('if (action'))
    expect(launchBody).not.toContain('windowsHide:')
  })

  it('是零依赖 ESM（node: 协议导入，无包导入）', () => {
    expect(WATCHDOG_SCRIPT).toMatch(/from 'node:child_process'/)
    expect(WATCHDOG_SCRIPT).not.toMatch(/from '(?!node:)[^']+'/)
  })
})
