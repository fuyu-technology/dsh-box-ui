# dsh-box-ui

DeepSeek Harness 插件：把留言箱搬进 DSH 设置页。装上以后左侧多一个 **需求箱** 页签——查看条目、改回执、回复、删除、新建，都在设置页里直接做。

> 面板是「宿主侧代理 + 客户端面板」两层：令牌由宿主注入，**浏览器端永远看不到令牌**。

## 功能

- 列出留言条目（标题、来源、等级、状态）
- 改回执
- 回复
- 删除
- 新建
- **一键清空**：可只删「已处理 / 不处理」这些已结束的，或连未处理的一起全清

数据存在 `message-box.json`，与 QQ 桥接共用——桥接那边写入的留言，这里直接就能看到。

清空前 box-server 会自动把当前数据备份到 `state/box-backup-<时间>.json`（保留最近 20 份），删错了还能找回。

## 通知分级（紧急 / 重要 / 普通 / 低）

新需求到达时，box-server 会按等级调用 Windows 系统通知。等级可以在「新建一条」时手动指定；不指定时按留言类型映射，再兜底到默认等级（出厂默认：sos→紧急、l1→重要、l2→普通、l3→低，默认等级=普通）。

| 等级 | 出厂默认表现 |
|---|---|
| 🚨 紧急 | 高优先级 Toast（`scenario=urgent`、`duration=long`），每 20 秒重弹一次共 3 次；循环提示音约 12 秒；DSH 窗口任务栏闪烁 10 次 |
| ⚠️ 重要 | 普通 Toast 弹窗 + 响一声（`C:\Windows\Media\Alarm01.wav`） |
| 📝 普通 | 只弹 Toast，不出声 |
| · 低 | 静默：不弹窗不出声，只在需求箱列表留记录 |

### 天气（Toast 里的实时温度 + 配图）

走「系统通知（Toast）」时，通知会自动带上**当时的实时天气**：温度 + 状况（例如 `📍 金融街 1°C 晴`），并把一张**按天气生成的本地静态插图**作为 Toast 大图。插图分 6 套：晴 / 多云 / 阴 / 雨 / 雪 / 夜间，随插件打包在 `assets/weather/`，不联网下载。

- **定位**：默认按 IP 自动定位（`ip-api.com` → `ipapi.co` → `ipinfo.io` 依次兜底），全部免 API key；定位结果按天缓存到 `state/weather-locate.json`。
- **城市覆盖（可选）**：配置里的 `weather.city` 留空 = 自动定位；填了城市（如 `上海`）就用 Open-Meteo 地理编码查该城市。**普通用户什么都不用填**。
- **天气数据**：Open-Meteo 免费接口（经纬度 + `current=temperature_2m,weather_code,is_day`），约 10 分钟缓存，避免每条通知都发请求。
- **超时与降级**：每个请求 3–5 秒超时（默认 4 秒，可配 `timeoutMs`）；断网、加速器干扰、接口挂掉时**通知照常弹出，只是不带天气**，不会弹错误框、也不会阻塞需求箱服务。
- **动画**：Toast 的滑入/滑出动画完全由 Windows 系统控制，插件不做任何自定义动画，也不模拟排队动画。
- **静态插图**：原生 Toast 不支持动图，所以配图一律用本地静态 PNG。

### 语音广播（把新需求念出来）

新需求到达时，除了弹通知，还可以让 Windows **用中文语音念一句**（例如「紧急：新需求，服务器告警」）。

- **只用 SAPI5 桌面语音**：`System.Speech.Synthesis.SpeechSynthesizer`，本机可用的是 `Microsoft Huihui Desktop`（zh-CN 女声）。**不碰** OneCore / WinRT 语音（`Kangkang` / `Yaoyao` 那套 `System.Speech` 读不到，也不需要）。
- **默认只念紧急 + 重要**：总开关默认开，`speech.levels` 里 `urgent`、`important` 为 `true`，`normal`、`low` 为 `false`。
- **播报内容**：默认模板 `{level}：{type}，{title}`；可编辑。占位符：`{level}` 等级（紧急/重要/普通/低）、`{type}` 类型（现场求助/问题反馈/新需求/牢骚）、`{title}` 标题、`{source}` 来源；空字段会连同多余的逗号一起去掉。
- **自定义文本优先**：勾「自定义文本优先」并填了内容时，忽略模板，一律念这段固定文本（不填空时该开关自动视为关闭）。
- **可打断、队列上限 1**：每条播报都是一个隐藏的独立 PowerShell 进程；新播报会先 `kill` 掉正在念的那条，只保留最新一条，不会排队积压。
- **绝不阻塞**：`fire()` 只是启动进程就返回，弹通知与 HTTP 接口都不等语音播完。
- **降级**：没有中文语音 / SAPI 起不来 / 播报失败时，**静默降级为只响两下提示音**（`Beep`），不弹窗、不报错；设置页会标注「未检测到中文语音」。
- **试听**：设置页的「试听」**只出声**——不建需求、不弹通知，且会先保存当前设置，念的就是界面上当前的内容。

`speech` 是可选增量配置，旧配置读进来会自动补默认值：

```json
"speech": {
  "enabled": true,
  "levels": { "urgent": true, "important": true, "normal": false, "low": false },
  "template": "{level}：{type}，{title}",
  "customText": "",
  "customEnabled": false,
  "rate": 0,
  "volume": 80,
  "voice": "Microsoft Huihui Desktop",
  "repeat": 1
}
```

`rate` 范围 -10~10（0 正常），`volume` 0~100，`repeat` 1~3（同一句念几遍）。

### Toast 身份（AppUserModelID）

Windows 只给**有合法身份**的应用显示 Toast：开始菜单里得有它的快捷方式，并且快捷方式上写了 `System.AppUserModel.ID`，注册表里还得有同名条目。否则系统会**静默丢弃**通知——日志显示「已送出」，屏幕上什么都没有。

插件用的是自己的身份 **`DshBox.Notification`**，由代码在首次运行时**自动注册**（幂等，重复执行无副作用）：

1. 在 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\DshBoxNotify.lnk` 建快捷方式（目标 = `powershell.exe`）；
2. 用 `IPropertyStore` 给这个 `.lnk` 写入 `System.AppUserModel.ID = DshBox.Notification`；
3. 写注册表 `HKCU\SOFTWARE\Classes\AppUserModelId\DshBox.Notification`：`DisplayName=需求箱通知`、`ShowInSettings=1`、`IconUri`。

所以**新机器装完即用，零手动配置**：第一次触发通知（或服务启动）时自动完成，注册失败则只记一行日志并**自动降级成弹窗**，用户照样能看到提醒。

排查要点：

- 通知中心里的**署名**应该是「需求箱通知」，不是「Windows PowerShell」，也不是「计算器」。
- 手动确认/补齐身份：`node "D:\大肥鱼\需求箱\notify.mjs" identity`
- 手动核对快捷方式：`(Get-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DshBoxNotify.lnk").Length`
- 手动核对注册表：`Get-ItemProperty 'HKCU:\SOFTWARE\Classes\AppUserModelId\DshBox.Notification'`
- 旧配置里的 `toastAppId` 如果还是 `{1AC14E77…}\WindowsPowerShell\v1.0\powershell.exe`，读入时会**自动归一化**成 `DshBox.Notification` 并写回文件（PowerShell 不在 `shell:AppsFolder` 里，用它发必然被丢弃）。

### 通知按钮：受理 / 处理中 / 已完成 / 去回复

Toast 底部有 **4 个按钮**：`受理` / `处理中` / `已完成` / `去回复`，全部走私有协议 `dshbox://`（`activationType="protocol"`），**不需要打开页面就能改状态**。

按钮 XML（真实生成结果，`item` 就是需求条目自己的 id，一般是 12 位十六进制）：

```xml
<actions>
  <action content="受理"   activationType="protocol" arguments="dshbox://status?item=0123456789ab&amp;to=accepted"/>
  <action content="处理中" activationType="protocol" arguments="dshbox://status?item=0123456789ab&amp;to=doing"/>
  <action content="已完成" activationType="protocol" arguments="dshbox://status?item=0123456789ab&amp;to=done"/>
  <action content="去回复" activationType="protocol" arguments="dshbox://open?item=0123456789ab#reply"/>
</actions>
```

### 私有协议 dshbox://（注册了什么、怎么卸载）

首次运行（或 `notify.mjs identity`）会幂等写入 `HKCU`：

| 位置 | 值 |
|---|---|
| `HKCU\Software\Classes\dshbox`（默认值） | `URL:DshBox Protocol` |
| `HKCU\Software\Classes\dshbox` 的 `URL Protocol` | 空字符串（声明这是 URL 协议） |
| `HKCU\Software\Classes\dshbox\shell\open\command`（默认值） | `"C:\Windows\System32\wscript.exe" "D:\大肥鱼\需求箱\notify-action.vbs" "<node.exe 路径>" "%1"` |

点击链路：

```
toast 按钮 → Windows 调 dshbox://…
  → wscript.exe 静默运行 notify-action.vbs（窗口样式 0，不闪控制台）
  → notify-action.mjs 解析参数
      · status：带 x-box-token POST http://127.0.0.1:3200/api/box/receipt
                 accepted→received（已收）、doing→working（处理中）、done→done（已处理）
      · open  ：解析页面地址 → 默认浏览器打开 ?token=…&item=<id>#reply，
                 页面加载后自动滚动并高亮那条留言、聚焦回复输入框
```

**卸载**（三步，全部在 `HKCU`，不动系统设置）：

```powershell
Remove-Item 'HKCU:\Software\Classes\dshbox' -Recurse -Force
Remove-Item 'HKCU:\SOFTWARE\Classes\AppUserModelId\DshBox.Notification' -Recurse -Force
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DshBoxNotify.lnk" -Force
```

**已知限制**：

- **插件没在运行时点击**「受理 / 处理中 / 已完成」会**静默失败**（POST 打不通，只在 `state/notify-action.log` 留一行）。不弹错误框、不打开窗口。
- 「去回复」不依赖插件是否运行：它只是打开页面；但页面还是要 box-server 在跑才能看到数据。
- Win11 的 actions 是两列网格，`hint-buttonStyle` 只影响颜色/样式、不能强制整行宽度。当前版式是 3 个状态 + 1 个跳转，若实机渲染挤成 2×2，就是系统限制，不是 XML 写错。
- 协议处理器路径里写死了注册时的 node 路径；换机器/换 node 位置后重跑 `notify.mjs identity` 会自动刷新。

解析「去回复」落点仍复用上文的优先级（DSH 端口动态取 → 独立页面兜底）；**只解析不发通知**：`node "D:\大肥鱼\需求箱\notify.mjs" url`。

### 怎么改设置

两种入口，改完点「保存设置」**立即生效，不用重启服务**：

1. DSH → 设置 → 左侧「需求箱」→ 顶部「🔔 通知分级」→ 展开设置
2. 直接打开独立页面 `http://127.0.0.1:3200/?token=<state/box-token 里的令牌>`，在「🔔 通知分级设置」里改

每个等级都可以单独设置：

- **启用**：关掉后该等级完全不提醒（仍会写日志）
- **方式**：系统通知（Toast）/ 弹窗（WScript 对话框）/ 声音 / 静默
- **声音**：不出声 / 响一次 / 循环
- **持续提醒**：紧急默认勾选（每 20 秒重弹，共 3 次）
- **任务栏闪烁**：紧急默认勾选（找 DSH 窗口调用 `FlashWindowEx`）
- **测试**：立即按当前设置发一条测试通知，用来确认效果

全局还可以改「默认等级」、「类型默认等级」映射，以及是否「监听 AI / QQ 桥接写入的新条目」。

另外有一行**天气**设置：勾选「通知里附带实时天气（温度+状况+插图）」+ 可选城市（留空即自动定位）。

还有一块**语音广播**设置：总开关、四级各自的「播报」勾选、播报模板 / 自定义文本、语音（本机只看得到中文语音）、语速、音量，以及「试听」按钮。

### 配置存放位置

| 文件 | 说明 |
|---|---|
| `state/notify-config.json` | 分级通知配置（持久化，重启后保留） |
| `state/notify-seen.json` | 已提醒过的条目 ID，避免重复弹窗 |
| `state/notify.log` | 通知发送记录（排查用，超过 512KB 自动裁剪） |
| `state/weather-locate.json` | IP 自动定位结果缓存（按天有效） |
| `state/dsh-port.json` | 上次探测到的 DSH 端口（当日有效，只用于通知按钮跳转） |
| `state/notify-action.log` | 通知按钮点击记录（含插件未运行时的失败记录） |

`notify-config.json` 结构示例（`weather` / `speech` 都是可选增量，旧配置读进来会自动补默认值）：

```json
{
  "defaultLevel": "normal",
  "kindLevel": { "sos": "urgent", "l1": "important", "l2": "normal", "l3": "low" },
  "watchExternal": true,
  "toastAppId": "DshBox.Notification",
  "weather": { "enabled": true, "city": "", "cacheMinutes": 10, "timeoutMs": 4000 },
  "levels": {
    "urgent": { "enabled": true, "mode": "toast", "sound": "loop", "soundSeconds": 12,
                "scenario": "urgent", "duration": "long", "repeatTimes": 3,
                "repeatIntervalSec": 20, "flash": true, "dialogTimeout": 0 },
    "important": { "enabled": true, "mode": "toast", "sound": "once", "scenario": "reminder" },
    "normal": { "enabled": true, "mode": "toast", "sound": "off" },
    "low": { "enabled": true, "mode": "silent", "sound": "off" }
  }
}
```

### 降级与兼容

- Toast 通过 Windows PowerShell 调 `Windows.UI.Notifications`，发送身份是插件自己的 `DshBox.Notification`（首次运行自动注册，见上文「Toast 身份」；`toastAppId` 仍可自定义，旧值会自动归一化）。
- Toast 身份注册成功才会用 Toast；身份建不起来时**直接改用 WScript 弹窗**，不弹空通知。
- 如果 Toast 调用失败，自动降级为 WScript 弹窗；弹窗也失败则只做任务栏闪烁；全程不会让 box-server 退出。
- 通知按钮的跳转地址解析失败时只解析出兜底的独立页面（带令牌），不会让通知发送失败。
- 天气任何一步失败（定位失败、接口超时、断网）都只是**少一行天气、少一张图**，通知照常弹；失败后 60 秒内不再重复请求。
- 配图文件缺失时同样静默跳过，不影响文字通知。
- 所有通知在独立 PowerShell 进程中异步执行，带超时终止，不阻塞需求箱服务。
- 改动集中在 `需求箱` 插件内部（`notify.mjs` + `box-server.mjs`），不碰 DSH 的 `exe` / `resources` / `locales`。

### 手动测试 / 排查

插件真正发通知的命令行（不是示意版，就是 `spawn` 里那五个参数）：

```
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
  -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -EncodedCommand <base64(UTF-16LE 编码的脚本)>
```

- 可执行文件：`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（取 `%SystemRoot%` 下同路径）
- 脚本内容不落盘、不传 `-File`，全部塞进 `-EncodedCommand`；标题/正文/天气/按钮 URL 等文本一律以 **base64(UTF-8)** 作为参数传给脚本里的 `FromB64`
- AppID：`DshBox.Notification`（脚本里 `CreateToastNotifier($AppId)`）
- 想看**当前真实的完整命令行**（含编码后的整段 base64 与解码后脚本），不发通知：

```powershell
& "D:\大肥鱼\SnowLuma\node.exe" "D:\大肥鱼\需求箱\notify.mjs" cmd urgent
# 带上条目 id 还能预览 4 个按钮的 XML（不发通知）
& "D:\大肥鱼\SnowLuma\node.exe" "D:\大肥鱼\需求箱\notify.mjs" cmd urgent 0123456789ab
```

其它只读排查命令（都不弹通知）：

```powershell
# 身份是否就绪（缺了会自动补建，幂等）
node "D:\大肥鱼\需求箱\notify.mjs" identity

# 通知按钮会跳到哪个地址（DSH 页面 or 独立页面）
node "D:\大肥鱼\需求箱\notify.mjs" url

# 当前定位与天气
node "D:\大肥鱼\需求箱\notify.mjs" weather

# 本机装了哪些语音、有没有中文语音（只读，不出声）
node "D:\大肥鱼\需求箱\notify.mjs" voices

# 试听一句（只出声，不建需求、不弹通知）
& "D:\大肥鱼\SnowLuma\node.exe" "D:\大肥鱼\需求箱\notify.mjs" say 测试一下语音播报
```

会真的弹通知的测试（确认要弹的时候再跑）：

```powershell
# 命令行直接测某个等级
& "D:\大肥鱼\SnowLuma\node.exe" "D:\大肥鱼\需求箱\notify.mjs" test urgent

# 通过服务测（需令牌，令牌在 state\box-token）
curl -X POST "http://127.0.0.1:3200/api/notify/test" -H "x-box-token: <令牌>" -H "content-type: application/json" -d "{\"level\":\"urgent\"}"

# 造一条紧急需求，走完整链路
curl -X POST "http://127.0.0.1:3200/api/box" -H "x-box-token: <令牌>" -H "content-type: application/json" -d "{\"kind\":\"sos\",\"level\":\"urgent\",\"title\":\"紧急通知测试\"}"
```


## 安装

```bash
dsh plugin --profile web add <你的安装源>
```

或本地开发安装：

```bash
dsh plugin --profile web add link:/path/to/dsh-box-ui
```

装完重启 DSH，面板出现在：**DSH → 左下角账号菜单 → 设置 → 左侧导航「需求箱」**。

## 宿主依赖

面板不含留言箱本体，需要另外跑一个伴生服务：

| 组件 | 说明 |
|---|---|
| box-server | HTTP 服务，默认 `127.0.0.1:3200` |
| `state/box-token` | 令牌文件，宿主侧读，客户端不接触 |

宿主的每个请求都会带上 `x-box-token` 转发给 box-server。

没有 box-server 时，面板会提示「读不到需求箱令牌」或后端不可达。

## 配置

| 变量 | 含义 | 默认 |
|---|---|---|
| `BOX_DIR` | 需求箱根目录（含 `state/box-token`） | `D:\大肥鱼\需求箱` |
| `BOX_PORT` | box-server 端口 | `3200` |

## API

宿主侧注册在 DSH 的 webServer 上，前缀 `/dsh-box`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-box/health` | box-server 是否活着 |
| GET | `/dsh-box/items` | 列出条目 |
| POST | `/dsh-box/receipt` | 改回执 |
| POST | `/dsh-box/reply` | 回复 |
| POST | `/dsh-box/remove` | 删除 |
| POST | `/dsh-box/new` | 新建 |
| POST | `/dsh-box/clear` | 批量清空；带 `receipt` 只清该状态，不带则全清，需 `confirm: true` |
| GET | `/dsh-box/notify/config` | 读取分级通知配置与最近日志 |
| POST | `/dsh-box/notify/config` | 保存配置（立即生效） |
| POST | `/dsh-box/notify/test` | 按等级发一条测试通知 |
| GET | `/dsh-box/notify/log` | 最近通知日志 |

box-server 端对应 `/api/notify/config`、`/api/notify/test`、`/api/notify/log`。

## 许可

Apache-2.0 · 蝠羽科技

**允许二次修改与再分发（含商业用途），但不得更改制作方署名。**

- 许可证全文：[LICENSE](./LICENSE)
- 署名与二改规则：[NOTICE](./NOTICE)
- 源码文件头部已带 Copyright 2026 蝠羽科技 版权声明，二次修改时必须保留；
  依 Apache-2.0 第 4(c)、4(d) 条，衍生作品须保留全部版权与署名声明，
  并复制 NOTICE 中的署名内容。删除或改写署名即不再符合本许可。
- 二次修改者可以在保留原署名的前提下，额外标注自己的修改说明与版权声明。
