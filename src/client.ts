// dsh-reboot 浏览器半包（手写 React，无 JSX 依赖宿主内建模块）：
// 「设置」弹窗左侧导航底部新增「重启」页（settings.section，order 600）：
//   点击按钮 = 确认 → POST /restart/api/trigger {confirm:true} → 宿主延迟优雅退出。
//   dsh web：看门狗按原命令行在原端口重启，页面自动重连恢复；
//   桌面端：客户端进程树被强杀后由看门狗直接拉起客户端 exe（v0.2.0 整客户端重启）。
// v0.3.0：入口由聊天输入框（conversation.input.left）迁到设置页，输入框恢复清爽。
// 加载契约（对齐 dsh-better-sidebar@0.26.1 / dsh-reme-obsidian）：
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
  id: 'dsh-reboot',
  factory: (require: (id: string) => any) => {
    const react = require('react')
    const h = react.createElement

    // 仅依赖宿主运行时提供的 slots 服务；react/jsx-runtime 为 shell 内建模块
    const inject = ['slots']

    // 设置弹窗的「一页设置」槽位：DSH shell（ui-settings-general）声明，注册即出现在左侧导航
    const SETTINGS_SLOT = 'settings.section'

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

    // 环形箭头线条图标（24×24 视图框，currentColor 随文本）
    function RefreshIcon(props: { size?: number }) {
      const size = props?.size ?? 12
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8',
          stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }),
        h('path', { d: 'M21 3v5h-5', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      )
    }

    // 主题中性样式：灰阶描边/底色随设置弹窗明暗主题，按钮用主色蓝（与 shell 主按钮一致）
    const CARD = {
      display: 'flex', flexDirection: 'column', gap: '10px',
      padding: '14px 16px', border: '1px solid rgba(128,128,128,0.22)',
      borderRadius: '10px', background: 'rgba(128,128,128,0.06)',
    }
    const TITLE = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600 }
    const DESC = { fontSize: '12px', lineHeight: 1.65, opacity: 0.72 }
    const ROW = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }
    const NOTE = { fontSize: '12px', opacity: 0.72 }
    const buttonStyle = (disabled: boolean) => ({
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      height: '30px', padding: '0 14px',
      border: 'none', borderRadius: '8px',
      background: disabled ? 'rgba(10,132,255,0.45)' : '#0A84FF', color: '#fff',
      font: 'inherit', fontSize: '12px', lineHeight: '1',
      cursor: disabled ? 'default' : 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
    })

    /** 设置页内容：一键重启（当前唯一入口，原输入框按钮已迁走） */
    function RestartSection() {
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

      const label = phase === 'idle' ? '立即重启' : phase === 'busy' ? '重启中…' : '已触发'
      return h('div', { style: CARD },
        h('div', { style: TITLE }, h(RefreshIcon, { size: 14 }), h('span', null, '一键重启')),
        h('div', { style: DESC },
          '改完插件或配置后，需要重启宿主进程才能生效。'
          + 'dsh web 会在原端口自动重启并恢复页面；桌面端会自动关闭并重新打开整个客户端。'
          + '重启会中断正在运行的任务（会话保留）。'),
        h('div', { style: ROW },
          h('button', {
            type: 'button',
            onClick: trigger,
            disabled: phase !== 'idle',
            title: '重启 DeepSeek Harness 宿主进程以加载新插件/配置',
            style: buttonStyle(phase !== 'idle'),
          }, h('span', null, label)),
          note ? h('span', { style: NOTE }, note) : null,
        ),
      )
    }

    function apply(ctx: any): void {
      ctx.effect(() => ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: 'reboot',
        order: 600,
        label: () => '重启',
      }, RestartSection)), 'dsh-reboot: settings section')
    }

    const mod = { exports: {} as Record<string, unknown> }
    mod.exports.apply = apply
    mod.exports.inject = inject
    return mod.exports
  },
})
