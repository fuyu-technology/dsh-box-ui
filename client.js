// dsh-box-ui
// Copyright 2026 蝠羽科技 (fuyu-technology)  —  https://github.com/fuyu-technology
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 允许二次修改与再分发，但必须保留上述署名与版权声明，不得删除或改写。
// 详见 LICENSE 与 NOTICE。
//

// dsh-box-ui · 客户端
//
// 在 DSH 设置页里加一个「需求箱」页面：看留言、改回执、回复、删除、新建。
//
// 挂载方式（DSH 官方插槽契约）：
//   ctx.slots.inject('settings.section', () =>
//     ctx.slots.register({ name:'settings.section', id:'requirement-box', order:60, label:'需求箱' }, Component)
//   )
//
// 设计约束（DSH 插件规范）：
//   - 只用主题令牌（CSS 变量），不硬编码颜色 → 亮/暗色都正确
//   - 不 import 任何 Harness Client 包（@deepseek-ai/dsh-client-ui-*）
//   - 不崩：所有取数都要有兜底，面板不能把设置页搞挂

window.__ModuleLoader__.load({
  id: 'dsh-box-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/dsh-box'
    const MAKER = '蝠羽科技'

    const KIND_LABEL = { sos: '现场求助', l1: 'L1 问题反馈', l2: 'L2 需求', l3: 'L3 牢骚' }
    const RECEIPT_LABEL = { open: '待处理', received: '已收', working: '处理中', done: '已处理', wontfix: '不处理' }
    const RECEIPTS = ['received', 'working', 'done', 'wontfix']
    const KINDS = ['sos', 'l1', 'l2', 'l3']

    // 分级通知：与 notify.mjs / box-server 的等级定义保持一致
    const LEVELS = ['urgent', 'important', 'normal', 'low']
    const LEVEL_LABEL = { urgent: '紧急', important: '重要', normal: '普通', low: '低' }
    const LEVEL_ICON = { urgent: '🚨', important: '⚠️', normal: '📝', low: '·' }
    const MODE_LABEL = { toast: '系统通知', dialog: '弹窗', sound: '声音', silent: '静默' }
    const SOUND_LABEL = { off: '不出声', once: '响一次', loop: '循环' }

    // ── 样式：只用主题令牌，亮/暗都跟着系统走 ───────────────────────────
    const STYLE = `
.bx-root {
  --bx-ok: var(--dsw-alias-state-success-primary, #39d98a);
  --bx-warn: var(--dsw-alias-state-warn-primary, #e0a44a);
  --bx-fatal: var(--dsw-alias-state-error-primary, #e05a5a);
  --bx-idle: var(--dsw-alias-label-secondary, #8a8a8a);
  padding: 4px 2px 24px;
  font-size: 13px;
  line-height: 1.6;
}
.bx-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; margin-bottom: 12px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff08);
}
.bx-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; background: var(--bx-ok); }
.bx-dot.bad { background: var(--bx-fatal); box-shadow: 0 0 8px var(--bx-fatal); }
.bx-title { font-weight: 600; font-size: 14px; }
.bx-sub { color: var(--bx-idle); font-size: 12px; }
.bx-maker {
  font-size: 11px; color: var(--bx-idle);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 999px; padding: 1px 8px;
  flex: 0 0 auto; white-space: nowrap;
}
.bx-head-right { margin-left: auto; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; white-space: nowrap; }

.bx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 14px; }
.bx-card {
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-radius: 9px; padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.bx-card-label { color: var(--bx-idle); font-size: 11px; margin-bottom: 3px; }
.bx-card-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bx-card-value.hot { color: var(--bx-warn); }
.bx-card-value.zero { color: var(--bx-idle); }

.bx-btn {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 7px; padding: 5px 12px; font-size: 12px;
  cursor: pointer; font-family: inherit; white-space: nowrap;
}
.bx-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #5b8cff); }
.bx-btn:disabled { opacity: .45; cursor: not-allowed; }
.bx-btn.primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #5b8cff));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.bx-btn.primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, #5b8cff));
}
/* state-error-primary 是给状态点/图标用的深色，落在小号按钮文字上对比度不足；
   文字改用 DSH 的 label-error 令牌，并在令牌缺失时用高亮红兜底。 */
.bx-btn.danger {
  color: var(--dsw-alias-label-error, #ff7b7b);
  border-color: var(--dsw-alias-label-error, #ff7b7b);
}
.bx-btn.tiny { padding: 2px 8px; font-size: 11px; }

.bx-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.bx-chip {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: transparent; color: var(--dsw-alias-label-secondary, #8a8a8a);
  border-radius: 999px; padding: 3px 10px; font-size: 12px;
  cursor: pointer; font-family: inherit;
}
.bx-chip.on {
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  border-color: var(--dsw-alias-brand-primary, #5b8cff);
  color: var(--dsw-alias-label-primary, inherit);
}

.bx-item {
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-left-width: 3px; border-radius: 9px;
  padding: 10px 13px; margin-bottom: 9px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.bx-item.k-sos { border-left-color: var(--bx-fatal); }
.bx-item.k-l1 { border-left-color: var(--bx-warn); }
.bx-item.k-l2 { border-left-color: var(--dsw-alias-state-success-primary, #39d98a); }
.bx-item.k-l3 { border-left-color: var(--bx-idle); }
.bx-item.closed { opacity: .6; }
.bx-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bx-item-title { font-weight: 600; }
.bx-detail { white-space: pre-wrap; margin: 6px 0 0; color: var(--dsw-alias-label-secondary, #8a8a8a); }
.bx-meta { font-size: 11px; color: var(--bx-idle); margin-top: 6px; }
.bx-reply {
  margin-top: 8px; padding: 7px 10px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-left: 3px solid var(--bx-ok);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
}
.bx-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; align-items: center; }
.bx-reply-input { flex: 1 1 200px; min-width: 140px; }
.bx-badge {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #ffffff12); margin-right: 7px;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.bx-badge.k { color: var(--dsw-alias-label-primary, inherit); }
.bx-badge.lv-urgent { color: #fff; background: var(--bx-fatal); border: 1px solid var(--bx-fatal); }
.bx-badge.lv-important { color: #ffcf8a; background: #2a1f0d; border: 1px solid #7a5a20; }
.bx-badge.lv-normal { color: #9fd3a5; background: #12241a; border: 1px solid #2c5a3a; }
.bx-badge.lv-low { color: var(--bx-idle); }

.bx-cfg {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 9px; margin-bottom: 14px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.bx-cfg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; }
.bx-cfg-body { padding: 0 12px 12px; }
.bx-cfg-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 7px 0; border-top: 1px dashed var(--dsw-alias-border-l1, #ffffff12);
}
.bx-cfg-check {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--bx-idle); white-space: nowrap;
}
.bx-cfg-kind { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; }
.bx-cfg .bx-select { padding: 3px 7px; font-size: 12px; }

.bx-form { border: 1px solid var(--dsw-alias-border-l1, #ffffff12); border-radius: 9px; padding: 12px; margin-bottom: 14px; }
.bx-form-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.bx-input, .bx-select, .bx-textarea {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 7px; padding: 6px 9px; font-size: 12px; font-family: inherit;
}
.bx-input { flex: 1 1 220px; min-width: 160px; }
.bx-textarea { width: 100%; min-height: 68px; resize: vertical; }
.bx-empty { color: var(--bx-idle); font-size: 12px; padding: 18px 0; text-align: center; }
.bx-toast { margin-bottom: 12px; padding: 8px 11px; border-radius: 7px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, #ffffff1f); }
.bx-toast.ok { border-left: 3px solid var(--bx-ok); }
.bx-toast.err { border-left: 3px solid var(--bx-fatal); }
.bx-section-title {
  font-size: 12px; font-weight: 600; margin: 16px 0 8px;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  text-transform: uppercase; letter-spacing: .06em;
}
`

    function fmtTime(ts) {
      try {
        if (!ts) return '-'
        return new Date(ts).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return '-'
      }
    }

    async function fetchJson(pathname, options) {
      try {
        const res = await fetch(API + pathname, options || {})
        const text = await res.text()
        let body
        try { body = JSON.parse(text) } catch { throw new Error(`返回不是 JSON（HTTP ${res.status}）`) }
        if (!res.ok || body?.ok === false) {
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        return body
      } catch (e) {
        throw new Error(e?.message || String(e))
      }
    }

    function RequirementBoxPanel() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [filter, setFilter] = useState('all')
      const [showForm, setShowForm] = useState(false)
      const [draft, setDraft] = useState({ kind: 'l2', title: '', detail: '', level: '' })
      const [replyDraft, setReplyDraft] = useState({})
      const [notify, setNotify] = useState(null)
      const [notifyMeta, setNotifyMeta] = useState({})
      const [voices, setVoices] = useState(null)
      const [cfgOpen, setCfgOpen] = useState(false)
      const [notifyBusy, setNotifyBusy] = useState(false)
      const [notifyMsg, setNotifyMsg] = useState('')
      const timerRef = useRef(null)

      const load = useCallback(async () => {
        try {
          const r = await fetchJson('/items')
          setData(r)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setLoading(false)
        }
      }, [])

      // 通知分级配置单独取；失败不影响留言面板本身
      const loadNotify = useCallback(async () => {
        try {
          const r = await fetchJson('/notify/config')
          setNotify(r.config || null)
          setNotifyMeta(r.meta || {})
          setVoices(r.voices || null)
        } catch (e) {
          setNotifyMsg(`通知设置读取失败：${e?.message || e}`)
        }
      }, [])

      useEffect(() => {
        load()
        loadNotify()
        timerRef.current = setInterval(load, 15000)
        return () => { if (timerRef.current) clearInterval(timerRef.current) }
      }, [load, loadNotify])

      const act = useCallback(async (fn, label) => {
        setBusy(true)
        try {
          await fn()
          setToast({ ok: true, text: `${label}成功` })
          await load()
        } catch (e) {
          setToast({ ok: false, text: `${label}失败：${e?.message || String(e)}` })
        } finally {
          setBusy(false)
        }
      }, [load])

      const setReceipt = (id, receipt) => act(
        () => fetchJson('/receipt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, receipt, note: '' })
        }),
        `标记为${RECEIPT_LABEL[receipt] || receipt}`
      )

      const sendReply = (id) => {
        const text = (replyDraft[id] || '').trim()
        if (!text) { setToast({ ok: false, text: '回复内容不能为空' }); return }
        return act(() => fetchJson('/reply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, reply: text })
        }), '回复').then(() => {
          setReplyDraft((s) => ({ ...s, [id]: '' }))
        })
      }

      const removeItem = (id) => act(
        () => fetchJson('/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id })
        }),
        '删除'
      )

      const createItem = () => {
        if (!draft.title.trim()) { setToast({ ok: false, text: '标题不能为空' }); return }
        const payload = { ...draft }
        if (!payload.level) delete payload.level   // 不选 = 按类型/默认等级兜底
        return act(() => fetchJson('/new', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }), '新建').then(() => {
          setDraft({ kind: 'l2', title: '', detail: '', level: '' })
          setShowForm(false)
        })
      }

      // ── 通知分级设置 ──────────────────────────────────────────────
      const levelOf = (it) => {
        if (it?.level) return it.level
        const km = notify?.kindLevel || {}
        return km[it?.kind] || notify?.defaultLevel || 'normal'
      }

      const patchLevel = (lv, patch) => setNotify((n) => {
        if (!n) return n
        return { ...n, levels: { ...n.levels, [lv]: { ...(n.levels?.[lv] || {}), ...patch } } }
      })

      const patchKind = (k, v) => setNotify((n) => (n ? { ...n, kindLevel: { ...n.kindLevel, [k]: v } } : n))

      const patchWeather = (patch) => setNotify((n) => (n ? { ...n, weather: { ...(n.weather || {}), ...patch } } : n))

      const patchSpeech = (patch) => setNotify((n) => (n ? { ...n, speech: { ...(n.speech || {}), ...patch } } : n))
      const patchSpeechLevel = (lv, on) => setNotify((n) => {
        if (!n) return n
        const sp = n.speech || {}
        return { ...n, speech: { ...sp, levels: { ...(sp.levels || {}), [lv]: !!on } } }
      })

      // 试听：不建需求、不弹通知、只出声（先存一次，保证念的是界面上当前设置）
      const previewSpeech = async () => {
        if (!notify) return
        setNotifyBusy(true)
        setNotifyMsg('正在试听…')
        try {
          const saved = await fetchJson('/notify/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: notify })
          })
          if (saved?.config) setNotify(saved.config)
          const r = await fetchJson('/notify/speech/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
          })
          setNotifyMsg(r.degraded ? '已试听（降级为提示音）：未检测到中文语音' : `已试听：${r.text || ''}`)
        } catch (e) {
          setNotifyMsg(`试听失败：${e?.message || e}`)
        } finally {
          setNotifyBusy(false)
        }
      }

      const saveNotify = async () => {
        if (!notify) return
        setNotifyBusy(true)
        setNotifyMsg('正在保存…')
        try {
          const r = await fetchJson('/notify/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: notify })
          })
          if (r.config) setNotify(r.config)
          setNotifyMsg('已保存，立即生效（无需重启服务）')
        } catch (e) {
          setNotifyMsg(`保存失败：${e?.message || e}`)
        } finally {
          setNotifyBusy(false)
        }
      }

      const testLevel = async (lv) => {
        setNotifyBusy(true)
        setNotifyMsg(`正在测试「${LEVEL_LABEL[lv]}」…`)
        try {
          const r = await fetchJson('/notify/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ level: lv })
          })
          setNotifyMsg(r.ok ? `测试已发送：${LEVEL_LABEL[lv]}` : `未发送：${r.error || '该等级为静默或已关闭'}`)
        } catch (e) {
          setNotifyMsg(`测试结果：${e?.message || e}`)
        } finally {
          setNotifyBusy(false)
        }
      }

      // 一键清空：服务端会自动备份到 state/box-backup-*.json
      // 分两档：只清「已结束」（done + wontfix） / 全部清空
      const clearAll = async (scope) => {
        const tip = scope === 'finished'
          ? '将删除所有「已处理」和「不处理」的留言，保留未处理的。\n\n服务端会自动备份。确定？'
          : '⚠️ 将删除需求箱里【全部】留言，包括未处理的。\n\n服务端会自动备份，但仍请确认。'
        if (!window.confirm(tip)) return
        if (scope === 'all' && !window.confirm('最后确认：真的全部清空？')) return
        try {
          let removed = 0
          let remaining = 0
          let backup = null
          if (scope === 'finished') {
            for (const receipt of ['done', 'wontfix']) {
              const out = await fetchJson('/clear', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: true, receipt })
              })
              removed += out?.removed || 0
              remaining = out?.remaining ?? remaining
              backup = out?.backup || backup
            }
          } else {
            const out = await fetchJson('/clear', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ confirm: true })
            })
            removed = out?.removed || 0
            remaining = out?.remaining ?? 0
            backup = out?.backup || null
          }
          setToast({ ok: true, text: `已清空 ${removed} 条，剩余 ${remaining} 条${backup ? `（备份 ${backup}）` : ''}` })
          await load()
        } catch (e) {
          setToast({ ok: false, text: `清空失败：${e?.message || e}` })
        }
      }

      if (loading) {
        return h('div', { className: 'bx-root' },
          h('style', null, STYLE),
          h('div', { className: 'bx-empty' }, '正在读取需求箱…')
        )
      }

      const items = Array.isArray(data?.items) ? data.items : []
      const counts = data?.counts || {}
      const shown = filter === 'all' ? items : items.filter((i) => i.receipt === filter)
      const alive = !!data?.ok

      return h('div', { className: 'bx-root' },
        h('style', null, STYLE),

        h('div', { className: 'bx-head' },
          h('span', { className: `bx-dot ${alive ? '' : 'bad'}` }),
          h('div', null,
            h('div', { className: 'bx-title' }, alive ? '需求箱运行中' : '需求箱服务没连上'),
            h('div', { className: 'bx-sub' },
              alive
                ? `共 ${data?.total ?? items.length} 条留言 · 端口 3200`
                : '确认需求箱服务已启动（D:\\大肥鱼\\需求箱\\box-server.mjs）'
            )
          ),
          h('span', { className: 'bx-maker' }, `制作方：${MAKER}`),
          h('div', { className: 'bx-head-right' },
            h('button', { className: 'bx-btn', disabled: busy, onClick: () => load() }, '刷新'),
            h('button', {
              className: 'bx-btn tiny danger', disabled: busy,
              onClick: () => clearAll('finished'),
              title: '只清「已处理」「不处理」，保留未处理'
            }, '清空已结束'),
            h('button', {
              className: 'bx-btn tiny danger', disabled: busy,
              onClick: () => clearAll('all'),
              title: '清空全部留言（服务端会先备份）'
            }, '全部清空'),
            h('button', {
              className: 'bx-btn primary', disabled: busy,
              onClick: () => setShowForm((v) => !v)
            }, showForm ? '收起' : '新建一条')
          )
        ),

        toast ? h('div', { className: `bx-toast ${toast.ok ? 'ok' : 'err'}` }, toast.text) : null,

        h('div', { className: 'bx-grid' },
          h('div', { className: 'bx-card' },
            h('div', { className: 'bx-card-label' }, '待处理'),
            h('div', { className: `bx-card-value ${counts.open ? 'hot' : 'zero'}` }, counts.open || 0)
          ),
          h('div', { className: 'bx-card' },
            h('div', { className: 'bx-card-label' }, '现场求助'),
            h('div', { className: `bx-card-value ${counts.sos ? 'hot' : 'zero'}` }, counts.sos || 0)
          ),
          h('div', { className: 'bx-card' },
            h('div', { className: 'bx-card-label' }, 'L1 反馈'),
            h('div', { className: 'bx-card-value zero' }, counts.l1 || 0)
          ),
          h('div', { className: 'bx-card' },
            h('div', { className: 'bx-card-label' }, 'L2 需求'),
            h('div', { className: 'bx-card-value zero' }, counts.l2 || 0)
          ),
          h('div', { className: 'bx-card' },
            h('div', { className: 'bx-card-label' }, 'L3 牢骚'),
            h('div', { className: 'bx-card-value zero' }, counts.l3 || 0)
          )
        ),

        h('div', { className: 'bx-cfg' },
          h('div', { className: 'bx-cfg-head' },
            h('span', { className: 'bx-title' }, '🔔 通知分级'),
            h('span', { className: 'bx-sub' },
              notify ? `默认等级：${LEVEL_LABEL[notify.defaultLevel] || '普通'} · 保存后立即生效` : '读取通知设置…'),
            h('button', { className: 'bx-btn tiny', onClick: () => setCfgOpen((v) => !v) }, cfgOpen ? '收起' : '展开设置'),
            h('button', { className: 'bx-btn tiny primary', disabled: notifyBusy || !notify, onClick: saveNotify }, '保存设置')
          ),
          notifyMsg ? h('div', { className: 'bx-sub', style: { margin: '0 12px 8px' } }, notifyMsg) : null,
          cfgOpen && notify ? h('div', { className: 'bx-cfg-body' },
            h('div', { className: 'bx-cfg-row' },
              h('span', { className: 'bx-sub' }, '默认等级'),
              h('select', {
                className: 'bx-select', value: notify.defaultLevel,
                onChange: (e) => setNotify((n) => ({ ...n, defaultLevel: e.target.value }))
              }, LEVELS.map((lv) => h('option', { key: lv, value: lv }, LEVEL_LABEL[lv]))),
              h('label', { className: 'bx-cfg-check' },
                h('input', {
                  type: 'checkbox', checked: notify.watchExternal !== false,
                  onChange: (e) => setNotify((n) => ({ ...n, watchExternal: e.target.checked }))
                }), '监听 AI / QQ 桥接写入的新条目'
              )
            ),
            h('div', { className: 'bx-cfg-row' },
              h('span', { className: 'bx-sub' }, '天气'),
              h('label', { className: 'bx-cfg-check' },
                h('input', {
                  type: 'checkbox', checked: notify.weather?.enabled !== false,
                  onChange: (e) => patchWeather({ enabled: e.target.checked })
                }), '通知里附带实时天气（温度+状况+插图）'
              ),
              h('span', { className: 'bx-sub' }, '城市'),
              h('input', {
                className: 'bx-input', style: { flex: '0 0 160px', minWidth: '120px' },
                placeholder: '留空 = 按 IP 自动定位',
                value: notify.weather?.city || '',
                onChange: (e) => patchWeather({ city: e.target.value })
              }),
              h('span', { className: 'bx-sub' }, '免密钥接口；取不到天气也照常弹通知')
            ),
            // ── 语音广播 ──────────────────────────────────────────
            h('div', { className: 'bx-cfg-row' },
              h('span', { className: 'bx-sub' }, '语音'),
              h('label', { className: 'bx-cfg-check' },
                h('input', {
                  type: 'checkbox', checked: notify.speech?.enabled !== false,
                  onChange: (e) => patchSpeech({ enabled: e.target.checked })
                }), '启用语音播报'
              ),
              LEVELS.map((lv) => h('label', { key: lv, className: 'bx-cfg-check' },
                h('input', {
                  type: 'checkbox', checked: notify.speech?.levels?.[lv] === true,
                  onChange: (e) => patchSpeechLevel(lv, e.target.checked)
                }), `${LEVEL_LABEL[lv]}播报`
              )),
              h('button', { className: 'bx-btn tiny', disabled: notifyBusy, onClick: previewSpeech }, '试听'),
              h('span', { className: 'bx-sub' },
                !voices
                  ? '正在检测本机语音…'
                  : (voices.ok
                    ? `本机中文语音：${(voices.chinese || []).map((v) => v.name).join('、')}`
                    : '⚠️ 未检测到中文语音：播报会降级为只响提示音'))
            ),
            h('div', { className: 'bx-cfg-row' },
              h('span', { className: 'bx-sub' }, '播报内容'),
              h('input', {
                className: 'bx-input', style: { flex: '1 1 200px' },
                placeholder: '{level}：{type}，{title}',
                value: notify.speech?.template || '',
                onChange: (e) => patchSpeech({ template: e.target.value })
              }),
              h('label', { className: 'bx-cfg-check' },
                h('input', {
                  type: 'checkbox', checked: !!notify.speech?.customEnabled,
                  onChange: (e) => patchSpeech({ customEnabled: e.target.checked })
                }), '自定义文本优先'
              )
            ),
            h('div', { className: 'bx-cfg-row' },
              h('input', {
                className: 'bx-input', placeholder: '自定义播报文本（开启后忽略模板）',
                value: notify.speech?.customText || '',
                onChange: (e) => patchSpeech({ customText: e.target.value })
              }),
              h('span', { className: 'bx-sub' }, '语音'),
              h('select', {
                className: 'bx-select', value: notify.speech?.voice || 'Microsoft Huihui Desktop',
                onChange: (e) => patchSpeech({ voice: e.target.value })
              }, ((voices?.chinese?.length ? voices.chinese : [{ name: 'Microsoft Huihui Desktop', culture: 'zh-CN' }])
                .map((v) => h('option', { key: v.name, value: v.name }, `${v.name}（${v.culture}）`)))),
              h('span', { className: 'bx-sub' }, '语速'),
              h('select', {
                className: 'bx-select', value: String(Number(notify.speech?.rate) || 0),
                onChange: (e) => patchSpeech({ rate: Number(e.target.value) })
              }, [[-4, '很慢'], [-2, '稍慢'], [0, '正常'], [2, '稍快'], [4, '很快']]
                .map(([v, t]) => h('option', { key: v, value: String(v) }, t))),
              h('span', { className: 'bx-sub' }, '音量'),
              h('select', {
                className: 'bx-select', value: String(Number(notify.speech?.volume) || 80),
                onChange: (e) => patchSpeech({ volume: Number(e.target.value) })
              }, [30, 50, 80, 100].map((v) => h('option', { key: v, value: String(v) }, `${v}%`)))
            ),
            LEVELS.map((lv) => {
              const lc = notify.levels?.[lv] || {}
              const meta = notifyMeta?.[lv] || {}
              return h('div', { key: lv, className: 'bx-cfg-row' },
                h('span', { className: `bx-badge lv-${lv}` }, `${LEVEL_ICON[lv]} ${LEVEL_LABEL[lv]}`),
                h('label', { className: 'bx-cfg-check' },
                  h('input', {
                    type: 'checkbox', checked: lc.enabled !== false,
                    onChange: (e) => patchLevel(lv, { enabled: e.target.checked })
                  }), '启用'
                ),
                h('span', { className: 'bx-sub' }, '方式'),
                h('select', {
                  className: 'bx-select', value: lc.mode || 'toast',
                  onChange: (e) => patchLevel(lv, { mode: e.target.value })
                }, ['toast', 'dialog', 'sound', 'silent'].map((m) => h('option', { key: m, value: m }, MODE_LABEL[m]))),
                h('span', { className: 'bx-sub' }, '声音'),
                h('select', {
                  className: 'bx-select', value: lc.sound || 'off',
                  onChange: (e) => patchLevel(lv, { sound: e.target.value })
                }, ['off', 'once', 'loop'].map((s) => h('option', { key: s, value: s }, SOUND_LABEL[s]))),
                h('label', { className: 'bx-cfg-check' },
                  h('input', {
                    type: 'checkbox', checked: Number(lc.repeatTimes) > 1,
                    onChange: (e) => patchLevel(lv, { repeatTimes: e.target.checked ? 3 : 1 })
                  }), '持续提醒'
                ),
                h('label', { className: 'bx-cfg-check' },
                  h('input', {
                    type: 'checkbox', checked: !!lc.flash,
                    onChange: (e) => patchLevel(lv, { flash: e.target.checked })
                  }), '任务栏闪烁'
                ),
                h('button', { className: 'bx-btn tiny', disabled: notifyBusy, onClick: () => testLevel(lv) }, '测试'),
                h('span', { className: 'bx-sub' }, meta.desc || '')
              )
            }),
            h('div', { className: 'bx-cfg-row' },
              h('span', { className: 'bx-sub' }, '类型默认等级'),
              KINDS.map((k) => h('span', { key: k, className: 'bx-cfg-kind' },
                h('span', { className: 'bx-sub' }, KIND_LABEL[k]),
                h('select', {
                  className: 'bx-select',
                  value: (notify.kindLevel || {})[k] || notify.defaultLevel,
                  onChange: (e) => patchKind(k, e.target.value)
                }, LEVELS.map((lv) => h('option', { key: lv, value: lv }, LEVEL_LABEL[lv])))
              ))
            )
          ) : null
        ),

        showForm ? h('div', { className: 'bx-form' },
          h('div', { className: 'bx-form-row' },
            h('select', {
              className: 'bx-select', value: draft.kind,
              onChange: (e) => setDraft((d) => ({ ...d, kind: e.target.value }))
            }, KINDS.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k]))),
            h('select', {
              className: 'bx-select', value: draft.level || '',
              title: '通知等级：留空则按类型映射 / 默认等级',
              onChange: (e) => setDraft((d) => ({ ...d, level: e.target.value }))
            },
              h('option', { value: '' }, '自动等级'),
              LEVELS.map((lv) => h('option', { key: lv, value: lv }, `${LEVEL_ICON[lv]} ${LEVEL_LABEL[lv]}`))
            ),
            h('input', {
              className: 'bx-input', placeholder: '标题', value: draft.title,
              onChange: (e) => setDraft((d) => ({ ...d, title: e.target.value }))
            })
          ),
          h('textarea', {
            className: 'bx-textarea', placeholder: '详细描述（可选）', value: draft.detail,
            onChange: (e) => setDraft((d) => ({ ...d, detail: e.target.value }))
          }),
          h('div', { className: 'bx-acts' },
            h('button', { className: 'bx-btn primary', disabled: busy, onClick: createItem }, '提交'),
            h('button', { className: 'bx-btn', onClick: () => setShowForm(false) }, '取消')
          )
        ) : null,

        h('div', { className: 'bx-filters' },
          [['all', '全部'], ['open', '待处理'], ['received', '已收'], ['working', '处理中'], ['done', '已处理'], ['wontfix', '不处理']]
            .map(([key, label]) => h('button', {
              key,
              className: `bx-chip ${filter === key ? 'on' : ''}`,
              onClick: () => setFilter(key)
            }, label))
        ),

        h('div', { className: 'bx-section-title' }, `留言（${shown.length}）`),
        shown.length
          ? shown.map((it) => {
              const closed = it.receipt === 'done' || it.receipt === 'wontfix'
              return h('div', { key: it.id, className: `bx-item k-${it.kind} ${closed ? 'closed' : ''}` },
                h('div', { className: 'bx-item-head' },
                  h('span', { className: 'bx-badge k' }, KIND_LABEL[it.kind] || it.kind),
                  h('span', { className: `bx-badge lv-${levelOf(it)}`, title: '通知等级' },
                    `${LEVEL_ICON[levelOf(it)] || ''} ${LEVEL_LABEL[levelOf(it)] || levelOf(it)}`),
                  h('span', { className: 'bx-item-title' }, it.title || '(无标题)'),
                  h('span', { className: 'bx-badge' }, RECEIPT_LABEL[it.receipt] || it.receipt)
                ),
                it.detail ? h('div', { className: 'bx-detail' }, it.detail) : null,
                h('div', { className: 'bx-meta' },
                  `来自 ${it.source || '未知'} · ${fmtTime(it.createdAt)}`,
                  it.receiptAt ? ` · 回执于 ${fmtTime(it.receiptAt)}` : ''
                ),
                it.reply ? h('div', { className: 'bx-reply' }, `回复：${it.reply}`) : null,
                h('div', { className: 'bx-acts' },
                  RECEIPTS.map((r) => h('button', {
                    key: r,
                    className: `bx-btn tiny ${it.receipt === r ? 'primary' : ''}`,
                    disabled: busy,
                    onClick: () => setReceipt(it.id, r)
                  }, RECEIPT_LABEL[r]))
                ),
                h('div', { className: 'bx-acts' },
                  h('input', {
                    className: 'bx-input bx-reply-input',
                    placeholder: '写个回复…',
                    value: replyDraft[it.id] || '',
                    onChange: (e) => setReplyDraft((s) => ({ ...s, [it.id]: e.target.value }))
                  }),
                  h('button', { className: 'bx-btn tiny', disabled: busy, onClick: () => sendReply(it.id) }, '回复'),
                  h('button', { className: 'bx-btn tiny danger', disabled: busy, onClick: () => removeItem(it.id) }, '删除')
                )
              )
            })
          : h('div', { className: 'bx-empty' }, filter === 'all' ? '需求箱是空的 🐟' : '这个分类下没有留言'),

        h('div', { className: 'bx-section-title' }, '关于'),
        h('div', { className: 'bx-sub' },
          '数据存放在 D:\\大肥鱼\\qq-bridge\\state\\message-box.json，与 QQ 桥接共用；',
          `面板由 ${MAKER} 制作。`
        )
      )
    }

    // DSH 客户端插件契约：factory 必须返回带 `apply` 的对象，
    // `inject: ['slots']` 声明依赖客户端插槽服务。
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'requirement-box', order: 60, label: '需求箱' },
            RequirementBoxPanel
          )
        )
      }
    }
  }
})
