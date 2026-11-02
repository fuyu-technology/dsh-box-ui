// dsh-box-ui · 宿主侧
//
// 职责：把「需求箱」本地服务（box-server，127.0.0.1:3200）的数据暴露成 DSH 的 HTTP API，
// 供客户端面板读取和操作。
//
// 和 auto-repair 面板同样的结构思路：
//   - 面板是 DSH 插件，跑在 DSH 进程里；DSH 崩了它就没了。
//   - 所以真正的数据与逻辑留在 DSH 之外（box-server 自己管 message-box.json）。
//   - 这里只是「转发 + 注入令牌」的一层壳。
//
// 令牌说明：box-server 的 API 要求 `x-box-token`（或 ?token=），令牌在
// D:\大肥鱼\需求箱\state\box-token。插件代为注入，浏览器端永远看不到令牌。

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const NS = 'dsh-box-ui'
const API_BASE = '/dsh-box'

// 需求箱服务本体。注意：插件装在 ~/.dsh/plugins/ 下，需求箱在 D:\大肥鱼\需求箱\，
// 两者不在同一棵目录树里，必须写绝对路径（相对路径会算到 ~/.dsh 底下去）。
// 绝对路径可用 BOX_DIR 覆盖，方便把插件搬到别的机器上。
const BOX_DIR = process.env.BOX_DIR || 'D:\\大肥鱼\\需求箱'
const TOKEN_FILE = path.join(BOX_DIR, 'state', 'box-token')
const BOX_PORT = Number(process.env.BOX_PORT) || 3200
const BOX_HOST = '127.0.0.1'

/** 读需求箱令牌（每次都重读，服务端可能轮换） */
function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    return t || ''
  } catch {
    return ''
  }
}

/** 转发一个请求到需求箱服务 */
function forward(method, apiPath, body) {
  return new Promise((resolve) => {
    const token = readToken()
    if (!token) {
      resolve({ status: 503, json: { ok: false, error: '读不到需求箱令牌，请确认需求箱服务已启动' } })
      return
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { 'x-box-token': token }
    if (payload) {
      headers['content-type'] = 'application/json; charset=utf-8'
      headers['content-length'] = String(payload.length)
    }
    const req = http.request(
      { host: BOX_HOST, port: BOX_PORT, method, path: apiPath, headers, timeout: 12000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 502, json: JSON.parse(raw) })
          } catch {
            resolve({ status: 502, json: { ok: false, error: '需求箱返回了非 JSON 内容' } })
          }
        })
      }
    )
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, json: { ok: false, error: '需求箱服务超时' } }) })
    req.on('error', (e) => resolve({ status: 502, json: { ok: false, error: `连不上需求箱服务：${e.message}` } }))
    if (payload) req.write(payload)
    req.end()
  })
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function apply(ctx) {
  let webServer
  try {
    webServer = (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined) || ctx?.webServer
  } catch {
    webServer = ctx?.webServer
  }
  if (!webServer || typeof webServer.register !== 'function') {
    try { ctx?.logger?.warn?.(`[${NS}] webServer 不可用，API 路由未注册`) } catch {}
    return
  }

  const disposers = []

  // 需求箱健康检查（面板用来判断服务在不在）
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/health`,
    handler: async (req, res) => {
      const r = await forward('GET', '/api/box')
      sendJson(res, r.json?.ok ? 200 : 502, {
        ok: !!r.json?.ok,
        alive: !!r.json?.ok,
        port: BOX_PORT,
        error: r.json?.ok ? '' : (r.json?.error || '需求箱服务不可用')
      })
    }
  }))

  // 列表
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/items`,
    handler: async (req, res) => {
      const r = await forward('GET', '/api/box')
      sendJson(res, r.status, r.json)
    }
  }))

  // 改回执
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/receipt`,
    handler: async (req, res) => {
      const body = await readBody(req)
      const r = await forward('POST', '/api/box/receipt', body)
      sendJson(res, r.status, r.json)
    }
  }))

  // 回复
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/reply`,
    handler: async (req, res) => {
      const body = await readBody(req)
      const r = await forward('POST', '/api/box/reply', body)
      sendJson(res, r.status, r.json)
    }
  }))

  // 删除
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/remove`,
    handler: async (req, res) => {
      const body = await readBody(req)
      const r = await forward('POST', '/api/box/remove', body)
      sendJson(res, r.status, r.json)
    }
  }))

  // 新建一条
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/new`,
    handler: async (req, res) => {
      const body = await readBody(req)
      const r = await forward('POST', '/api/box', body)
      sendJson(res, r.status, r.json)
    }
  }))

  const dispose = () => {
    for (const d of disposers) {
      try { d?.dispose?.() } catch {}
    }
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, `${NS}: api routes`)
  try {
    ctx?.logger?.info?.(`[${NS}] API 路由就绪，前缀 ${API_BASE}，后端 ${BOX_HOST}:${BOX_PORT}`)
  } catch {}
  return dispose
}

/**
 * cordis 依赖注入声明：这个宿主侧 bundle 需要哪些服务。
 * 注意与客户端的 `inject: ['slots']`（插槽）不是一回事 —— 这里是**宿主服务**。
 */
const inject = ['webServer']
const name = NS

export { apply, inject, name }
