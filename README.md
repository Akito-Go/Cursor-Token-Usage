# Cursor Token Usage

[English](#english) | [中文](#中文)

---

## English

A VS Code / Cursor IDE extension that shows your current Cursor **token billing** on the status bar. Click the status bar to open a details panel with progress bars, per-model tokens, and recent events.

Cursor now bills by tokens in two pools (not the old “fast-premium requests + dollars” model). This extension reads the live dashboard APIs and adapts the display to your account type.

### Features

- **Status bar** — Always-on usage: individual accounts show `C xx% · O xx%`; Team / Enterprise show included spend vs limit (values returned by Cursor, in cents)
- **Details panel** — Click the status bar for a circular usage ring, colored progress bars, per-model token bars, and recent events
- **Account-aware** — Membership type is inferred from the API (`individual` vs `team` / `enterprise`), not from the token itself
- **Auto refresh** — Configurable polling interval (default: 30 seconds)
- **Usage alerts** — Notifications when usage changes exceed thresholds between two polls
- **i18n** — English and Chinese (Simplified); the editor language drives the UI
- **macOS / Windows / Linux** — Universal VSIX. Auto-reads the local Cursor session (`state.vscdb`); Windows uses `%APPDATA%\Cursor\...`
- **Remote development** — Declared as a UI extension (`extensionKind: ui`) so it runs on your **local** machine and can still read your Cursor session when the workspace is on **SSH Remote**, WSL, or Dev Containers

### Installation

1. Download `cursor-token-usage-1.0.5.vsix` from [Releases](https://github.com/Akito-Go/Cursor-Token-Usage/releases/tag/v1.0.5)
2. Drag the file into Cursor, or `Cmd+Shift+P` (Windows: `Ctrl+Shift+P`) → `Extensions: Install from VSIX...`
3. `Developer: Reload Window`

### Authentication

The extension tries to read your Cursor session from the local database (`state.vscdb`: `cursorAuth/accessToken` + user id) and sends it as the `WorkosCursorSessionToken` cookie to `cursor.com` only.

Session file locations:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

Auto-detect needs **Python 3** on PATH (`python3` / `python`, or the Windows `py` launcher). If Python is missing, use **Set Session Token** — the rest of the extension still works.

If automatic detection fails:

1. Command Palette → **Cursor Token Usage: Set Session Token**
2. Paste `WorkosCursorSessionToken` (format: `userId%3A%3AaccessToken`)
3. The token is stored in VS Code SecretStorage (encrypted, never in `settings.json`)

To find the cookie: open [cursor.com](https://cursor.com) in a browser → DevTools → Application → Cookies → copy `WorkosCursorSessionToken`.

**Remote SSH, WSL, and Dev Containers:** This is a **UI extension**. It runs in the **local** Cursor process (where your login and `state.vscdb` live), not on the remote host. Install it locally; you do not need a copy on the remote server.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `cursorTokenUsage.displayCount` | 5 | How many recent usage events to show in the details panel |
| `cursorTokenUsage.pollingInterval` | 30 | Polling interval in seconds (5–300) |
| `cursorTokenUsage.showStatusBar` | true | Show usage on the status bar |
| `cursorTokenUsage.statusBarAlignment` | `right` | Status bar side: `left` or `right` |
| `cursorTokenUsage.alertEnabled` | true | Enable usage-change alerts |
| `cursorTokenUsage.alertItems` | `["newSession", "overallSpending", "cursorModels", "otherModels", "totalTokens"]` | Metrics to watch |
| `cursorTokenUsage.alertThreshold.newSession` | 2 | New usage requests in one poll |
| `cursorTokenUsage.alertThreshold.overallSpending` | 1 | Included spend change ($) |
| `cursorTokenUsage.alertThreshold.cursorModels` | 10 | Cursor Models pool change (%) |
| `cursorTokenUsage.alertThreshold.otherModels` | 10 | Other Models pool change (%) |
| `cursorTokenUsage.alertThreshold.onDemandSpending` | 1 | On-demand spend change ($) |
| `cursorTokenUsage.alertThreshold.totalTokens` | 100000 | Total tokens change |

### Status bar & details panel

```
Status bar (individual):     $(graph) C 42% · O 18%
Status bar (team/enterprise): $(graph) $67.88/$52.00

Details panel
┌─────────────────────────────────────────────┐
│ Cursor Token Usage              enterprise  │
│ Reset in: 12d 4h          Total Tokens 1.2M │
│                                             │
│   (  131%  )   Included usage               │
│                $67.88 / $52.00              │
│ ████████████████████████████░░░░  over 100% │
│ Cursor Models   ████████░░░░░░░░     42%    │
│ Other Models    ███░░░░░░░░░░░░░     18%    │
│ On-Demand       $5.74                       │
│                                             │
│ By Model                                    │
│ claude-4.6-opus  ████████████████    80.1万  │
│ gpt-5            ██████░░░░░░░░░░    12.4万  │
│                                             │
│ Recent Usage                                │
│ 08-13 21:04  Claude 4.6 Opus  Included  2.1万│
└─────────────────────────────────────────────┘
```

Bar colors: green &lt; 40%, yellow &lt; 80%, orange ≥ 80%, red ≥ 100%. Clicking the status bar opens this panel. Buttons: Refresh, Set Session Token, Status bar side, Configure Alerts.

≥ 80% of the limit tints the status bar warning; ≥ 100% tints it error.

### Commands

| Command | What it does |
|---------|----------------|
| Show Token Usage Details | Open the details panel (same as clicking the status bar) |
| Refresh Token Usage | Poll immediately |
| Set Session Token | Paste / clear `WorkosCursorSessionToken` |
| Set Polling Interval | 5–300 seconds |
| Set Status Bar Side | Left or right |
| Configure Usage Alerts | Toggle, pick metrics, set thresholds |

### Usage Alerts

1. Command Palette → **Cursor Token Usage: Configure Usage Alerts**, or the Alerts button in the details panel
2. Enable alerts → Select monitoring items → Set thresholds
3. Available monitors: new usage requests, included spend, Cursor Models %, Other Models %, On-Demand spend, total tokens
4. A threshold of `0` means any change triggers an alert

> Thresholds are checked on each poll (`pollingInterval` seconds). The value is the **delta between two consecutive polls**, not a cumulative or absolute cap. Example: `onDemandSpending` = `1.0` fires when on-demand spend rises by $1.00 or more since the last successful poll.

### Why dollars are not estimated

Cursor often returns `$0` / `chargedCents: 0` on usage events for self-serve plans, even when tokens were used. Multiplying tokens by public list prices would not match the invoice: included vs on-demand, Team/Enterprise discounts, and Cursor Token Rate are applied server-side.

This extension only shows `$` when the API itself returns cents (for example `individualUsage.overall` used/limit, or on-demand used/limit). Token counts are always shown as tokens.

### Build from Source

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

Install the resulting `.vsix`, then **Developer: Reload Window**.

---

## 中文

一款 VS Code / Cursor IDE 扩展，在状态栏显示 Cursor **现行 token 计费**用量。点击状态栏打开详情面板：环形进度、彩色进度条、按模型 Token、最近调用。

Cursor 已改为按 token、双池计费（不再是旧的「fast-premium 请求次数 + 美元」）。本扩展读取 dashboard 接口，并按账号类型切换展示。

### 功能特性

- **状态栏** — 个人账号显示 `C xx% · O xx%`；团队 / 企业显示套餐内已用 vs 上限（接口返回的美分，不是本地估算）
- **详情面板** — 点击状态栏：环形用量、彩色进度条、按模型 Token 条、最近事件
- **账号自适应** — 类型来自接口（`individual` / `team` / `enterprise`），不是从 token 猜的
- **自动刷新** — 可配置轮询间隔（默认 30 秒）
- **用量提醒** — 两次轮询之间的变化超过阈值时弹窗
- **国际化** — 中英文本地化，跟随编辑器语言
- **macOS / Windows / Linux** — 通用 VSIX。自动读本机 Cursor 会话（`state.vscdb`）；Windows 路径为 `%APPDATA%\Cursor\...`
- **远程开发** — 声明为 UI 扩展（`extensionKind: ui`），在**本机**运行；工作区在 SSH Remote、WSL 或 Dev Containers 时仍能读本机 Cursor 登录

### 安装方法

1. 从 [Releases](https://github.com/Akito-Go/Cursor-Token-Usage/releases/tag/v1.0.5) 下载 `cursor-token-usage-1.0.5.vsix`
2. 把文件拖进 Cursor，或 `Cmd+Shift+P`（Windows：`Ctrl+Shift+P`）→ `Extensions: Install from VSIX...`
3. 执行 `Developer: Reload Window`

### 认证方式

扩展会尝试从本机 `state.vscdb` 读取 `cursorAuth/accessToken` 与用户 id，拼成 `WorkosCursorSessionToken` Cookie，且只发给 `cursor.com`。

会话文件位置：

| 系统 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

自动读取需要 PATH 上有 **Python 3**（`python3` / `python`，Windows 也可用 `py` 启动器）。没有 Python 时用 **Set Session Token**，其余功能仍可用。

若自动检测失败：

1. 命令面板 → **Cursor Token Usage: Set Session Token**
2. 粘贴 `WorkosCursorSessionToken`（格式：`userId%3A%3AaccessToken`）
3. Token 用 VS Code SecretStorage 加密存储，不会写入 `settings.json`

获取 Cookie：浏览器打开 [cursor.com](https://cursor.com) → 开发者工具 → Application → Cookies → 复制 `WorkosCursorSessionToken`。

**SSH Remote、WSL、Dev Containers：**本扩展为 **UI 扩展**，在**本机** Cursor 进程中运行（与登录、`state.vscdb` 同环境），不要装到远程主机。自动读会话无需在远端再装一份。

### 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `cursorTokenUsage.displayCount` | 5 | 详情面板显示的最近用量条数 |
| `cursorTokenUsage.pollingInterval` | 30 | 轮询间隔（秒，5–300） |
| `cursorTokenUsage.showStatusBar` | true | 是否在状态栏显示 |
| `cursorTokenUsage.statusBarAlignment` | `right` | 状态栏位置：`left` 或 `right` |
| `cursorTokenUsage.alertEnabled` | true | 启用用量变化提醒 |
| `cursorTokenUsage.alertItems` | `["newSession", "overallSpending", "cursorModels", "otherModels", "totalTokens"]` | 提醒监控项 |
| `cursorTokenUsage.alertThreshold.newSession` | 2 | 单次轮询新增调用数 |
| `cursorTokenUsage.alertThreshold.overallSpending` | 1 | 套餐内花费变化（$） |
| `cursorTokenUsage.alertThreshold.cursorModels` | 10 | Cursor Models 池变化（%） |
| `cursorTokenUsage.alertThreshold.otherModels` | 10 | Other Models 池变化（%） |
| `cursorTokenUsage.alertThreshold.onDemandSpending` | 1 | On-Demand 花费变化（$） |
| `cursorTokenUsage.alertThreshold.totalTokens` | 100000 | Token 总量变化 |

### 状态栏与详情面板

```
状态栏（个人）：     $(graph) C 42% · O 18%
状态栏（团队/企业）： $(graph) $67.88/$52.00

详情面板
┌─────────────────────────────────────────────┐
│ Cursor Token Usage              enterprise  │
│ 重置倒计时：12天4小时        Token 合计 1.2M │
│                                             │
│   (  131%  )   套餐内用量                    │
│                $67.88 / $52.00              │
│ ████████████████████████████░░░░  已超 100% │
│ Cursor Models   ████████░░░░░░░░     42%    │
│ Other Models    ███░░░░░░░░░░░░░     18%    │
│ On-Demand       $5.74                       │
│                                             │
│ 按模型                                      │
│ claude-4.6-opus  ████████████████    80.1万  │
│ gpt-5            ██████░░░░░░░░░░    12.4万  │
│                                             │
│ 最近消耗                                    │
│ 08-13 21:04  Claude 4.6 Opus  Included  2.1万│
└─────────────────────────────────────────────┘
```

进度条颜色：绿 &lt; 40%、黄 &lt; 80%、橙 ≥ 80%、红 ≥ 100%。点击状态栏打开此面板。按钮：刷新、设置 Session Token、状态栏位置、配置提醒。

用量 ≥ 80% 状态栏警告底色；≥ 100% 错误底色。

### 命令

| 命令 | 作用 |
|------|------|
| Show Token Usage Details | 打开详情面板（等同点击状态栏） |
| Refresh Token Usage | 立即刷新 |
| Set Session Token | 粘贴 / 清除 `WorkosCursorSessionToken` |
| Set Polling Interval | 5–300 秒 |
| Set Status Bar Side | 左 / 右 |
| Configure Usage Alerts | 开关、监控项、阈值 |

### 用量提醒

1. 命令面板 → **Cursor Token Usage: Configure Usage Alerts**，或详情面板里的提醒按钮
2. 开启提醒 → 选择监控项 → 设置阈值
3. 可监控：新增调用、套餐内花费、Cursor Models %、Other Models %、On-Demand 花费、Token 总量
4. 阈值设为 `0` 表示任何变化都会提醒

> 阈值在每次轮询时检查（间隔为 `pollingInterval` 秒）。数值是**两次轮询之间的变化量**，不是累计或绝对上限。例如 `onDemandSpending` 设为 `1.0`，表示两次成功轮询之间 On-Demand 花费增加 $1.00 或以上时触发。

### 为什么不估算美元

自助套餐的用量事件里，美元字段经常是 `$0`（`chargedCents: 0`），即使已经消耗了 token。用 token × 官网单价去乘，对不上账单：套餐额度、团队 / 企业折扣、Cursor Token Rate 都在服务端结算。

只有接口自己返回美分时才显示 `$`（例如 `individualUsage.overall` 的 used/limit，或 On-Demand used/limit）。Token 始终按 token 显示。

### 从源码构建

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

安装生成的 `.vsix` 后执行 **Developer: Reload Window**。
