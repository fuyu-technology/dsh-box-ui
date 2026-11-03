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
      const [draft, setDraft] = useState({ kind: 'l2', title: '', detail: '' })
      const [replyDraft, setReplyDraft] = useState({})
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

      useEffect(() => {
        load()
        timerRef.current = setInterval(load, 15000)
        return () => { if (timerRef.current) clearInterval(timerRef.current) }
      }, [load])

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
        return act(() => fetchJson('/new', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft)
        }), '新建').then(() => {
          setDraft({ kind: 'l2', title: '', detail: '' })
          setShowForm(false)
        })
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

        showForm ? h('div', { className: 'bx-form' },
          h('div', { className: 'bx-form-row' },
            h('select', {
              className: 'bx-select', value: draft.kind,
              onChange: (e) => setDraft((d) => ({ ...d, kind: e.target.value }))
            }, KINDS.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k]))),
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
