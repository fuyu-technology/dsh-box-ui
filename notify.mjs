// 需求箱 · 分级系统通知
// Copyright 2026 蝠羽科技 (fuyu-technology)  —  https://github.com/fuyu-technology
//
// 作用：监听 message-box.json 里的新条目，按「紧急 / 重要 / 普通 / 低」四个等级
// 用 Windows 系统能力提醒用户。配置存 state/notify-config.json，改完立即生效。
//
// 设计约束：
// - 不阻塞需求箱主进程：PowerShell 一律异步 spawn，带超时兜底。
// - Toast 不可用时自动降级到弹窗（WScript.Popup）→ 任务栏闪烁，不抛异常。
// - 不需要管理员权限，也不改 DSH / resources / locales 等运行时文件。
//
// 命令行自测：
//   node notify.mjs test urgent
//   node notify.mjs test important
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LEVELS = ['urgent', 'important', 'normal', 'low']
export const KIND_LABEL = { sos: '现场求助', l1: 'L1 问题反馈', l2: 'L2 需求', l3: 'L3 牢骚' }

export const LEVEL_META = {
  urgent: { label: '紧急', icon: '🚨', desc: '高分贝 Toast + 持续提醒 + 循环提示音 + 任务栏闪烁' },
  important: { label: '重要', icon: '⚠️', desc: 'Toast 弹窗 + 响一声' },
  normal: { label: '普通', icon: '📝', desc: '只弹 Toast，不出声' },
  low: { label: '低', icon: '·', desc: '静默，只在需求箱列表里留记录' }
}

// 语音广播里对类型的口语化叫法（比列表里「L2 需求」更适合念出来）
export const KIND_SPEECH = { sos: '现场求助', l1: '问题反馈', l2: '新需求', l3: '牢骚' }

export const MODES = ['toast', 'dialog', 'sound', 'silent']
export const SOUND_MODES = ['off', 'once', 'loop']
export const SCENARIOS = ['default', 'reminder', 'urgent', 'alarm']
export const DURATIONS = ['default', 'long', 'short']

// 插件自己的 AppUserModelID：由 ensureIdentity() 在首次运行时自动注册
// （开始菜单快捷方式 + HKCU\Software\Classes\AppUserModelId），注册成功才会显示卡片
export const DEFAULT_APP_ID = 'DshBox.Notification'

// 旧版借用过的「Windows PowerShell」AUMID：PowerShell 不在 shell:AppsFolder 里，
// 用它发 Toast 会被系统静默丢弃，历史配置读到它时一律归一到自建 ID
const LEGACY_APP_IDS = new Set([
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe',
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\powershell.exe'
])

function normalizeAppId(v) {
  const id = String(v ?? '').trim()
  if (!id) return DEFAULT_APP_ID
  if (LEGACY_APP_IDS.has(id)) return DEFAULT_APP_ID
  // 只允许紧凑的 AUMID 形态，避免配置里塞进奇怪值导致身份无效
  return /^[A-Za-z0-9_.-]{1,64}$/.test(id) || /^[^<>"\s]{1,120}$/.test(id) ? id : DEFAULT_APP_ID
}

export const DEFAULT_CONFIG = {
  version: 1,
  defaultLevel: 'normal',
  kindLevel: { sos: 'urgent', l1: 'important', l2: 'normal', l3: 'low' },
  watchExternal: true,
  toastAppId: DEFAULT_APP_ID,
  // 天气：默认开启、默认按 IP 自动定位；city 留空 = 自动，填了就按城市查
  weather: { enabled: true, city: '', cacheMinutes: 10, timeoutMs: 4000 },
  // 语音广播：默认只念「紧急 + 重要」；普通/低不念，避免打扰
  speech: {
    enabled: true,
    levels: { urgent: true, important: true, normal: false, low: false },
    template: '{level}：{type}，{title}',
    customText: '',
    customEnabled: false,
    rate: 0,
    volume: 80,
    voice: 'Microsoft Huihui Desktop',
    repeat: 1
  },
  levels: {
    urgent: {
      enabled: true, mode: 'toast', sound: 'loop', soundSeconds: 12,
      scenario: 'urgent', duration: 'long', repeatTimes: 3, repeatIntervalSec: 20,
      flash: true, dialogTimeout: 0
    },
    important: {
      enabled: true, mode: 'toast', sound: 'once', soundSeconds: 3,
      scenario: 'reminder', duration: 'default', repeatTimes: 1, repeatIntervalSec: 20,
      flash: false, dialogTimeout: 20
    },
    normal: {
      enabled: true, mode: 'toast', sound: 'off', soundSeconds: 3,
      scenario: 'default', duration: 'default', repeatTimes: 1, repeatIntervalSec: 20,
      flash: false, dialogTimeout: 15
    },
    low: {
      enabled: true, mode: 'silent', sound: 'off', soundSeconds: 3,
      scenario: 'default', duration: 'default', repeatTimes: 1, repeatIntervalSec: 20,
      flash: false, dialogTimeout: 15
    }
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}
function isLevel(v) {
  return LEVELS.includes(v)
}
function pick(v, allowed, dflt) {
  return allowed.includes(v) ? v : dflt
}
function bool(v, dflt) {
  return typeof v === 'boolean' ? v : dflt
}
function clampInt(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 把任意输入整理成合法配置；base 用于保留未提交字段 */
export function normalizeConfig(input, base = DEFAULT_CONFIG) {
  const b = base && typeof base === 'object' ? base : DEFAULT_CONFIG
  const out = clone(b)

  out.version = 1
  out.defaultLevel = isLevel(input?.defaultLevel) ? input.defaultLevel : (isLevel(b.defaultLevel) ? b.defaultLevel : 'normal')
  out.watchExternal = bool(input?.watchExternal, bool(b.watchExternal, true))
  if (typeof input?.toastAppId === 'string' && input.toastAppId.trim()) out.toastAppId = normalizeAppId(input.toastAppId)
  out.toastAppId = normalizeAppId(out.toastAppId)

  out.kindLevel = out.kindLevel && typeof out.kindLevel === 'object' ? out.kindLevel : {}
  for (const k of Object.keys(KIND_LABEL)) {
    const want = input?.kindLevel?.[k]
    out.kindLevel[k] = isLevel(want) ? want : (isLevel(out.kindLevel[k]) ? out.kindLevel[k] : DEFAULT_CONFIG.kindLevel[k])
  }

  out.weather = out.weather && typeof out.weather === 'object' ? out.weather : clone(DEFAULT_CONFIG.weather)
  const wsrc = input?.weather && typeof input.weather === 'object' ? input.weather : {}
  out.weather.enabled = bool(wsrc.enabled, bool(out.weather.enabled, true))
  if (typeof wsrc.city === 'string') out.weather.city = wsrc.city.trim().slice(0, 40)
  else if (typeof out.weather.city !== 'string') out.weather.city = ''
  out.weather.city = String(out.weather.city || '').trim().slice(0, 40)
  out.weather.cacheMinutes = clampInt(wsrc.cacheMinutes ?? out.weather.cacheMinutes, 1, 120, 10)
  out.weather.timeoutMs = clampInt(wsrc.timeoutMs ?? out.weather.timeoutMs, 1000, 8000, 4000)

  // 语音：老配置里没有这一段，全部按默认值补齐（向后兼容）
  out.speech = out.speech && typeof out.speech === 'object' ? out.speech : clone(DEFAULT_CONFIG.speech)
  const ssrc = input?.speech && typeof input.speech === 'object' ? input.speech : {}
  const sd = DEFAULT_CONFIG.speech
  out.speech.enabled = bool(ssrc.enabled, bool(out.speech.enabled, sd.enabled))
  out.speech.levels = out.speech.levels && typeof out.speech.levels === 'object' ? out.speech.levels : {}
  for (const lv of LEVELS) {
    out.speech.levels[lv] = bool(ssrc.levels?.[lv], bool(out.speech.levels[lv], sd.levels[lv]))
  }
  if (typeof ssrc.template === 'string') out.speech.template = ssrc.template.slice(0, 200)
  if (typeof out.speech.template !== 'string' || !out.speech.template.trim()) out.speech.template = sd.template
  if (typeof ssrc.customText === 'string') out.speech.customText = ssrc.customText.slice(0, 300)
  else if (typeof out.speech.customText !== 'string') out.speech.customText = ''
  out.speech.customEnabled = bool(ssrc.customEnabled, bool(out.speech.customEnabled, sd.customEnabled))
  // 自定义文本开了但没有内容 → 视为关闭，避免念一串空话
  if (!String(out.speech.customText || '').trim()) out.speech.customEnabled = false
  out.speech.rate = clampInt(ssrc.rate ?? out.speech.rate, -10, 10, sd.rate)
  out.speech.volume = clampInt(ssrc.volume ?? out.speech.volume, 0, 100, sd.volume)
  if (typeof ssrc.voice === 'string') out.speech.voice = ssrc.voice.trim().slice(0, 80)
  if (typeof out.speech.voice !== 'string') out.speech.voice = sd.voice
  out.speech.repeat = clampInt(ssrc.repeat ?? out.speech.repeat, 1, 3, sd.repeat)

  out.levels = out.levels && typeof out.levels === 'object' ? out.levels : {}
  for (const lv of LEVELS) {
    const d = DEFAULT_CONFIG.levels[lv]
    const cur = out.levels[lv] && typeof out.levels[lv] === 'object' ? out.levels[lv] : d
    const src = input?.levels?.[lv] && typeof input.levels[lv] === 'object' ? input.levels[lv] : {}
    const merged = { ...cur }
    merged.enabled = bool(src.enabled, bool(cur.enabled, d.enabled))
    merged.mode = pick(src.mode, MODES, pick(cur.mode, MODES, d.mode))
    merged.sound = pick(src.sound, SOUND_MODES, pick(cur.sound, SOUND_MODES, d.sound))
    merged.scenario = pick(src.scenario, SCENARIOS, pick(cur.scenario, SCENARIOS, d.scenario))
    merged.duration = pick(src.duration, DURATIONS, pick(cur.duration, DURATIONS, d.duration))
    merged.soundSeconds = clampInt(src.soundSeconds ?? cur.soundSeconds, 0, 60, d.soundSeconds)
    merged.repeatTimes = clampInt(src.repeatTimes ?? cur.repeatTimes, 1, 10, d.repeatTimes)
    merged.repeatIntervalSec = clampInt(src.repeatIntervalSec ?? cur.repeatIntervalSec, 5, 120, d.repeatIntervalSec)
    merged.flash = bool(src.flash, bool(cur.flash, d.flash))
    merged.dialogTimeout = clampInt(src.dialogTimeout ?? cur.dialogTimeout, 0, 300, d.dialogTimeout)
    out.levels[lv] = merged
  }
  return out
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const DEFAULT_WAV = path.join(process.env.SystemRoot || 'C:\\Windows', 'Media', 'Alarm01.wav')

// ── 天气（全部使用免密钥接口；任何一步失败都静默降级为「不带天气的通知」）──
export const WEATHER_KINDS = ['sunny', 'cloudy', 'overcast', 'rain', 'snow', 'night']

// 本地静态插图：随插件一起打包，不联网下载
const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'weather')

// WMO weather code → [中文描述, 插图类型]
const WMO = {
  0: ['晴', 'sunny'], 1: ['晴间多云', 'sunny'], 2: ['多云', 'cloudy'], 3: ['阴', 'overcast'],
  45: ['雾', 'overcast'], 48: ['雾凇', 'overcast'],
  51: ['毛毛雨', 'rain'], 53: ['毛毛雨', 'rain'], 55: ['毛毛雨', 'rain'],
  56: ['冻毛毛雨', 'rain'], 57: ['冻毛毛雨', 'rain'],
  61: ['小雨', 'rain'], 63: ['中雨', 'rain'], 65: ['大雨', 'rain'],
  66: ['冻雨', 'rain'], 67: ['冻雨', 'rain'],
  71: ['小雪', 'snow'], 73: ['中雪', 'snow'], 75: ['大雪', 'snow'], 77: ['米雪', 'snow'],
  80: ['阵雨', 'rain'], 81: ['阵雨', 'rain'], 82: ['强阵雨', 'rain'],
  85: ['阵雪', 'snow'], 86: ['阵雪', 'snow'],
  95: ['雷阵雨', 'rain'], 96: ['雷阵雨伴冰雹', 'rain'], 99: ['雷阵雨伴冰雹', 'rain']
}

const _assetOk = new Map()
function assetFor(kind) {
  const file = path.join(ASSET_DIR, `${kind}.png`)
  if (!_assetOk.has(kind)) {
    let ok = false
    try { ok = fs.statSync(file).size > 0 } catch {}
    _assetOk.set(kind, ok)
  }
  return _assetOk.get(kind) ? file : ''
}

/** 极简 JSON 请求：自带超时、限制响应体积、失败返回 null（不抛异常） */
function httpJson(url, timeoutMs = 4000, redirects = 2) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    let req = null
    try {
      const u = new URL(url)
      const mod = u.protocol === 'http:' ? http : https
      req = mod.get(u, { headers: { accept: 'application/json', 'user-agent': 'dsh-box/1.1' } }, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
          res.resume()
          let next = ''
          try { next = new URL(res.headers.location, u).href } catch { return finish(null) }
          return httpJson(next, timeoutMs, redirects - 1).then(finish)
        }
        if (code !== 200) { res.resume(); return finish(null) }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
          if (data.length > 200000) { try { req.destroy() } catch {}; finish(null) }
        })
        res.on('end', () => { try { finish(JSON.parse(data)) } catch { finish(null) } })
      })
      req.on('error', () => finish(null))
      req.setTimeout(timeoutMs, () => { try { req.destroy() } catch {}; finish(null) })
    } catch {
      finish(null)
    }
  })
}

/** 给任意 Promise 加总超时；超时按 null 处理 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    t.unref?.()
    promise.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null) } })
  })
}

function sameLocalDay(ts) {
  const d = new Date(Number(ts) || 0)
  const now = new Date()
  if (d.toDateString() !== now.toDateString()) return false
  return Math.abs(now.getTime() - d.getTime()) < 24 * 3600 * 1000
}

function b64(s) {
  return Buffer.from(String(s ?? ''), 'utf8').toString('base64')
}

// ── Toast 按钮 ────────────────────────────────────────────────
// 三个状态按钮 + 一个「去回复」按钮，全部走自注册的 dshbox:// 协议：
//   dshbox://status?item=<id>&to=accepted|doing|done
//   dshbox://open?item=<id>#reply
// 协议处理器是 notify-action.vbs → notify-action.mjs（静默，不开窗口）。
const STATUS_ACTIONS = [
  { label: '受理', to: 'accepted' },
  { label: '处理中', to: 'doing' },
  { label: '已完成', to: 'done' }
]

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function buildActionsXml(itemId) {
  const id = String(itemId || '').trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return ''
  const rows = STATUS_ACTIONS.map((a) => ({ content: a.label, args: `dshbox://status?item=${id}&to=${a.to}` }))
  // 跳转按钮放在最后一组：Win11 若并排成两列，它就是右半格；单数行时才会独占整行
  rows.push({ content: '去回复', args: `dshbox://open?item=${id}#reply` })
  return '<actions>' + rows
    .map((r) => `<action content="${xmlEscape(r.content)}" activationType="protocol" arguments="${xmlEscape(r.args)}"/>`)
    .join('') + '</actions>'
}

/** 生成一段 PowerShell；文本一律走 Base64 传入，避免引号/中文转义问题 */
function buildPowerShell(lc, { title, body, appId, hero = '', weather = '', actionsXml = '' }) {
  const p = {
    title: b64(title),
    body: b64(body),
    appId: b64(appId || DEFAULT_APP_ID),
    wav: b64(DEFAULT_WAV),
    hero: b64(hero ? pathToFileURL(hero).href : ''),
    weather: b64(weather),
    actions: b64(actionsXml),
    mode: lc.mode,
    sound: lc.sound,
    scenario: lc.scenario,
    duration: lc.duration,
    soundSeconds: lc.soundSeconds,
    repeatTimes: lc.repeatTimes,
    repeatInterval: lc.repeatIntervalSec,
    flash: lc.flash ? '$true' : '$false',
    dialogTimeout: lc.dialogTimeout
  }
  return `
$ErrorActionPreference = 'Continue'
function FromB64([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
$Title = FromB64 '${p.title}'
$Body = FromB64 '${p.body}'
$AppId = FromB64 '${p.appId}'
$WavPath = FromB64 '${p.wav}'
$HeroUri = FromB64 '${p.hero}'
$WeatherLine = FromB64 '${p.weather}'
$ActionsXml = FromB64 '${p.actions}'
$Mode = '${p.mode}'
$SoundMode = '${p.sound}'
$Scenario = '${p.scenario}'
$Duration = '${p.duration}'
$SoundSeconds = ${p.soundSeconds}
$RepeatTimes = ${p.repeatTimes}
$RepeatInterval = ${p.repeatInterval}
$Flash = ${p.flash}
$DialogTimeout = ${p.dialogTimeout}
$shown = $false
$player = $null

function PlaySound {
  if ($SoundMode -eq 'off') { return }
  try {
    if (Test-Path $WavPath) { $script:player = New-Object System.Media.SoundPlayer $WavPath }
    else { $script:player = New-Object System.Media.SoundPlayer (Join-Path $env:SystemRoot 'Media\\Alarm01.wav') }
    if ($SoundMode -eq 'loop') { $script:player.PlayLooping() } else { $script:player.Play() }
  } catch {
    try { [System.Media.SystemSounds]::Exclamation.Play() } catch {}
  }
}
function StopSound {
  if ($script:player) { try { $script:player.Stop() } catch {} }
}
function ShowToast {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
  $esc = [System.Security.SecurityElement]
  $img = ''
  if ($HeroUri) { $img = '<image placement="hero" src="' + $esc::Escape($HeroUri) + '"/>' }
  $wx = ''
  if ($WeatherLine) { $wx = '<text placement="attribution">' + $esc::Escape($WeatherLine) + '</text>' }
  $act = $ActionsXml
  $xmlText = '<toast scenario="' + $Scenario + '" duration="' + $Duration + '"><visual><binding template="ToastGeneric">' + $img + '<text>' + $esc::Escape($Title) + '</text><text>' + $esc::Escape($Body) + '</text>' + $wx + '</binding></visual><audio silent="true"/>' + $act + '</toast>'
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $toast.Tag = 'dsh-box'
  $toast.Group = 'dsh-box'
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
  $notifier.Show($toast)
}
function ShowDialog {
  $ws = New-Object -ComObject WScript.Shell
  [void]$ws.Popup($Body, $DialogTimeout, $Title, 64)
}
function FlashTaskbar {
  try {
    if (-not ('Native.Win' -as [type])) {
      Add-Type -Namespace Native -Name Win -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
'@
    }
    $procs = @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and ($_.ProcessName -like '*DeepSeek*' -or $_.MainWindowTitle -like '*DeepSeek*') })
    if ($procs.Count -eq 0) { $procs = @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle } | Select-Object -First 1) }
    if ($procs.Count -gt 0) {
      $fi = New-Object Native.Win+FLASHWINFO
      $fi.cbSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf($fi)
      $fi.hwnd = $procs[0].MainWindowHandle
      $fi.dwFlags = 3
      $fi.uCount = 10
      $fi.dwTimeout = 500
      [void][Native.Win]::FlashWindowEx([ref]$fi)
    }
  } catch {}
}

if ($Mode -eq 'toast') {
  PlaySound
  for ($i = 0; $i -lt $RepeatTimes; $i++) {
    try { ShowToast; $shown = $true } catch {}
    if ($i -eq 0 -and $SoundMode -eq 'loop') { Start-Sleep -Seconds $SoundSeconds; StopSound }
    if ($i -lt ($RepeatTimes - 1)) { Start-Sleep -Seconds $RepeatInterval }
  }
  if (-not $shown) {
    try { ShowDialog; $shown = $true } catch {}
  }
}
elseif ($Mode -eq 'dialog') {
  PlaySound
  try { ShowDialog; $shown = $true } catch {}
  if ($SoundMode -eq 'loop') { Start-Sleep -Seconds $SoundSeconds; StopSound }
}
elseif ($Mode -eq 'sound') {
  PlaySound
  if ($SoundMode -eq 'loop') { Start-Sleep -Seconds $SoundSeconds; StopSound }
  $shown = $true
}
else {
  $shown = $true
}

if ($Flash) { FlashTaskbar }
if ($shown) { exit 0 } else { exit 2 }
`
}

function spawnPowerShell(script, { awaitMs = 0, killMs = 120000, onExit = null } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d) => { stdout += String(d) })
  child.stderr?.on('data', (d) => { stderr += String(d) })

  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    const killTimer = setTimeout(() => { try { child.kill() } catch {} }, killMs)
    killTimer.unref?.()

    child.on('close', (code) => {
      clearTimeout(killTimer)
      onExit?.(code, (stderr || '').slice(0, 400))
      finish({ ok: code === 0, code, stdout: stdout.slice(0, 400), stderr: stderr.slice(0, 400) })
    })
    child.on('error', (e) => {
      clearTimeout(killTimer)
      onExit?.(-1, e?.message || String(e))
      finish({ ok: false, code: -1, stderr: e?.message || String(e) })
    })
    if (awaitMs > 0) {
      const t = setTimeout(() => {
        try { child.kill() } catch {}
        finish({ ok: false, code: 'timeout', stderr: 'PowerShell 执行超时' })
      }, awaitMs)
      t.unref?.()
    } else {
      setTimeout(() => finish({ ok: true, spawned: true, pid: child.pid }), 0)
    }
  })
}

// ── 语音广播（SAPI5 / System.Speech）──────────────────────────────
// 只用 Windows 自带的 SAPI5 桌面语音（本机是 Microsoft Huihui Desktop，zh-CN 女声），
// 不去碰 OneCore / WinRT 那套。播报跑在独立的隐藏 PowerShell 进程里：
//   - 完全不阻塞通知与 HTTP 接口（fire() 只丢一个后台任务）；
//   - 新播报会先 kill 掉上一个进程 → 天然可打断；
//   - 队列上限 1：只保留「最新一条」，中间的旧播报直接丢弃，不会积压。
export const DEFAULT_VOICE = DEFAULT_CONFIG.speech.voice

/** 把模板里的 {level}/{type}/{title}/{source} 换成实际内容；空字段不留空逗号 */
export function renderSpeechText(template, vars = {}) {
  let s = String(template ?? '')
  for (const key of ['level', 'type', 'title', 'source']) {
    s = s.split(`{${key}}`).join(String(vars[key] ?? '').trim())
  }
  s = s.replace(/\{[A-Za-z_]+\}/g, '')          // 不认识的占位符直接去掉
  s = s.replace(/[，,、]\s*(?=[，,、])/g, '')     // 连续逗号只留一个
  s = s.replace(/(^|[：:，,、])\s*[，,、]/g, '$1') // 冒号后紧跟逗号之类的残留
  s = s.replace(/^[\s，,、。:：;；]+/, '')
  s = s.replace(/[\s，,、;；]+$/, '')
  s = s.replace(/\s{2,}/g, ' ')
  return s.trim()
}

/** 播报脚本：选中文语音 → 念 repeat 遍；没有中文语音就只响提示音（降级） */
function buildSpeechScript({ text, voice, rate, volume, repeat }) {
  const p = {
    text: b64(text),
    voice: b64(voice || DEFAULT_VOICE),
    rate: clampInt(rate, -10, 10, 0),
    volume: clampInt(volume, 0, 100, 80),
    repeat: clampInt(repeat, 1, 3, 1)
  }
  return `
$ErrorActionPreference = 'Continue'
function FromB64([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
$Text = FromB64 '${p.text}'
$VoiceWant = FromB64 '${p.voice}'
$Rate = ${p.rate}
$Volume = ${p.volume}
$Repeat = ${p.repeat}

function BeepFallback {
  # 没有中文语音 / SAPI 起不来 → 只响两下提示音，绝不弹窗、不报错
  try { [Console]::Beep(880, 160); Start-Sleep -Milliseconds 90; [Console]::Beep(1175, 160) } catch {}
  Write-Output 'SPEECH_DEGRADED'
}

try {
  Add-Type -AssemblyName System.Speech
  $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $all = @($sp.GetInstalledVoices() | Where-Object { $_.Enabled })
  $zh = @($all | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' })
  if ($zh.Count -eq 0) { try { $sp.Dispose() } catch {}; BeepFallback; exit 0 }

  $picked = $zh | Where-Object { $_.VoiceInfo.Name -eq $VoiceWant } | Select-Object -First 1
  if (-not $picked) { $picked = $zh[0] }
  try { $sp.SelectVoice($picked.VoiceInfo.Name) } catch {}
  $sp.Rate = $Rate
  $sp.Volume = $Volume
  $sp.SetOutputToDefaultAudioDevice()
  for ($i = 0; $i -lt $Repeat; $i++) { $sp.Speak($Text) }
  try { $sp.Dispose() } catch {}
  Write-Output ('SPEECH_OK ' + $picked.VoiceInfo.Name)
} catch {
  BeepFallback
}
`
}

/** 列出已安装语音（只读，用来判断有没有中文语音） */
function buildVoiceListScript() {
  return `
$ErrorActionPreference = 'Continue'
try {
  Add-Type -AssemblyName System.Speech
  $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $rows = @()
  foreach ($v in $sp.GetInstalledVoices()) {
    if ($v.Enabled) {
      $rows += [pscustomobject]@{ name = $v.VoiceInfo.Name; culture = $v.VoiceInfo.Culture.Name; gender = [string]$v.VoiceInfo.Gender }
    }
  }
  try { $sp.Dispose() } catch {}
  Write-Output ('VOICES_JSON:' + (ConvertTo-Json -InputObject @($rows) -Compress -Depth 4))
} catch {
  Write-Output 'VOICES_JSON:[]'
}
`
}

// ── Toast 身份（AppUserModelID）────────────────────────────────
// Windows 只给「在开始菜单有快捷方式且带 AppUserModelID」的应用显示 Toast。
// 所以首次运行要做两件事（幂等，重复执行无副作用）：
//   1) 在开始菜单建 DshBoxNotify.lnk，并写入 System.AppUserModel.ID 属性；
//   2) 在 HKCU\SOFTWARE\Classes\AppUserModelId\DshBox.Notification 写显示名等元数据。
// 任何一步失败都只记日志、返回 ok=false，调用方把 Toast 降级成弹窗。
export const IDENTITY_LINK = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DshBoxNotify.lnk'
)

// 私有协议：notify-action.vbs（wscript 静默跑）→ notify-action.mjs
export const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))
export const PROTOCOL_SCHEME = 'dshbox'
export const ACTION_VBS = path.join(PLUGIN_ROOT, 'notify-action.vbs')
export const ACTION_MJS = path.join(PLUGIN_ROOT, 'notify-action.mjs')

export function identityPresent() {
  try {
    const st = fs.statSync(IDENTITY_LINK)
    return st.size > 0
  } catch {
    return false
  }
}

function buildIdentityScript() {
  const lnk = IDENTITY_LINK.replace(/'/g, "''")
  return String.raw`
$ErrorActionPreference = 'Stop'
$Lnk = '` + lnk + String.raw`'
$Aumid = 'DshBox.Notification'
$Ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $Lnk)) {
  $dir = Split-Path -Parent $Lnk
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($Lnk)
  $s.TargetPath = $Ps
  $s.Arguments = '-NoProfile -WindowStyle Hidden'
  $s.WorkingDirectory = (Split-Path -Parent $Ps)
  $s.Description = 'DshBox notification host'
  $s.Save()
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LnkAumid
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public IntPtr p;
        public IntPtr p2;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        [PreserveSig] int Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHGetPropertyStoreFromParsingName(
        string path, IntPtr pbc, int flags, [In] ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    public static void Set(string lnkPath, string aumid)
    {
        Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IPropertyStore store;
        SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        key.pid = 5;
        PROPVARIANT pv = new PROPVARIANT();
        pv.vt = 31;
        pv.p = Marshal.StringToCoTaskMemUni(aumid);
        store.SetValue(ref key, ref pv);
        store.Commit();
        Marshal.FreeCoTaskMem(pv.p);
    }
}
'@

[LnkAumid]::Set($Lnk, $Aumid)

$Reg = 'HKCU:\SOFTWARE\Classes\AppUserModelId\' + $Aumid
if (-not (Test-Path $Reg)) { New-Item -Path $Reg -Force | Out-Null }
New-ItemProperty -Path $Reg -Name 'DisplayName' -Value '需求箱通知' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Reg -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $Reg -Name 'IconUri' -Value $Ps -PropertyType String -Force | Out-Null

# 私有协议 dshbox:// → wscript 静默运行 notify-action.mjs（不闪控制台）
$Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Node = '` + process.execPath.replace(/'/g, "''") + String.raw`'
$Vbs = '` + ACTION_VBS.replace(/'/g, "''") + String.raw`'
$Proto = 'HKCU:\Software\Classes\dshbox'
New-Item -Path $Proto -Force | Out-Null
Set-Item -Path $Proto -Value 'URL:DshBox Protocol'
New-ItemProperty -Path $Proto -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$CmdKey = $Proto + '\shell\open\command'
New-Item -Path $CmdKey -Force | Out-Null
Set-Item -Path $CmdKey -Value ('"' + $Wscript + '" "' + $Vbs + '" "' + $Node + '" "%1"')

Write-Output 'IDENTITY_OK'
`
}

/** 幂等注册 Toast 身份；返回 { ok, existed, error }，绝不抛异常 */
export async function ensureIdentity({ awaitMs = 20000 } = {}) {
  const existed = identityPresent()
  try {
    const r = await spawnPowerShell(buildIdentityScript(), { awaitMs, killMs: 30000 })
    const ok = !!r.ok && /IDENTITY_OK/.test(r.stdout || '') && identityPresent()
    return { ok, existed, created: ok && !existed, error: ok ? '' : (r.stderr || `exit ${r.code}`) }
  } catch (e) {
    return { ok: false, existed, created: false, error: e?.message || String(e) }
  }
}


export function createNotifyService({ stateDir, boxFile, readDoc, log = () => {} }) {
  const CONFIG_FILE = path.join(stateDir, 'notify-config.json')
  const SEEN_FILE = path.join(stateDir, 'notify-seen.json')
  const LOG_FILE = path.join(stateDir, 'notify.log')
  const LOC_FILE = path.join(stateDir, 'weather-locate.json')
  const TOKEN_FILE = path.join(stateDir, 'box-token')
  const DSH_PORT_FILE = path.join(stateDir, 'dsh-port.json')
  const BOX_PORT = Number(process.env.BOX_PORT) || 3200
  const BOX_DIR = path.dirname(stateDir)

  let cfg = loadConfig()
  let seen = loadSeen()
  const seenSet = new Set(seen.ids)
  let timer = null
  let stopped = false
  let locCache = null            // 自动定位结果（按天缓存，落盘）
  let weatherCache = null        // { ts, data } 天气短期缓存
  let weatherFailTs = 0          // 失败后 60 秒内不重复请求
  let identity = { checked: false, ok: false, error: '' }   // Toast 身份是否就绪
  let identityPending = null
  let openUrlCache = null        // 按钮跳转目标（10 分钟内复用）
  let speechProc = null          // 正在播报的 PowerShell 进程（新播报会 kill 它）
  let speechSeq = 0              // 播报序号：被替换掉的旧进程不写日志
  let voicePending = null
  let voiceState = { checked: false, ok: false, voices: [], chinese: [], error: '' }

  function fileLog(line) {
    const text = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}`
    try {
      const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null
      if (st && st.size > 512 * 1024) {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-200)
        fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf8')
      }
      fs.appendFileSync(LOG_FILE, text + '\n', 'utf8')
    } catch {}
    try { log(text) } catch {}
  }

  function loadConfig() {
    const raw = readJson(CONFIG_FILE)
    const out = normalizeConfig(raw || DEFAULT_CONFIG, DEFAULT_CONFIG)
    // 无配置文件、或老配置里还是已失效的旧 AppID、或还没有 speech 段 → 落盘成新值
    const dirty = !raw
      || (typeof raw.toastAppId === 'string' && raw.toastAppId !== out.toastAppId)
      || !raw.speech || typeof raw.speech !== 'object'
      || !raw.speech.levels || typeof raw.speech.levels !== 'object'
    if (dirty) {
      try { writeJson(CONFIG_FILE, out) } catch {}
    }
    return out
  }

  /** 首次运行注册 Toast 身份（幂等，只做一次；失败静默降级） */
  function ensureIdentityOnce() {
    if (identity.checked) return Promise.resolve(identity)
    if (!identityPending) {
      identityPending = (async () => {
        try {
          if (cfg.toastAppId !== DEFAULT_APP_ID) {
            // 用户自己指定了别的 AUMID：不代注册，直接按配置发
            identity = { checked: true, ok: true, error: '', custom: true }
            return identity
          }
          const r = await ensureIdentity({ awaitMs: 20000 })
          identity = { checked: true, ok: !!r.ok, error: r.error || '', created: !!r.created }
          fileLog(r.ok
            ? `通知身份就绪（${DEFAULT_APP_ID}${r.created ? '，已自动注册' : '，已存在'}）`
            : `⚠️ 通知身份注册失败，Toast 降级为弹窗：${r.error}`)
        } catch (e) {
          identity = { checked: true, ok: false, error: e?.message || String(e) }
          fileLog(`⚠️ 通知身份注册异常，Toast 降级为弹窗：${identity.error}`)
        }
        return identity
      })()
    }
    return identityPending
  }

  // ── 通知按钮的跳转目标 ─────────────────────────────────────────
  // 优先 DSH 页面（端口每次都变，动态探测）；拿不到就退回需求箱独立页面（带令牌）。
  function readBoxToken() {
    try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch { return '' }
  }

  /** 探测本地端口：返回 HTTP 状态码，连不上返回 0 */
  function probeStatus(port, pathname = '/', timeoutMs = 1200) {
    return new Promise((resolve) => {
      let done = false
      const fin = (v) => { if (!done) { done = true; resolve(v) } }
      try {
        const req = http.request(
          { host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs },
          (res) => { res.resume(); fin(res.statusCode || 599) }
        )
        req.on('error', () => fin(0))
        req.on('timeout', () => { try { req.destroy() } catch {}; fin(0) })
        req.end()
      } catch {
        fin(0)
      }
    })
  }

  /** 同机部署时 qq-bridge 的 config.json 里记着 DSH 的 baseUrl（只是线索之一） */
  function qqBridgePort() {
    try {
      const raw = readJson(path.join(path.dirname(BOX_DIR), 'qq-bridge', 'config.json'))
      const m = String(raw?.dsh?.baseUrl || '').match(/:(\d{2,5})/)
      return m ? Number(m[1]) : 0
    } catch {
      return 0
    }
  }

  /** DSH 端口：环境变量 → 当日缓存 → qq-bridge 配置；连通性用 HTTP 200~399 判定 */
  async function detectDshPort() {
    const cached = readJson(DSH_PORT_FILE)
    const cands = []
    const envRaw = String(process.env.DSH_PORT || process.env.DSH_BASE_URL || '')
    const envPort = Number((envRaw.match(/[=:]?(\d{2,5})/) || [])[1] || 0)
    if (envPort) cands.push(envPort)
    if (Number(cached?.port)) cands.push(Number(cached.port))
    const qp = qqBridgePort()
    if (qp) cands.push(qp)

    for (const port of [...new Set(cands)]) {
      if (port <= 0 || port === BOX_PORT) continue
      const code = await probeStatus(port, '/', 1200)
      // 200~399 视为可直接打开；401/403 说明需要登录态，改用独立页面更稳
      if (code >= 200 && code < 400) {
        try { writeJson(DSH_PORT_FILE, { version: 1, ts: Date.now(), port }) } catch {}
        return port
      }
    }
    return 0
  }

  async function resolveOpenUrl() {
    const now = Date.now()
    if (openUrlCache && now - openUrlCache.ts < 10 * 60 * 1000) return openUrlCache.url
    let url = ''
    try {
      const port = await detectDshPort()
      if (port) url = `http://127.0.0.1:${port}/`
    } catch {}
    if (!url) {
      const token = readBoxToken()
      url = `http://127.0.0.1:${BOX_PORT}/${token ? '?token=' + encodeURIComponent(token) : ''}`
    }
    openUrlCache = { url, ts: now }
    return url
  }

  function loadSeen() {
    const raw = readJson(SEEN_FILE)
    if (raw && Array.isArray(raw.ids)) {
      return { initialized: true, since: Number(raw.since) || Date.now(), ids: raw.ids.filter((x) => typeof x === 'string') }
    }
    return { initialized: false, since: Date.now(), ids: [] }
  }

  function saveSeen() {
    try { writeJson(SEEN_FILE, { version: 1, since: seen.since, ids: seen.ids }) } catch (e) {
      fileLog(`⚠️ 通知去重记录写入失败：${e?.message || e}`)
    }
  }

  function resolveLevel(kind, explicit) {
    if (isLevel(explicit)) return explicit
    const mapped = cfg.kindLevel?.[kind]
    if (isLevel(mapped)) return mapped
    if (isLevel(cfg.defaultLevel)) return cfg.defaultLevel
    return 'normal'
  }

  // ── 天气：定位 → 查天气，全程静默降级 ──────────────────────────
  // 手动城市的省份前缀（长的放前面，避免「内蒙古」被「内蒙」之类截断）
  const PROVINCE_PREFIX = [
    '内蒙古', '黑龙江', '香港', '澳门',
    '河北', '山西', '辽宁', '吉林', '江苏', '浙江', '安徽', '福建', '江西', '山东',
    '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃',
    '青海', '台湾', '广西', '西藏', '宁夏', '新疆'
  ] // 直辖市不在此列：只去掉末尾「市」，避免「北京朝阳」被拆成「朝阳」
  /** 「安徽合肥」/「合肥市」/「安徽省合肥市」→「合肥」；直辖市不拆前缀（「北京朝阳」不能变「朝阳」） */
  function normalizeCityName(raw) {
    let s = String(raw || '').replace(/[\s,，]/g, '')
    if (!s) return ''
    for (const p of PROVINCE_PREFIX) {
      if (!s.startsWith(p)) continue
      const rest = s.slice(p.length).replace(/^(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区)/, '')
      if (rest.length >= 2) { s = rest; break }
    }
    s = s.replace(/(特别行政区|自治州|地区|市|盟|县)$/, '')
    return s
  }

  /** 按城市名查经纬度；优先国内、名字完全对得上的结果 */
  async function geocodeCity(name, timeoutMs) {
    const j = await httpJson(
      `https://geocoding-api.open-meteo.com/v1/search?count=5&language=zh&format=json&name=${encodeURIComponent(name)}`,
      timeoutMs
    )
    const rows = Array.isArray(j?.results) ? j.results : []
    if (!rows.length) return null
    const cn = rows.filter((r) => String(r.country_code || '').toUpperCase() === 'CN')
    const pool = cn.length ? cn : rows
    const want = name.replace(/市$/, '')
    const scored = pool.map((r) => {
      const nm = String(r.name || '')
      let sc = 0
      if (nm === name) sc += 6
      else if (nm.replace(/市$/, '') === want) sc += 5
      else if (nm.includes(want)) sc += 2
      if (['PPLC', 'PPLA', 'PPLA2'].includes(String(r.feature_code || ''))) sc += 2
      return { r, sc }
    }).sort((a, b) => b.sc - a.sc)
    const hit = scored[0]?.r
    if (!hit || hit.latitude == null || hit.longitude == null) return null
    return hit
  }

  /** 反查中文城市名（只用于显示；失败就沿用 IP 库给的名字） */
  async function reverseCity(lat, lon, timeoutMs) {
    try {
      const j = await httpJson(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`,
        timeoutMs
      )
      const city = String(j?.city || j?.locality || '').trim()
      const province = String(j?.principalSubdivision || '').trim()
      if (city) return { city, region: province }
    } catch {}
    return null
  }

  function readLocCache() {
    if (locCache) return locCache
    const raw = readJson(LOC_FILE)
    // 老缓存（没有 provider 字段）一律作废：那是没做城市反查的旧结果
    if (raw && raw.provider && sameLocalDay(raw.ts) && Number.isFinite(Number(raw.lat)) && Number.isFinite(Number(raw.lon))) {
      locCache = {
        ts: Number(raw.ts), lat: Number(raw.lat), lon: Number(raw.lon),
        city: raw.city || '', region: raw.region || '', country: raw.country || '',
        provider: raw.provider || ''
      }
    }
    return locCache
  }

  function saveLocCache(loc) {
    locCache = loc
    try { writeJson(LOC_FILE, { version: 1, ...loc }) } catch {}
  }

  /** 定位：填了城市就按城市查（手动优先），留空才按 IP 自动定位（结果按天落盘） */
  async function locate(cfgw) {
    const rawCity = String(cfgw.city || '').trim()
    if (rawCity) {
      // 手动优先：支持「合肥」「合肥市」「安徽合肥」「安徽省合肥市」
      const name = normalizeCityName(rawCity)
      let hit = null
      try { hit = await geocodeCity(name, cfgw.timeoutMs) } catch {}
      if (!hit) {
        // 退一步用原始输入再试一次（万一「安徽合肥」本身就能被地名库识别）
        try { hit = await geocodeCity(rawCity, cfgw.timeoutMs) } catch {}
      }
      if (hit) {
        return {
          ts: Date.now(),
          lat: Number(hit.latitude),
          lon: Number(hit.longitude),
          // 显示名用用户填的规范名（「合肥」而不是地名库的「合肥市」）
          city: name || String(hit.name || rawCity),
          region: hit.admin1 || '',
          country: hit.country || '中国',
          source: 'manual',
          provider: 'open-meteo-geocoding'
        }
      }
      fileLog(`天气：手动城市「${rawCity}」没查到坐标，本次不带天气（不影响弹窗）`)
      return null
    }

    const cached = readLocCache()
    if (cached) return { ...cached, source: 'ip', provider: cached.provider || 'ip-api.com' }

    const providers = [
      { name: 'ip-api.com', fn: async () => {
        const j = await httpJson('http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,lat,lon', cfgw.timeoutMs)
        if (j?.status === 'success' && j.lat != null && j.lon != null) {
          return { lat: Number(j.lat), lon: Number(j.lon), city: j.city || '', region: j.regionName || '', country: j.country || '' }
        }
      } },
      { name: 'ipapi.co', fn: async () => {
        const j = await httpJson('https://ipapi.co/json/', cfgw.timeoutMs)
        if (j?.latitude != null && j?.longitude != null) {
          return { lat: Number(j.latitude), lon: Number(j.longitude), city: j.city || '', region: j.region || '', country: j.country_name || '' }
        }
      } },
      { name: 'ipinfo.io', fn: async () => {
        const j = await httpJson('https://ipinfo.io/json', cfgw.timeoutMs)
        const loc = String(j?.loc || '').split(',')
        if (loc.length === 2 && Number.isFinite(Number(loc[0])) && Number.isFinite(Number(loc[1]))) {
          return { lat: Number(loc[0]), lon: Number(loc[1]), city: j.city || '', region: j.region || '', country: j.country || '' }
        }
      } }
    ]

    for (const p of providers) {
      try {
        const r = await p.fn()
        if (!r) continue
        // IP 库给的 city 常是街道/园区（如「金融街」），反查一次换成正经的地级市名
        const rev = await reverseCity(r.lat, r.lon, cfgw.timeoutMs)
        return {
          ts: Date.now(),
          ...r,
          ipCity: r.city,
          city: rev?.city || r.city,
          region: rev?.region || r.region,
          source: 'ip',
          provider: p.name
        }
      } catch {}
    }
    return null
  }

  async function getWeather(cfgw) {
    const now = Date.now()
    if (weatherCache && now - weatherCache.ts < cfgw.cacheMinutes * 60000) return weatherCache.data
    if (weatherFailTs && now - weatherFailTs < 60000) return null

    const loc = await locate(cfgw)
    if (!loc) {
      weatherFailTs = now
      fileLog('天气定位失败：本次通知不带天气（不影响弹窗）')
      return null
    }
    if ((loc.lat === 0 && loc.lon === 0)) {
      weatherFailTs = now
      return null
    }
    if (!String(cfgw.city || '').trim()) saveLocCache(loc)

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day&timezone=auto&forecast_days=1`
    const j = await httpJson(url, cfgw.timeoutMs)
    const cur = j?.current
    const temp = Number(cur?.temperature_2m)
    if (!cur || !Number.isFinite(temp)) {
      weatherFailTs = now
      fileLog('天气查询失败：本次通知不带天气（不影响弹窗）')
      return null
    }

    const code = Number(cur.weather_code)
    const hit = WMO[code] || ['天气', 'cloudy']
    const label = hit[0]
    const base = hit[1]
    const kind = (Number(cur.is_day) === 0 && (base === 'sunny' || base === 'cloudy' || base === 'overcast')) ? 'night' : base
    const data = {
      city: loc.city || '',
      temp: Math.round(temp),
      label,
      kind,
      text: `${loc.city || '本地'} ${Math.round(temp)}°C ${label}`
    }
    weatherCache = { ts: now, data }
    fileLog(`天气：${data.text}（插图 ${kind}）`)
    return data
  }

  /** 带总超时的天气读取；任何异常都返回 null，绝不阻塞通知 */
  async function weatherSafe() {
    const w = cfg.weather
    if (!w || w.enabled === false) return null
    try {
      return await withTimeout(getWeather(w), Math.max(6000, w.timeoutMs * 2))
    } catch {
      return null
    }
  }

  /** 诊断用：强制查一次天气（忽略失败冷却，但走正常缓存） */
  async function weatherProbe() {
    const data = await getWeather(cfg.weather || DEFAULT_CONFIG.weather)
    const loc = locCache || readLocCache()
    return {
      weather: data,
      asset: data?.kind ? assetFor(data.kind) : '',
      cityOverride: cfg.weather?.city || '',
      locate: loc ? {
        city: loc.city, region: loc.region, country: loc.country, lat: loc.lat, lon: loc.lon,
        source: loc.source || 'cache', provider: loc.provider || ''
      } : null
    }
  }

  /** 诊断用：只解析城市名 → 经纬度，不查天气、不发通知 */
  async function geoProbe(rawCity, timeoutMs) {
    const raw = String(rawCity || cfg.weather?.city || '').trim()
    const name = normalizeCityName(raw)
    const loc = await locate({ ...(cfg.weather || DEFAULT_CONFIG.weather), city: raw, timeoutMs: timeoutMs || 8000 })
    return { input: raw, normalized: name, locate: loc }
  }

  // ── 语音广播：异步、可打断、只保留最新一条 ──────────────────────
  /** 探测已安装语音（缓存结果；失败也缓存，避免每次设置页都拉一次进程） */
  function probeVoices(force = false) {
    if (!force && voiceState.checked) return Promise.resolve(voiceState)
    if (voicePending) return voicePending
    voicePending = (async () => {
      const r = await spawnPowerShell(buildVoiceListScript(), { awaitMs: 15000, killMs: 20000 })
      let rows = []
      const m = String(r.stdout || '').match(/VOICES_JSON:(.*)/)
      if (m) {
        try {
          const parsed = JSON.parse(m[1].trim())
          rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
        } catch { rows = [] }
      }
      const voices = rows
        .filter((v) => v && typeof v.name === 'string')
        .map((v) => ({ name: v.name, culture: String(v.culture || ''), gender: String(v.gender || '') }))
      const chinese = voices.filter((v) => /^zh/i.test(v.culture) || /Huihui|Kangkang|Yaoyao/i.test(v.name))
      voiceState = { checked: true, ok: chinese.length > 0, voices, chinese, error: chinese.length ? '' : '未检测到中文语音' }
      fileLog(chinese.length
        ? `语音：检测到中文语音 ${chinese.map((v) => v.name).join('、')}`
        : '🔇 未检测到中文语音：语音播报将降级为只响提示音')
      voicePending = null
      return voiceState
    })().catch((e) => {
      voiceState = { checked: true, ok: false, voices: [], chinese: [], error: e?.message || String(e) }
      voicePending = null
      return voiceState
    })
    return voicePending
  }

  /** 打断上一条播报（队列上限 1：不留积压） */
  function stopSpeech() {
    if (!speechProc) return
    try { speechProc.kill() } catch {}
    speechProc = null
  }

  /** 播报一段文本：立即返回，不阻塞调用方 */
  function speak(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (!t) return { ok: false, error: '播报文本为空' }
    const s = cfg.speech || DEFAULT_CONFIG.speech
    stopSpeech()
    const script = buildSpeechScript({
      text: t.slice(0, 300),
      voice: s.voice || DEFAULT_VOICE,
      rate: s.rate,
      volume: s.volume,
      repeat: s.repeat
    })
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    let child = null
    try {
      child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch (e) {
      fileLog(`⚠️ 语音播报启动失败（已静默忽略）：${e?.message || e}`)
      return { ok: false, error: e?.message || String(e) }
    }
    speechProc = child
    const seq = ++speechSeq
    let out = ''
    const killTimer = setTimeout(() => { try { child.kill() } catch {} }, 60000)
    killTimer.unref?.()
    child.stdout?.on('data', (d) => { out += String(d) })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (speechProc === child) speechProc = null
      if (seq !== speechSeq) return                 // 已被新播报打断，不重复记日志
      if (/SPEECH_DEGRADED/.test(out)) {
        // 没有中文语音 / SAPI 异常：只响提示音，不弹窗、不报错
        voiceState = { ...voiceState, checked: true, ok: false, error: voiceState.error || '未检测到中文语音' }
        fileLog('🔇 无中文语音，本次只响提示音（播报降级）')
      } else if (/SPEECH_OK/.test(out)) {
        // 正常播报不写正文，避免日志刷屏
      } else if (code !== 0) {
        fileLog(`⚠️ 语音播报失败（code=${code}），已静默忽略`)
      }
    })
    child.on('error', (e) => {
      clearTimeout(killTimer)
      if (speechProc === child) speechProc = null
      if (seq === speechSeq) fileLog(`⚠️ 语音播报异常（已静默忽略）：${e?.message || e}`)
    })
    return { ok: true, queued: true, text: t.slice(0, 300) }
  }

  /** 按模板/自定义文本拼出这一条要念的话 */
  function speechTextFor(item, level) {
    const s = cfg.speech || DEFAULT_CONFIG.speech
    const custom = String(s.customText || '').trim()
    if (s.customEnabled && custom) return custom
    return renderSpeechText(s.template, {
      level: LEVEL_META[level]?.label || level,
      type: KIND_SPEECH[item?.kind] || KIND_LABEL[item?.kind] || '需求',
      title: String(item?.title || '').slice(0, 80),
      source: String(item?.source || '')
    })
  }

  /** 只在「总开关开 + 该等级勾选播报」时出声；与通知方式互不影响 */
  function maybeSpeak(item, level) {
    const s = cfg.speech
    if (!s || s.enabled === false) return null
    if (s.levels?.[level] !== true) return null
    const text = speechTextFor(item, level)
    if (!text) return null
    return speak(text)
  }

  /** 试听：不建需求、不弹通知、只出声；忽略总开关与分级开关 */
  function previewSpeech(text) {
    const s = cfg.speech || DEFAULT_CONFIG.speech
    const t = String(text ?? '').trim() || speechTextFor(
      { kind: 'l2', title: '服务器告警', source: 'admin' },
      'urgent'
    )
    const r = speak(t)
    return {
      ok: !!r.ok,
      text: r.ok ? r.text : t,
      voice: s.voice || DEFAULT_VOICE,
      degraded: voiceState.checked && !voiceState.ok,
      error: r.error || (voiceState.checked && !voiceState.ok ? '未检测到中文语音，只会响提示音' : '')
    }
  }

  function voiceInfo() {
    return { ...clone(voiceState), preferred: cfg.speech?.voice || DEFAULT_VOICE }
  }

  function payloadFor(item, level) {
    const meta = LEVEL_META[level] || LEVEL_META.normal
    const kind = KIND_LABEL[item?.kind] || item?.kind || '需求箱'
    const title = `${meta.icon} ${meta.label} · ${item?.title || '(无标题)'}`
    const detail = String(item?.detail || '').trim()
    const body = [`${kind} · 来自 ${item?.source || '未知'}`]
    if (detail) body.push(detail.slice(0, 220))
    body.push('打开需求箱查看与处理（DSH → 设置 → 需求箱）')
    return { title: title.slice(0, 120), body: body.join('\n'), itemId: String(item?.id || '') }
  }

  /** 真正发送：先确认 Toast 身份，再取天气（失败则不带），最后拉起 PowerShell */
  async function deliver(level, lc, payload, reason, opts = {}) {
    let effLc = lc
    if (lc.mode === 'toast') {
      const id = await ensureIdentityOnce()
      if (!id.ok) {
        // 身份建不起来 → 静默降级成弹窗，保证用户仍能看到提醒
        effLc = { ...lc, mode: 'dialog' }
        fileLog(`⚠️ Toast 身份不可用，本次改用弹窗（${LEVEL_META[level]?.label || level}）`)
      }
    }
    const wx = await weatherSafe()
    const hero = wx?.kind ? assetFor(wx.kind) : ''
    const weatherLine = wx?.text ? `📍 ${wx.text}` : ''
    const body = (wx?.text && effLc.mode !== 'toast') ? `${payload.body}\n${wx.text}` : payload.body
    const actionsXml = effLc.mode === 'toast' ? buildActionsXml(payload.itemId) : ''
    const label = LEVEL_META[level]?.label || level
    const script = buildPowerShell(effLc, { ...payload, body, appId: cfg.toastAppId, hero, weather: weatherLine, actionsXml })
    const killMs = opts.killMs || (15000 + effLc.soundSeconds * 1000 + (effLc.repeatTimes - 1) * effLc.repeatIntervalSec * 1000 + 20000)
    fileLog(`发送 ${label}通知（${effLc.mode}${effLc.sound !== 'off' ? '+' + effLc.sound : ''}${wx ? '，带天气' : ''}，${reason}）：${payload.title}`)
    const r = await spawnPowerShell(script, {
      awaitMs: opts.awaitMs || 0,
      killMs,
      onExit: opts.awaitMs ? null : (code, err) => {
        if (code === 0) fileLog(`通知已送出（${label}）`)
        else fileLog(`⚠️ 通知失败（${label}）code=${code} ${err || ''}`)
      }
    })
    return {
      ok: !!r.ok, level, mode: effLc.mode, weather: wx?.text || '', hero,
      code: r.code, error: r.ok ? '' : (r.stderr || `exit ${r.code}`)
    }
  }

  function fire(item, reason = 'watch') {
    const level = resolveLevel(item?.kind, item?.level)
    const lc = cfg.levels[level]
    const label = LEVEL_META[level]?.label || level
    if (!lc || lc.enabled === false) {
      fileLog(`跳过（${label}已关闭）${item?.title || ''}`)
      return { ok: true, skipped: 'disabled', level }
    }
    // 语音：独立于通知方式（即使该等级设成静默，只要勾了播报也会念）；异步、不阻塞
    const sp = maybeSpeak(item, level)
    if (lc.mode === 'silent') {
      fileLog(`静默记录（${label}）：${item?.title || ''}`)
      return { ok: true, skipped: 'silent', level, spoke: !!sp?.ok }
    }

    const payload = payloadFor(item, level)
    // 不阻塞调用方：天气查询与 PowerShell 都在后台完成；天气失败只是少一行天气
    deliver(level, lc, payload, reason).catch((e) => fileLog(`⚠️ 通知发送异常：${e?.message || e}`))
    return { ok: true, queued: true, level, mode: lc.mode, spoke: !!sp?.ok }
  }

  async function test(level, text) {
    const lv = isLevel(level) ? level : cfg.defaultLevel
    const lc = cfg.levels[lv]
    const label = LEVEL_META[lv]?.label || lv
    if (!lc || lc.enabled === false) {
      fileLog(`测试跳过：${label} 等级已关闭`)
      return { ok: false, skipped: 'disabled', level: lv, error: '该等级已关闭，不会触发通知' }
    }
    if (lc.mode === 'silent') {
      fileLog(`测试：${label} 为静默等级（只在列表留记录）`)
      return { ok: true, skipped: 'silent', level: lv, error: '该等级当前为静默，不会弹窗或出声' }
    }
    const payload = text
      ? { title: `需求箱通知测试 · ${label}`, body: String(text).slice(0, 300) }
      : { title: `需求箱通知测试 · ${label}`, body: `这是一条测试通知。\n当前方式：${lc.mode}，声音：${lc.sound}。\n用于确认「${label}」等级的实际表现。` }
    fileLog(`发送测试通知（${label}）`)
    // 9 秒内返回：插件宿主侧转发超时是 12 秒，避免测试请求被代理层判超时
    const r = await deliver(lv, { ...lc, repeatTimes: 1, soundSeconds: Math.min(lc.soundSeconds, 3), flash: lc.flash }, payload, 'test', { awaitMs: 9000 })
    fileLog(r.ok ? `测试通知成功（${label}）${r.weather ? '，天气 ' + r.weather : ''}` : `⚠️ 测试通知失败（${label}）：${r.error || r.code}`)
    return { ok: !!r.ok, level: lv, mode: lc.mode, weather: r.weather, code: r.code, error: r.error }
  }

  function getConfig() {
    return clone(cfg)
  }

  function setConfig(patch) {
    const prevWeather = cfg.weather || {}
    const next = normalizeConfig(patch?.config && typeof patch.config === 'object' ? patch.config : patch, cfg)
    cfg = next
    try { writeJson(CONFIG_FILE, cfg) } catch (e) {
      fileLog(`⚠️ 通知配置写入失败：${e?.message || e}`)
      return { ok: false, error: `配置写入失败：${e?.message || e}`, config: clone(cfg) }
    }
    // 天气相关改了就立刻作废缓存，不用等 10 分钟，也不用重启服务
    const nw = cfg.weather || {}
    if (nw.city !== prevWeather.city || nw.enabled !== prevWeather.enabled) {
      weatherCache = null
      weatherFailTs = 0
      locCache = null
    }
    fileLog('通知配置已更新（立即生效）')
    return { ok: true, config: clone(cfg) }
  }

  /** 标记已处理（创建时直接通知过的条目，避免 watcher 再弹一次） */
  function markSeen(ids) {
    let changed = false
    for (const id of [].concat(ids || [])) {
      if (typeof id !== 'string' || !id || seenSet.has(id)) continue
      seenSet.add(id)
      seen.ids.push(id)
      changed = true
    }
    if (changed) saveSeen()
  }

  function recentLog(lines = 30) {
    try {
      if (!fs.existsSync(LOG_FILE)) return ''
      const arr = fs.readFileSync(LOG_FILE, 'utf8').split('\n')
      return arr.slice(-Math.max(1, Math.min(200, lines))).join('\n').trim()
    } catch {
      return ''
    }
  }

  function tick() {
    if (stopped) return
    try {
      const doc = readDoc()
      const items = Array.isArray(doc?.items) ? doc.items : []

      if (!seen.initialized) {
        for (const it of items) { seenSet.add(it.id); seen.ids.push(it.id) }
        seen.initialized = true
        seen.since = Date.now()
        saveSeen()
        fileLog(`首次启动：已有 ${items.length} 条留言作为基线，不补发通知`)
      } else if (cfg.watchExternal !== false) {
        const fresh = items.filter((i) => i && typeof i.id === 'string' && !seenSet.has(i.id))
        if (fresh.length) {
          for (const it of fresh) { seenSet.add(it.id); seen.ids.push(it.id) }
          saveSeen()
          for (const it of fresh) {
            if (Number(it.createdAt || 0) >= seen.since - 10000) fire(it, 'watch')
            else fileLog(`跳过历史条目（早于本次监听起点）：${it.title || it.id}`)
          }
        }
      }
    } catch (e) {
      fileLog(`⚠️ 通知轮询异常：${e?.message || e}`)
    }
    const ms = clampInt(cfg.pollMs ?? 2000, 500, 30000, 2000)
    timer = setTimeout(tick, ms)
    timer.unref?.()
  }

  function start() {
    stopped = false
    fs.mkdirSync(stateDir, { recursive: true })
    fileLog('分级通知服务已启动')
    // 后台把 Toast 身份建好（不阻塞启动；失败只降级成弹窗）
    ensureIdentityOnce().catch(() => {})
    // 后台探测语音（设置页要显示「未检测到中文语音」）
    probeVoices().catch(() => {})
    tick()
  }

  function stop() {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
    stopSpeech()
  }

  return {
    start, stop, getConfig, setConfig, test, fire, resolveLevel, markSeen, recentLog, weatherProbe,
    ensureIdentityOnce, resolveOpenUrl, speak, previewSpeech, probeVoices, voiceInfo, geoProbe,
    files: { config: CONFIG_FILE, seen: SEEN_FILE, log: LOG_FILE, weatherLoc: LOC_FILE, identityLink: IDENTITY_LINK }
  }
}

// ── 命令行自测（不影响正在运行的服务）──────────────────────────────
// 用法： node notify.mjs test urgent
//       node notify.mjs weather
const SELF = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  const action = process.argv[2]
  const svc = createNotifyService({
    stateDir: path.join(path.dirname(SELF), 'state'),
    readDoc: () => ({ items: [] }),
    log: (m) => console.log(m)
  })
  if (action === 'test') {
    const level = process.argv[3] || 'normal'
    svc.test(level).then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.ok ? 0 : 1)
    })
  } else if (action === 'weather') {
    svc.weatherProbe().then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(0)
    })
  } else if (action === 'geo') {
    // 排查用：只解析城市名 → 经纬度，不查天气、不发通知
    svc.geoProbe(process.argv.slice(3).join(' ')).then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(0)
    })
  } else if (action === 'identity') {
    // 排查用：确认/补齐 Toast 身份（开始菜单快捷方式 + AppUserModelID 注册）
    svc.ensureIdentityOnce().then((r) => {
      console.log(JSON.stringify({ ...r, link: IDENTITY_LINK }, null, 2))
      process.exit(r.ok ? 0 : 1)
    })
  } else if (action === 'url') {
    // 排查用：只解析通知按钮会跳到哪个地址，不发通知
    svc.resolveOpenUrl().then((url) => {
      console.log(JSON.stringify({ url }, null, 2))
      process.exit(0)
    })
  } else if (action === 'voices') {
    // 排查用：列出已安装语音，判断有没有中文语音（只读，不出声）
    svc.probeVoices(true).then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.ok ? 0 : 1)
    })
  } else if (action === 'say') {
    // 试听：只出声，不建需求、不弹通知
    const r = svc.previewSpeech(process.argv.slice(3).join(' '))
    console.log(JSON.stringify(r, null, 2))
    setTimeout(() => process.exit(r.ok ? 0 : 1), 6000)
  } else if (action === 'cmd') {
    // 排查用：打印插件真正用来发通知的命令行（含 -EncodedCommand 与解码后的脚本），不发通知
    // 可选第 3 个参数是条目 id，带上就能预览三个状态按钮 + 去回复按钮的 XML
    const lv = process.argv[3] || 'normal'
    const itemId = process.argv[4] || ''
    const c = svc.getConfig()
    const script = buildPowerShell(c.levels[lv] || c.levels.normal, {
      title: '需求箱通知（命令行预览）',
      body: '这段只用于展示真实命令行，不会弹通知。',
      appId: c.toastAppId,
      hero: '',
      weather: '',
      actionsXml: buildActionsXml(itemId)
    })
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    console.log(JSON.stringify({
      exe: PS_EXE,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      appId: c.toastAppId,
      actionsXml: buildActionsXml(itemId),
      script
    }, null, 2))
    process.exit(0)
  }
}
