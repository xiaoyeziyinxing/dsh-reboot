// dsh-restart 浏览器半包（手写 React，无 JSX 依赖宿主内建模块）：
// 对话框输入区工具行（conversation.input.left）挂一枚「重启」按钮：
//   点击 = 确认 → POST /restart/api/trigger {confirm:true} → 宿主延迟优雅退出。
//   dsh web：看门狗按原命令行在原端口重启，页面自动重连恢复；
//   桌面端：客户端进程树被强杀后由看门狗直接拉起客户端 exe（v0.2.0 整客户端重启）。
// 加载契约（对齐 dsh-emotion / dsh-better-sidebar@0.26.1）：
//   window.__ModuleLoader__.load({id, factory})，factory 返回 {apply, inject}。
// 注意：本文件不得含顶层 import/export（需保持无模块语法的脚本形态），构建产物 lib/client.js。

// 宿主提供的全局（非 Node/DOM 标准环境，最小声明）
declare const window: { __ModuleLoader__: { load(spec: unknown): void } }
declare const document: {
  baseURI?: string
  visibilityState: string
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory: (require: (id: string) => any) => {
    const react = require('react')
    const h = react.createElement

    // 仅依赖宿主运行时提供的 slots 服务；react/jsx-runtime 为 shell 内建模块
    const inject = ['slots']

    const SLOT = 'conversation.input.left'

    // ---- 传输：document.baseURI 解析（桌面 shell 页面为 dsh-app://app/，同源转发到宿主）----
    function apiBase(): string {
      const url = new URL(document.baseURI || 'http://dsh.internal/')
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return url.href
    }
    async function callApi(method: string, payload?: unknown): Promise<any> {
      const response = await fetch(new URL(`restart/api/${method}`, apiBase()).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const parsed: any = await response.json().catch(() => null)
      if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
      }
      return parsed.value
    }

    // 环形箭头线条图标（24×24 视图框，currentColor 随按钮）
    function RefreshIcon() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8',
          stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }),
        h('path', { d: 'M21 3v5h-5', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      )
    }

    function RestartPill() {
      const [phase, setPhase] = react.useState('idle' as 'idle' | 'busy' | 'done')
      const [note, setNote] = react.useState('')

      const trigger = async () => {
        if (phase !== 'idle') return
        setPhase('busy')
        try {
          const value = await callApi('trigger', { confirm: true })
          setNote(value?.note ?? '宿主即将重启…')
        } catch (e: any) {
          // 请求失败：可能宿主已在退出途中，提示等待自动恢复
          setNote(e?.message ? `触发失败：${e.message}；若宿主已在重启请稍候` : '触发失败；若宿主已在重启请稍候')
        } finally {
          setPhase('done')
        }
      }

      const label = phase === 'idle' ? '重启' : phase === 'busy' ? '重启中…' : '已触发'
      const title = phase === 'idle'
        ? '一键重启（加载新插件/配置）：dsh web 自动在原端口重启并恢复页面；桌面端自动重启整个客户端'
        : note || label
      return h('button', {
        type: 'button',
        onClick: trigger,
        title,
        disabled: phase !== 'idle',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          height: '22px', padding: '0 9px', margin: '0 2px',
          border: '1px solid rgba(128,128,128,0.25)', borderRadius: '11px',
          background: 'transparent', color: 'inherit',
          font: 'inherit', fontSize: '12px', lineHeight: '20px',
          cursor: phase === 'idle' ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap',
          opacity: phase === 'idle' ? 1 : 0.55,
        },
      },
        h(RefreshIcon),
        h('span', null, label),
      )
    }

    function apply(ctx: any): void {
      ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'dsh-restart:pill',
        order: 91,
        registrant: 'dsh-restart',
      }, () => h(RestartPill))), 'dsh-restart: input pill')
    }

    const mod = { exports: {} as Record<string, unknown> }
    mod.exports.apply = apply
    mod.exports.inject = inject
    return mod.exports
  },
})
