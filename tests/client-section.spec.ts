// dsh-reboot 浏览器半包注册单测：入口必须挂在 settings.section（设置弹窗左侧导航），
// 且不再占用 conversation.input.left（v0.3.0 由输入框迁到设置页）。
// client.ts 是「无模块语法的脚本」：先注入 globalThis.window.__ModuleLoader__ 捕获 spec，再动态 import。

import { describe, expect, it, vi } from 'vitest'

interface Captured {
  id: string
  factory: (require: (id: string) => any) => any
}

/** 装载 client.ts：桩住宿主全局，捕获 __ModuleLoader__.load 收到的 spec。 */
async function loadClient(): Promise<Captured> {
  const captured: Captured[] = []
  ;(globalThis as any).window = {
    __ModuleLoader__: { load: (spec: Captured) => { captured.push(spec) } },
  }
  ;(globalThis as any).document = {
    baseURI: 'dsh-app://app/',
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  await import('../src/client.js')
  const spec = captured[0] as Captured | undefined
  if (spec === undefined) throw new Error('client.ts 未调用 __ModuleLoader__.load')
  return spec
}

/** 最小 slots/effect 桩：记录 inject 的槽位名与 register 的选项、组件。 */
function makeCtx() {
  const injected: string[] = []
  const registered: Array<{ options: any; component: any }> = []
  const ctx = {
    effect(fn: () => unknown) { return fn() },
    slots: {
      inject(slot: string, cb: () => unknown) { injected.push(slot); return cb() },
      register(options: any, component: any) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, injected, registered }
}

const fakeReact = {
  createElement: () => null,
  useState: () => [null, () => {}],
}

describe('dsh-reboot client：设置页入口', () => {
  it('注册到 settings.section（id=reboot, order=600, 标签「重启」）', async () => {
    vi.resetModules()
    const spec = await loadClient()
    expect(spec.id).toBe('dsh-reboot')

    const mod = spec.factory((id: string) => id === 'react' ? fakeReact : {})
    expect(mod.inject).toEqual(['slots'])

    const { ctx, injected, registered } = makeCtx()
    mod.apply(ctx)

    // 只挂设置槽位——不能再占用输入框（迁址的核心断言）
    expect(injected).toEqual(['settings.section'])
    expect(registered).toHaveLength(1)
    expect(registered[0]!.options.name).toBe('settings.section')
    expect(registered[0]!.options.id).toBe('reboot')
    expect(registered[0]!.options.order).toBe(600)
    expect(registered[0]!.options.label()).toBe('重启')
    expect(typeof registered[0]!.component).toBe('function')
  })
})
