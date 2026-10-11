---
name: update
description: 查一下 Arbiter（应用与插件）有没有新版本，需要时把安装包下载好但不安装。示例：/arbiter:update
argument-hint: [--download]
---

# /arbiter:update —— 看看有没有新版本

用户给的参数是：

```
$ARGUMENTS
```

## 先读这一段：这个命令**不做**什么

⚠️ **它不安装任何东西。** 下载完就停在那儿，装不装由用户决定。别自作主张去跑安装包、
别去替换安装目录里的任何文件——那是一条不可撤销的路，而用户只说「看看有没有新版」。

⚠️ **它不改应用的任何设置，也不碰源文件。** 唯一会写盘的只有 `--download` 那一档，
而且只往下载目录里放一个新文件。

⚠️ **插件的更新要重启 Claude Code 才生效。** 而且这件事**只能由用户自己跑那两条命令**
（`claude plugin marketplace update arbiter` + `claude plugin update arbiter@arbiter --yes`）——
别替他执行：那会在会话中途换掉正在用的插件。

⚠️ **「没查成」不等于「已经是最新」。** 脚本会把这两件事分得很开（`latest_error` 字段与
`status: "unknown"`）。转述的时候也**必须分开说**——把「这次没问到」讲成「你已经是最新的」，
用户会以为自己不用更新，而这个方向恰好是错的。

## 先定位脚本（别猜路径）

脚本是插件里的 `mcp/update.mjs`。按顺序试这三条：

1. 环境变量 `CLAUDE_PLUGIN_ROOT` 有值时 → `$CLAUDE_PLUGIN_ROOT/mcp/update.mjs`
2. 否则读 `~/.claude/plugins/installed_plugins.json`，取 `plugins["arbiter@arbiter"]`
   第一个元素的 `installPath` → `<installPath>/mcp/update.mjs`
3. 开发形态（marketplace 指向一个本地 clone）：<仓库根>/plugins/arbiter/mcp/update.mjs

> ⚠️ **实测（2026-09-26）：`CLAUDE_PLUGIN_ROOT` 在 Bash 工具的环境里是空的。**
> 所以别只靠第 1 条，那样会得到一个「文件不存在」而不知道为什么的报错。

## 怎么做

**默认（不带参数）= 只查，什么都不下。** 跑：

```bash
node "<脚本路径>" --check
```

**只有用户明确说要下载**时才加 `--download`：

```bash
node "<脚本路径>" --download
```

⚠️ **下载那一档要给它足够的时间。** 安装包约 140 MB，慢网络下要好几分钟。
用 Bash 工具时把 `timeout` 设到上限（`600000`），或者直接放后台跑——
**别用默认的两分钟**，那会在下载到一半时把进程掐掉，而用户看到的是「什么都没发生」。

脚本的 stdout **恰好是一个 JSON 对象**（诊断走 stderr，不用管）。它长这样：

```jsonc
{
  "ok": true,                  // 查询本身跑通了吗（与「有没有新版」无关）
  "latest": { "version": "0.3.5", "tag": "v0.3.5", "url": "…" },
  "latest_error": null,        // 非 null 时 = 这次没查到，里面有 code / message / next_steps
  "app":    { "installed": "0.3.3", "status": "update-available", "asset": { … } },
  "plugin": { "installed": "0.3.2", "source": "0.3.5", "status": "update-available", "commands": [ … ] },
  "download": null,            // --download 成功时才有：path / sha256 / bytes
  "download_error": null,
  "notes": [ "……给用户看的话，已经是当前语言的了" ]
}
```

`status` 只有三个值：`update-available` / `up-to-date` / `unknown`。

## 怎么把结果说给用户

**先看 `latest_error`。** 它非 null 时，这次根本没查到最新版本——直接把 `message` 与
`next_steps` 说给用户，**并且说清「这不等于你已经是最新的」**。此时 `app.status` 必然是
`unknown`，别把它讲成 `up-to-date`。

查到了的话，说三件事就够：

1. **应用**：本机是什么版本（`app.installed`）。有新版本就报一下差多少、以及 `--download`
   能把安装包拿下来。
2. **插件**：`plugin.installed` → `plugin.source`。要更新就把 `plugin.commands` 里那两条
   原样给用户，**并提醒要重启 Claude Code**。
3. `--download` 跑过的话：`download.path` 是安装包落点，告诉用户双击它、以及**装之前先退出
   正在运行的 Arbiter**。

`notes` 里那句可以照抄——它已经按当前语言写好了。

## 两条踩过的坑

- **本机若把 GitHub 域名指到了本地转发服务**（或网络做了 TLS 拦截），第一次跑会报
  `tls_certificate`。脚本的 `next_steps` 里已经写了下一步：把同一条命令前面加
  `node --use-system-ca`。这是**本机网络环境**的事，不是脚本坏了。
- **没网、被限流、超时**都会给出各自的 `code`，且都**不会**被折成「已是最新」。
  别为了让回答好看而把 `unknown` 说成别的。
