// dshbox:// 协议处理器（由 notify-action.vbs 以隐藏窗口拉起，不闪控制台）
// Copyright 2026 蝠羽科技 (fuyu-technology)  —  https://github.com/fuyu-technology
//   dshbox://status?item=<id>&to=accepted|doing|done  → 改需求状态（不打开页面）
//   dshbox://open?item=<id>#reply                     → 打开该需求的回复区
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createNotifyService } from './notify.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(ROOT, 'state')
const LOG = path.join(STATE, 'notify-action.log')
const BOX_PORT = Number(process.env.BOX_PORT) || 3200
// toast 上的三个按钮 → 需求箱已有的回执值
const RECEIPT = { accepted: 'received', doing: 'working', done: 'done' }

function logLine(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch {}
}

function readToken() {
  try { return fs.readFileSync(path.join(STATE, 'box-token'), 'utf8').trim() } catch { return '' }
}

function postJson(pathname, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port: BOX_PORT, path: pathname, method: 'POST', timeout: 4000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-box-token': readToken()
      }
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.on('timeout', () => { try { req.destroy() } catch {}; resolve({ status: 0, error: 'timeout' }) })
    req.write(data)
    req.end()
  })
}

async function main() {
  const raw = String(process.argv[2] || '').trim()
  if (!raw) return
  let u
  try { u = new URL(raw) } catch { logLine(`无法解析：${raw}`); return }

  const action = u.hostname.toLowerCase()
  const item = (u.searchParams.get('item') || '').trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(item)) { logLine(`item 非法：${raw}`); return }

  if (action === 'status') {
    const to = (u.searchParams.get('to') || '').toLowerCase()
    const receipt = RECEIPT[to]
    if (!receipt) { logLine(`状态非法：${to}（只接受 accepted/doing/done）`); return }
    const r = await postJson('/api/box/receipt', { id: item, receipt })
    logLine(`status ${to}→${receipt} item=${item} http=${r.status}${r.error ? ' ' + r.error : ''}`)
    return
  }

  if (action === 'open') {
    let base = ''
    try {
      const svc = createNotifyService({ stateDir: STATE, boxFile: process.env.BOX_FILE, readDoc: () => ({ items: [] }), log: () => {} })
      base = await svc.resolveOpenUrl()
    } catch {}
    if (!base) base = `http://127.0.0.1:${BOX_PORT}/`
    const sep = base.includes('?') ? '&' : '?'
    const url = `${base}${sep}item=${item}#reply`
    // 交给系统默认浏览器打开（用户主动点击，属于正常跳转）
    spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    logLine(`open ${url}`)
    return
  }

  logLine(`未知动作：${action}（${raw}）`)
}

main().catch((e) => logLine(`异常：${e?.message || e}`))
