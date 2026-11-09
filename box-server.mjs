// 需求箱 · 独立控制页（单独网址）
// Copyright 2026 蝠羽科技 (fuyu-technology)  —  https://github.com/fuyu-technology
// 打开：http://127.0.0.1:3200/?token=<state/box-token 里的值>
// 数据与 qq-bridge 共用：D:\大肥鱼\qq-bridge\state\message-box.json
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createNotifyService, LEVELS, LEVEL_META } from './notify.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(ROOT, 'state')
const FILE = process.env.BOX_FILE || 'D:\\大肥鱼\\qq-bridge\\state\\message-box.json'
const TOKEN_FILE = path.join(STATE, 'box-token')
const PORT = Number(process.env.BOX_PORT) || 3200

fs.mkdirSync(STATE, { recursive: true })

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {}
  const t = crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(TOKEN_FILE, t + '\n', 'utf8')
  return t
}
const TOKEN = loadToken()

function readDoc() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')
    const d = JSON.parse(raw)
    if (d && Array.isArray(d.items)) return d
  } catch {}
  return { version: 1, items: [] }
}
function writeDoc(doc) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, FILE)
}

// 分级系统通知：配置在 state/notify-config.json，逻辑在 notify.mjs。
// 除了本服务新建的条目，也会监听桥接（AI）外部写入的新条目。
const NOTIFY = createNotifyService({
  stateDir: STATE,
  boxFile: FILE,
  readDoc,
  log: (m) => console.log(m)
})

const RECEIPT_LABEL = { open: '待处理', received: '已收', working: '处理中', done: '已处理', wontfix: '不处理' }
const KIND_LABEL = { sos: '现场求助', l1: 'L1 问题反馈', l2: 'L2 需求', l3: 'L3 牢骚' }

function send(res, code, obj) {
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
function authorized(req, url) {
  const h = req.headers['x-box-token']
  const q = url.searchParams.get('token')
  return (h && h === TOKEN) || (q && q === TOKEN)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(HTML)
    return
  }
  if (!p.startsWith('/api/')) { send(res, 404, { ok: false, error: 'not found' }); return }
  if (!authorized(req, url)) { send(res, 401, { ok: false, error: '令牌无效或缺失' }); return }

  if (req.method === 'GET' && p === '/api/box') {
    const doc = readDoc()
    const kind = url.searchParams.get('kind')
    const receipt = url.searchParams.get('receipt')
    let items = doc.items.slice()
    if (kind) items = items.filter((i) => i.kind === kind)
    if (receipt) items = items.filter((i) => i.receipt === receipt)
    items.sort((a, b) => b.createdAt - a.createdAt)
    const counts = { open: 0, sos: 0, l1: 0, l2: 0, l3: 0 }
    for (const i of doc.items) {
      if (i.receipt === 'open') counts.open++
      if (counts[i.kind] !== undefined) counts[i.kind]++
    }
    send(res, 200, { ok: true, items: items.slice(0, 500), counts, total: doc.items.length })
    return
  }

  // ── 分级通知：配置读取 / 保存 / 测试 ───────────────────────────────────
  if (req.method === 'GET' && p === '/api/notify/config') {
    send(res, 200, {
      ok: true,
      config: NOTIFY.getConfig(),
      levels: LEVELS,
      meta: LEVEL_META,
      voices: NOTIFY.voiceInfo(),
      log: NOTIFY.recentLog(20)
    })
    return
  }
  if (req.method === 'POST' && p === '/api/notify/config') {
    const body = await readBody(req)
    const r = NOTIFY.setConfig(body)
    send(res, r.ok ? 200 : 500, r)
    return
  }
  if (req.method === 'POST' && p === '/api/notify/test') {
    const body = await readBody(req)
    const r = await NOTIFY.test(body.level, body.text)
    send(res, 200, { ok: r.ok, ...r })
    return
  }
  // 语音试听：不建需求、不弹通知、只出声；立即返回（播报在后台跑）
  if (req.method === 'POST' && p === '/api/notify/speech/test') {
    const body = await readBody(req)
    send(res, 200, { ok: true, ...NOTIFY.previewSpeech(body.text) })
    return
  }
  // 语音探测：重新列一遍已安装语音（设置页用）
  if (req.method === 'GET' && p === '/api/notify/voices') {
    NOTIFY.probeVoices(!!url.searchParams.get('force')).then((v) => send(res, 200, { ok: true, ...v }))
    return
  }
  if (req.method === 'GET' && p === '/api/notify/log') {
    send(res, 200, { ok: true, log: NOTIFY.recentLog(Number(url.searchParams.get('lines')) || 40) })
    return
  }

  if (req.method === 'POST' && p === '/api/box/receipt') {
    const body = await readBody(req)
    if (!RECEIPT_LABEL[body.receipt] || body.receipt === 'open') { send(res, 400, { ok: false, error: '回执值无效' }); return }
    const doc = readDoc()
    const item = doc.items.find((i) => i.id === body.id)
    if (!item) { send(res, 404, { ok: false, error: '没找到这条留言' }); return }
    item.receipt = body.receipt
    item.receiptNote = String(body.note ?? '').slice(0, 500)
    item.receiptAt = Date.now()
    writeDoc(doc)
    send(res, 200, { ok: true, item })
    return
  }

  if (req.method === 'POST' && p === '/api/box/reply') {
    const body = await readBody(req)
    const text = String(body.reply ?? '').slice(0, 2000)
    if (!text.trim()) { send(res, 400, { ok: false, error: '回复内容不能为空' }); return }
    const doc = readDoc()
    const item = doc.items.find((i) => i.id === body.id)
    if (!item) { send(res, 404, { ok: false, error: '没找到这条留言' }); return }
    item.reply = text
    item.replyAt = Date.now()
    writeDoc(doc)
    send(res, 200, { ok: true, item })
    return
  }

  if (req.method === 'POST' && p === '/api/box/remove') {
    const body = await readBody(req)
    const doc = readDoc()
    const idx = doc.items.findIndex((i) => i.id === body.id)
    if (idx < 0) { send(res, 404, { ok: false, error: '没找到这条留言' }); return }
    doc.items.splice(idx, 1)
    writeDoc(doc)
    send(res, 200, { ok: true })
    return
  }

  // ── 一键清空 ────────────────────────────────────────────────────────────────
  // 清空是破坏性操作，所以：
  //   1) 必须带 confirm 字段，防误触（前端也会二次确认）；
  //   2) 清空前**自动备份**到 state/box-backup-<时间>.json，清错了还能找回；
  //   3) 支持按状态清（例如只清「已处理」），不强制全删。
  if (req.method === 'POST' && p === '/api/box/clear') {
    const body = await readBody(req)
    if (body.confirm !== true) {
      send(res, 400, { ok: false, error: '清空需要显式确认（confirm: true）' })
      return
    }
    const doc = readDoc()
    const before = doc.items.length
    if (!before) { send(res, 200, { ok: true, removed: 0, remaining: 0, backup: null }); return }

    // 自动备份：只保留最近 20 份，避免目录膨胀
    let backupPath = null
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = path.join(STATE, `box-backup-${stamp}.json`)
      fs.writeFileSync(backupPath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      const olds = fs.readdirSync(STATE)
        .filter((n) => n.startsWith('box-backup-') && n.endsWith('.json'))
        .sort()
      for (const n of olds.slice(0, Math.max(0, olds.length - 20))) {
        try { fs.unlinkSync(path.join(STATE, n)) } catch {}
      }
    } catch {}

    // 可选按状态清：body.receipt 为空则全清
    const only = String(body.receipt || '').trim()
    if (only) {
      doc.items = doc.items.filter((i) => i.receipt !== only)
    } else {
      doc.items = []
    }
    writeDoc(doc)
    send(res, 200, {
      ok: true,
      removed: before - doc.items.length,
      remaining: doc.items.length,
      backup: backupPath ? path.basename(backupPath) : null
    })
    return
  }


  if (req.method === 'POST' && p === '/api/box') {
    const body = await readBody(req)
    if (!KIND_LABEL[body.kind]) { send(res, 400, { ok: false, error: 'kind 无效' }); return }
    const item = {
      id: crypto.randomBytes(6).toString('hex'),
      kind: body.kind,
      // 触发等级：优先用请求里显式指定的，否则按类型映射 / 默认等级兜底
      level: NOTIFY.resolveLevel(body.kind, body.level),
      title: String(body.title || '').slice(0, 120),
      detail: String(body.detail || '').slice(0, 2000),
      key: null,
      source: 'admin',
      createdAt: Date.now(),
      receipt: 'open',
      receiptNote: '',
      receiptAt: 0,
      notified: null
    }
    if (!item.title) { send(res, 400, { ok: false, error: 'title 不能为空' }); return }
    const doc = readDoc()
    doc.items.push(item)
    writeDoc(doc)
    // 创建即提醒；标记已处理，避免监听器在下一轮重复弹窗
    NOTIFY.markSeen(item.id)
    const pushed = NOTIFY.fire(item, 'create')
    send(res, 200, { ok: true, item, notify: pushed })
    return
  }

  send(res, 404, { ok: false, error: 'not found' })
})

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>需求箱 · 大肥鱼</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1216;--card:#161b22;--line:#242c36;--text:#e6edf3;--muted:#8b98a5;--accent:#4aa8ff;--danger:#e2555b}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text)}
header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:18px;margin:0}
.muted{color:var(--muted);font-size:12px}
main{padding:18px 24px;max-width:1100px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
button{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
button.active{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{border-color:#5a2b2e;color:#e2555b}
button.danger:hover{background:var(--danger);border-color:var(--danger);color:#fff}
.item{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.item.sos{border-left:4px solid var(--danger)}
.item.done,.item.wontfix{opacity:.62}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tag{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.tag.sos{color:#fff;background:var(--danger);border-color:var(--danger)}
.title{font-weight:600}
.detail{white-space:pre-wrap;margin:8px 0;color:#cfd8e3}
.meta{font-size:12px;color:var(--muted)}
.note{margin-top:8px;font-size:12px;color:#9fd3a5}
.acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}
.acts input{flex:1;min-width:200px;background:#0d1117;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;font:inherit}
.empty{color:var(--muted);padding:40px 0;text-align:center}
.top-link{display:inline-flex;align-items:center;gap:4px;padding:5px 11px;border:1px solid var(--line);border-radius:999px;font-size:12px;font-weight:600;color:var(--text);text-decoration:none;background:var(--card)}
.top-link:hover{border-color:var(--accent);color:var(--accent)}
.cfg{border:1px solid var(--line);border-radius:10px;margin-bottom:14px;background:var(--card)}
.cfg>summary{cursor:pointer;padding:10px 14px;font-weight:600;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cfg>summary::-webkit-details-marker{display:none}
.cfg>summary::before{content:'▸';color:var(--muted)}
.cfg[open]>summary::before{content:'▾'}
.cfg-body{padding:0 14px 14px}
.cfg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 0;border-top:1px dashed var(--line)}
.cfg-row select{background:#0d1117;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:3px 7px;font:inherit;font-size:12px}
.cfg-row label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted)}
.cfg-note{color:var(--muted);font-size:12px;margin:8px 0}
.lv{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.lv.urgent{color:#fff;background:var(--danger);border-color:var(--danger)}
.lv.important{color:#ffcf8a;border-color:#7a5a20;background:#2a1f0d}
.lv.normal{color:#9fd3a5;border-color:#2c5a3a;background:#12241a}
.lv.low{color:var(--muted)}
#cfg-log{white-space:pre-wrap;font-size:11px;color:var(--muted);margin:0;max-height:140px;overflow:auto;background:#0d1117;border:1px solid var(--line);border-radius:8px;padding:8px}
.focus-item{outline:2px solid #4c9ffe;outline-offset:2px;border-radius:12px}
</style>
</head>
<body>
<header>
  <h1>需求箱</h1>
  <span class="muted" id="counts">读取中…</span>
  <span style="margin-left:auto"><a class="top-link" href="https://space.bilibili.com/2033307654" target="_blank" rel="noopener noreferrer">蝠羽科技 &#8599;</a></span>
  <span class="muted" id="live">—</span>
</header>
<main>
  <div class="bar" id="bar">
    <button data-f="" class="active">全部</button>
    <button data-f="open">未处理</button>
    <button data-f="sos">🚨 现场求助</button>
    <button data-f="l1">L1 问题反馈</button>
    <button data-f="l2">L2 需求</button>
    <button data-f="l3">L3 牢骚</button>
    <button id="clear-all" class="danger" style="margin-left:auto">🗑 清空</button>
  </div>
  <details class="cfg" id="cfg">
    <summary>🔔 通知分级设置 <span class="muted" id="cfg-state">读取中…</span></summary>
    <div class="cfg-body">
      <div class="cfg-note">新需求到达时按等级提醒。每个等级可单独开关、选提示方式；保存后立即生效（无需重启）。配置存 <code>state/notify-config.json</code>。</div>
      <div class="cfg-row" id="cfg-global"></div>
      <div class="cfg-row" id="cfg-weather"></div>
      <div class="cfg-row" id="cfg-speech"></div>
      <div class="cfg-row" id="cfg-speech2"></div>
      <div id="cfg-levels"></div>
      <div class="cfg-row" id="cfg-kinds"></div>
      <div class="cfg-row">
        <button id="cfg-save" class="active">保存设置</button>
        <button id="cfg-reload">重新读取</button>
        <span class="muted" id="cfg-msg"></span>
      </div>
      <div class="cfg-row"><span class="muted">最近通知日志</span></div>
      <pre id="cfg-log"></pre>
    </div>
  </details>
  <div id="list"></div>
</main>
<script>
var params = new URLSearchParams(location.search);
var TOKEN = params.get('token') || localStorage.getItem('box-token') || '';
if (TOKEN) localStorage.setItem('box-token', TOKEN);
var filter = '';
var KIND = { sos: '🚨 现场求助', l1: 'L1 问题反馈', l2: 'L2 需求', l3: 'L3 牢骚' };
var REC = { open: '待处理', received: '已收', working: '处理中', done: '已处理', wontfix: '不处理' };
// 通知等级（与 notify.mjs 保持一致）
var LEVELS = ['urgent', 'important', 'normal', 'low'];
var LNAME = { urgent: '紧急', important: '重要', normal: '普通', low: '低' };
var LICON = { urgent: '🚨', important: '⚠️', normal: '📝', low: '·' };
var NCFG = null, NMETA = {}, NVOICE = null;
function effLevel(it) {
  if (it && it.level) return it.level;
  var km = (NCFG && NCFG.kindLevel) || { sos: 'urgent', l1: 'important', l2: 'normal', l3: 'low' };
  return km[it && it.kind] || (NCFG && NCFG.defaultLevel) || 'normal';
}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
// 通知里的「去回复」会带 ?item=<id>#reply：定位到那条留言并聚焦回复输入框
function focusItem(){
  var id = params.get('item');
  if(!id) return;
  var el = document.querySelector('#list [data-id="'+id+'"]');
  if(!el) return;
  el.classList.add('focus-item');
  try { el.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){ el.scrollIntoView(); }
  if(location.hash === '#reply'){
    var box = el.querySelector('.reply-in');
    if(box){ try { box.focus({ preventScroll:true }); } catch(e){ box.focus(); } }
  }
}
function fmt(ms){if(!ms)return'';var d=new Date(ms);var p=function(n){return String(n).padStart(2,'0')};return (d.getMonth()+1)+'/'+d.getDate()+' '+p(d.getHours())+':'+p(d.getMinutes())}
async function api(path, method, body){
  var r = await fetch(path, { method: method||'GET', headers: { 'x-box-token': TOKEN, 'content-type': 'application/json' }, body: body?JSON.stringify(body):undefined });
  var j = await r.json().catch(function(){return {}});
  if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}
function paintFilter(){
  document.querySelectorAll('#bar button').forEach(function(b){ b.classList.toggle('active', b.dataset.f === filter); });
}
// 输入草稿：轮询重绘会清空输入框，这里按「条目id+字段」记住没保存的内容
var drafts = {};
function captureDrafts(){
  document.querySelectorAll('#list [data-id]').forEach(function(el){
    var id = el.dataset.id;
    el.querySelectorAll('input').forEach(function(inp){
      var field = inp.className;
      if (inp.value && inp.value !== inp.defaultValue) drafts[id + '::' + field] = inp.value;
      else if (inp.value === '') delete drafts[id + '::' + field];
    });
  });
}
// 正在打字就别重绘：把光标、选区、输入内容一起保住
function isTypingInList(){
  var a = document.activeElement;
  var list = document.getElementById('list');
  return !!(a && list && list.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
}
async function refresh(){
  if(!TOKEN){
    document.getElementById('list').innerHTML = '<div class="empty">请在地址后加 <code>?token=你的令牌</code><br>令牌在 D:\\大肥鱼\\需求箱\\state\\box-token</div>';
    return;
  }
  if (isTypingInList()) return;   // 打字期间跳过本轮，避免输入被清空
  captureDrafts();
  try{
    var q = filter==='open' ? '?receipt=open' : (filter ? '?kind='+filter : '');
    var r = await api('/api/box'+q);
    var c = r.counts||{};
    document.getElementById('counts').textContent = '未处理 '+(c.open||0)+' · 求助 '+(c.sos||0)+' · L1 '+(c.l1||0)+' · L2 '+(c.l2||0)+' · L3 '+(c.l3||0)+' · 共 '+(r.total||0)+' 条';
    document.getElementById('live').textContent = '已同步 '+new Date().toLocaleTimeString();
    var list = document.getElementById('list');
    if(!r.items.length){ list.innerHTML = '<div class="empty">箱子里还没有留言。鱼需要时会自己写进来。</div>'; return; }
    list.innerHTML = r.items.map(function(it){
      var cls = it.kind==='sos' ? 'item sos' : 'item';
      if(it.receipt==='done'||it.receipt==='wontfix') cls += ' '+it.receipt;
      var ntf = it.notified ? ' · 通知 '+esc(it.notified) : '';
      var replyVal = drafts[it.id + '::reply-in'] != null ? drafts[it.id + '::reply-in'] : (it.reply||'');
      var noteVal = drafts[it.id + '::note-in'] != null ? drafts[it.id + '::note-in'] : (it.receiptNote||'');
      var btns = ['received','working','done','wontfix'].map(function(x){
        return '<button data-r="'+x+'"'+(it.receipt===x?' class="active"':'')+'>'+REC[x]+'</button>';
      }).join('');
      // 两栏：左「鱼的诉求」= 原始标题与详情；右「我的回复」= 管理员写下的处理结果
      var replyBlock = it.replyAt
        ? '<div class="reply-text">'+esc(it.reply)+'</div><div class="muted2">回复于 '+fmt(it.replyAt)+'</div>'
        : '<div class="reply-empty">还没有回复</div>';
      var noteHtml = it.receiptNote ? '<div class="note">回执备注：'+esc(it.receiptNote)+'</div>' : '';
      return '<div class="'+cls+'" data-id="'+it.id+'">'+
        '<div class="head"><span class="tag '+(it.kind==='sos'?'sos':'')+'">'+(KIND[it.kind]||it.kind)+'</span>'+
        '<span class="lv '+effLevel(it)+'">'+LICON[effLevel(it)]+' '+LNAME[effLevel(it)]+'</span>'+
        '<span class="title">'+esc(it.title)+'</span>'+
        '<span class="meta" style="margin-left:auto">'+fmt(it.createdAt)+' · '+esc(it.key||'无会话')+' · 来自 '+esc(it.source)+ntf+'</span></div>'+
        '<div class="cols">'+
          '<div class="col">'+
            '<div class="col-h">🐟 鱼的诉求</div>'+
            (it.detail ? '<div class="detail">'+esc(it.detail)+'</div>' : '<div class="reply-empty">（没有补充说明）</div>')+
          '</div>'+
          '<div class="col">'+
            '<div class="col-h">✍ 我的回复</div>'+
            replyBlock+
            '<div class="reply-edit"><input class="reply-in" placeholder="写一句处理后的回复…" value="'+esc(replyVal)+'"><button class="reply-save">保存回复</button></div>'+
          '</div>'+
        '</div>'+
        noteHtml+
        '<div class="acts"><input class="note-in" placeholder="回执备注（可选）" value="'+esc(noteVal)+'">'+btns+'<button data-del="1" title="删除">✕</button></div>'+
      '</div>';
    }).join('');
    list.querySelectorAll('[data-id]').forEach(function(el){
      var id = el.dataset.id;
      el.querySelectorAll('[data-r]').forEach(function(b){
        b.onclick = async function(){
          var r = b.dataset.r;
          // 两种「关门」动作都要确认：处理完成、不处理
          if(r==='done' && !confirm('标记为「处理完成」？\\n\\n这条留言会被归档为已处理，鱼会看到这个回执。')) return;
          if(r==='wontfix' && !confirm('标记为「不处理」？\\n\\n这条留言会被归档为不处理，鱼会看到这个回执。')) return;
          try{
            await api('/api/box/receipt','POST',{id:id,receipt:r,note:el.querySelector('.note-in').value});
            delete drafts[id + '::note-in'];
            // 立刻只高亮刚点的这个，不等下一次轮询
            el.querySelectorAll('[data-r]').forEach(function(x){ x.classList.toggle('active', x === b); });
            refresh();
          }
          catch(e){ alert('保存失败：'+e.message); }
        };
      });
      var saveBtn = el.querySelector('.reply-save');
      if (saveBtn) saveBtn.onclick = async function(){
        var text = el.querySelector('.reply-in').value;
        if (!text.trim()) { alert('回复内容不能为空'); return; }
        try{
          await api('/api/box/reply','POST',{ id: id, reply: text });
          delete drafts[id + '::reply-in'];
          refresh();
        } catch(e){ alert('保存回复失败：' + e.message); }
      };
      el.querySelector('[data-del]').onclick = async function(){
        if(!confirm('删除这条留言？')) return;
        try{ await api('/api/box/remove','POST',{id:id}); refresh(); }catch(e){ alert('删除失败：'+e.message); }
      };
    });
  }catch(e){
    document.getElementById('list').innerHTML = '<div class="empty">读取失败：'+esc(e.message)+'</div>';
  }
  focusItem();
}
document.querySelectorAll('#bar button').forEach(function(b){
  b.onclick = function(){ filter = b.dataset.f; paintFilter(); refresh(); };
});
// ── 一键清空 ───────────────────────────────────────────────────────────────
// 清空不可撤销（服务端会自动备份一份到 state/box-backup-*.json）。
// 默认只清「已处理/不处理」，全清需要再多确认一次，避免手滑把未处理的也删了。
document.getElementById('clear-all').onclick = async function(){
  var scope = prompt('清空范围：\\n\\n输入 1 = 只清「已处理」和「不处理」\\n输入 2 = 清空全部（包括未处理）\\n\\n留空取消');
  if (scope !== '1' && scope !== '2') return;
  var receipt = scope === '1' ? 'done' : '';
  var tip = scope === '1'
    ? '将删除所有「已处理」的留言（「不处理」的会保留）。确定？'
    : '⚠️ 将删除箱子里【全部】留言，包括未处理的。\\n\\n服务端会自动备份，但仍请确认。';
  if (!confirm(tip)) return;
  if (scope === '2' && !confirm('最后确认：真的全部清空？')) return;
  try{
    var out = await api('/api/box/clear', 'POST', { confirm: true, receipt: receipt });
    // 只清 done 时，再单独清一次 wontfix（保持语义简单：口子只分「已结束」与「全部」）
    if (scope === '1') {
      var out2 = await api('/api/box/clear', 'POST', { confirm: true, receipt: 'wontfix' });
      out.removed += out2.removed;
    }
    alert('已清空 ' + out.removed + ' 条，剩余 ' + out.remaining + ' 条。' + (out.backup ? '\\n备份：' + out.backup : ''));
    drafts = {};
    refresh();
  }catch(e){ alert('清空失败：' + e.message); }
};
// ── 通知分级设置 ────────────────────────────────────────────────────────────
function mkSel(id, pairs, value){
  return '<select id="'+id+'">'+pairs.map(function(p){
    return '<option value="'+p[0]+'"'+(p[0]===value?' selected':'')+'>'+p[1]+'</option>';
  }).join('')+'</select>';
}
function renderNotify(logText){
  if(!NCFG) return;
  var gl = document.getElementById('cfg-global');
  gl.innerHTML = '<span>默认等级</span>' +
    mkSel('cfg-default-level', LEVELS.map(function(l){return [l, LNAME[l]]}), NCFG.defaultLevel) +
    '<label><input type="checkbox" id="cfg-watch" '+(NCFG.watchExternal!==false?'checked':'')+'> 监听外部写入（AI / QQ 桥接）</label>';
  var wx = NCFG.weather || { enabled: true, city: '' };
  document.getElementById('cfg-weather').innerHTML =
    '<span>天气</span>' +
    '<label><input type="checkbox" id="cfg-wx" '+(wx.enabled!==false?'checked':'')+'> 通知里附带实时天气（温度+状况+插图）</label>' +
    '<span>城市</span>' +
    '<input id="cfg-wx-city" placeholder="留空 = 按 IP 自动定位；填了就用手填，如 合肥 / 安徽合肥" value="'+esc(wx.city||'')+'" style="width:240px">' +
    '<span class="muted">免密钥接口；取不到天气也照常弹通知</span>';
  // ── 语音广播 ──────────────────────────────────────────────────
  var sp = NCFG.speech || {};
  var vi = NVOICE || { checked: false, voices: [], chinese: [], preferred: '' };
  var zhVoices = (vi.chinese && vi.chinese.length) ? vi.chinese : (vi.voices || []);
  var voiceOpts = zhVoices.map(function(v){ return [v.name, v.name + '（' + v.culture + '）']; });
  if (!voiceOpts.length) voiceOpts = [[sp.voice || 'Microsoft Huihui Desktop', 'Microsoft Huihui Desktop（zh-CN）']];
  var voiceNote = !vi.checked
    ? '正在检测本机语音…'
    : (vi.ok ? '' : '⚠️ 未检测到中文语音：播报会降级为只响提示音');
  document.getElementById('cfg-speech').innerHTML =
    '<span>语音广播</span>' +
    '<label><input type="checkbox" id="cfg-sp" '+(sp.enabled!==false?'checked':'')+'> 启用语音播报</label>' +
    LEVELS.map(function(lv){
      var on = (sp.levels||{})[lv] === true;
      return '<label><input type="checkbox" class="sp-lv" data-lv="'+lv+'" '+(on?'checked':'')+'> '+LNAME[lv]+'播报</label>';
    }).join('') +
    '<button id="cfg-sp-test">试听</button>' +
    '<span class="muted" id="cfg-sp-note">'+esc(voiceNote)+'</span>';
  document.getElementById('cfg-speech2').innerHTML =
    '<span>播报内容</span>' +
    '<input id="cfg-sp-tpl" value="'+esc(sp.template||'')+'" placeholder="{level}：{type}，{title}" style="width:220px">' +
    '<span class="muted">占位符 {level} {type} {title} {source}</span>' +
    '<label><input type="checkbox" id="cfg-sp-custom" '+(sp.customEnabled?'checked':'')+'> 用自定义文本</label>' +
    '<input id="cfg-sp-custom-text" value="'+esc(sp.customText||'')+'" placeholder="例如：有新的需求，请查看需求箱" style="flex:1;min-width:200px">' +
    '<span>语音</span>' + mkSel('cfg-sp-voice', voiceOpts, sp.voice) +
    '<span>语速</span>' + mkSel('cfg-sp-rate', [[-4,'很慢'],[-2,'稍慢'],[0,'正常'],[2,'稍快'],[4,'很快']], Number(sp.rate)||0) +
    '<span>音量</span>' + mkSel('cfg-sp-volume', [[30,'30%'],[50,'50%'],[80,'80%'],[100,'100%']], Number(sp.volume)||80);

  document.getElementById('cfg-levels').innerHTML = LEVELS.map(function(lv){
    var lc = NCFG.levels[lv] || {};
    var meta = NMETA[lv] || { label: LNAME[lv], icon: LICON[lv], desc: '' };
    return '<div class="cfg-row" data-lv="'+lv+'">' +
      '<span class="lv '+lv+'">'+meta.icon+' '+meta.label+'</span>' +
      '<label><input type="checkbox" class="lv-enabled" '+(lc.enabled!==false?'checked':'')+'> 启用</label>' +
      '<span>方式</span>' + mkSel('mode-'+lv, [['toast','系统通知'],['dialog','弹窗'],['sound','声音'],['silent','静默']], lc.mode) +
      '<span>声音</span>' + mkSel('sound-'+lv, [['off','不出声'],['once','响一次'],['loop','循环']], lc.sound) +
      '<label><input type="checkbox" class="lv-repeat" '+(Number(lc.repeatTimes)>1?'checked':'')+'> 持续提醒</label>' +
      '<label><input type="checkbox" class="lv-flash" '+(lc.flash?'checked':'')+'> 任务栏闪烁</label>' +
      '<button class="lv-test">测试</button>' +
      '<span class="muted">'+esc(meta.desc || '')+'</span>' +
      '</div>';
  }).join('');
  var kinds = ['sos','l1','l2','l3'];
  document.getElementById('cfg-kinds').innerHTML = '<span>类型对应的默认等级</span>' + kinds.map(function(k){
    return '<span class="muted">'+esc(KIND[k])+'</span>' +
      mkSel('kind-'+k, LEVELS.map(function(l){return [l, LNAME[l]]}), (NCFG.kindLevel||{})[k]);
  }).join(' ');
  document.getElementById('cfg-log').textContent = logText || '（暂无日志）';
  document.querySelectorAll('.lv-test').forEach(function(b){
    b.onclick = async function(){
      var lv = b.closest('[data-lv]').dataset.lv;
      b.disabled = true;
      document.getElementById('cfg-msg').textContent = '正在测试「'+LNAME[lv]+'」…';
      try{
        var r = await api('/api/notify/test','POST',{level:lv});
        document.getElementById('cfg-msg').textContent = r.ok ? ('测试已发送：'+LNAME[lv]) : ('未发送：'+(r.error||'该等级为静默/已关闭'));
      }catch(e){
        document.getElementById('cfg-msg').textContent = '测试失败：'+e.message;
      }finally{
        b.disabled = false;
        setTimeout(loadNotify, 800);
      }
    };
  });
  // 试听：不建需求、不弹通知、只出声
  var spTest = document.getElementById('cfg-sp-test');
  if (spTest) spTest.onclick = async function(){
    spTest.disabled = true;
    var msg = document.getElementById('cfg-msg');
    msg.textContent = '正在试听…';
    try{
      // 先把当前输入的内容存一遍，试听才会用最新的模板/自定义文本
      await saveSpeechOnly();
      var r = await api('/api/notify/speech/test','POST',{});
      msg.textContent = r.degraded ? ('已试听（降级为提示音）：未检测到中文语音') : ('已试听：'+ (r.text || ''));
    }catch(e){
      msg.textContent = '试听失败：'+e.message;
    }finally{
      spTest.disabled = false;
    }
  };
}
async function loadNotify(){
  try{
    var r = await api('/api/notify/config');
    NCFG = r.config; NMETA = r.meta || {}; NVOICE = r.voices || null;
    document.getElementById('cfg-state').textContent = '已读取 ' + new Date().toLocaleTimeString();
    renderNotify(r.log);
  }catch(e){
    document.getElementById('cfg-state').textContent = '读取失败：' + e.message;
  }
}
// 从界面收集语音设置（总开关 / 四级勾选 / 模板 / 自定义文本 / 语音 / 语速 / 音量）
function collectSpeech(next){
  var sp = next.speech || {};
  var on = document.getElementById('cfg-sp');
  if (on) sp.enabled = on.checked;
  var lvOn = { urgent:false, important:false, normal:false, low:false };
  document.querySelectorAll('.sp-lv').forEach(function(c){ lvOn[c.dataset.lv] = c.checked; });
  if (document.querySelector('.sp-lv')) sp.levels = lvOn;
  var tpl = document.getElementById('cfg-sp-tpl');
  if (tpl) sp.template = tpl.value;
  var cu = document.getElementById('cfg-sp-custom');
  if (cu) sp.customEnabled = cu.checked;
  var ct = document.getElementById('cfg-sp-custom-text');
  if (ct) sp.customText = ct.value;
  var vo = document.getElementById('cfg-sp-voice');
  if (vo) sp.voice = vo.value;
  var rt = document.getElementById('cfg-sp-rate');
  if (rt) sp.rate = Number(rt.value) || 0;
  var vl = document.getElementById('cfg-sp-volume');
  if (vl) sp.volume = Number(vl.value) || 80;
  next.speech = sp;
  return next;
}
// 试听前先静默保存一次，保证念的是界面上当前的模板/自定义文本
async function saveSpeechOnly(){
  if(!NCFG) return;
  var next = collectSpeech(JSON.parse(JSON.stringify(NCFG)));
  var r = await api('/api/notify/config','POST',{config:next});
  if (r && r.config) NCFG = r.config;
}
document.getElementById('cfg-save').onclick = async function(){
  if(!NCFG) return;
  var next = JSON.parse(JSON.stringify(NCFG));
  next.defaultLevel = document.getElementById('cfg-default-level').value;
  next.watchExternal = document.getElementById('cfg-watch').checked;
  var wxBox = document.getElementById('cfg-wx');
  if (wxBox) {
    next.weather = next.weather || {};
    next.weather.enabled = wxBox.checked;
    next.weather.city = String((document.getElementById('cfg-wx-city').value || '')).trim();
  }
  LEVELS.forEach(function(lv){
    var row = document.querySelector('[data-lv="'+lv+'"]');
    var lc = next.levels[lv] || {};
    lc.enabled = row.querySelector('.lv-enabled').checked;
    lc.mode = document.getElementById('mode-'+lv).value;
    lc.sound = document.getElementById('sound-'+lv).value;
    lc.repeatTimes = row.querySelector('.lv-repeat').checked ? 3 : 1;
    lc.flash = row.querySelector('.lv-flash').checked;
    next.levels[lv] = lc;
  });
  ['sos','l1','l2','l3'].forEach(function(k){
    next.kindLevel[k] = document.getElementById('kind-'+k).value;
  });
  collectSpeech(next);
  try{
    await api('/api/notify/config','POST',{config:next});
    document.getElementById('cfg-msg').textContent = '已保存，立即生效';
    await loadNotify();
    refresh();
  }catch(e){
    document.getElementById('cfg-msg').textContent = '保存失败：'+e.message;
  }
};
document.getElementById('cfg-reload').onclick = loadNotify;

paintFilter();
loadNotify();
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`

server.listen(PORT, '127.0.0.1', () => {
  console.log(`需求箱独立页面: http://127.0.0.1:${PORT}/?token=${TOKEN}`)
  console.log(`数据文件: ${FILE}`)
  console.log(`通知配置: ${NOTIFY.files.config}`)
  NOTIFY.start()
})
