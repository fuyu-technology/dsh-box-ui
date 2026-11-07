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

## 许可

Apache-2.0 · 蝠羽科技

**允许二次修改与再分发（含商业用途），但不得更改制作方署名。**

- 许可证全文：[LICENSE](./LICENSE)
- 署名与二改规则：[NOTICE](./NOTICE)
- 源码文件头部已带 Copyright 2026 蝠羽科技 版权声明，二次修改时必须保留；
  依 Apache-2.0 第 4(c)、4(d) 条，衍生作品须保留全部版权与署名声明，
  并复制 NOTICE 中的署名内容。删除或改写署名即不再符合本许可。
- 二次修改者可以在保留原署名的前提下，额外标注自己的修改说明与版权声明。
