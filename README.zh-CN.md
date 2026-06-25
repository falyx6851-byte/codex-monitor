# Codex Token Monitor

中文说明 | [English](README.md)

本项目是一个本地 Codex token 与请求记录监控看板。它读取本机 Codex session JSONL 文件，把 token 使用记录规范化到本项目自己的 SQLite 数据库里，并在本地提供 Web 页面：

```text
http://127.0.0.1:4127
```

项目原则是本地优先、少侵入：

- 不做反向代理。
- 不抓包。
- 不读取 OAuth token。
- 不读取 Codex 的 `logs_2.sqlite`。
- 不接 OpenAI API key 账单接口。
- 不反推请求 IP。

## 功能

- 请求明细表：输入、缓存、输出、总 token、模型、状态、费用估算、首输出估算、响应耗时估算。
- 顶部监控卡片：请求数、总 token、缓存命中率、输出 token、估算金额、平均响应耗时。
- 自定义时间范围与分页。
- 本地 SQLite 派生统计库，可删除后自动重建。
- 独立 CLI 统计脚本，可导出 table / JSON / CSV。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Codex | 本机存在 Codex session 日志 |
| Web 看板 | Node.js 24+，因为使用 `node:sqlite` |
| 独立统计脚本 | Node.js 18+ |
| Windows 辅助脚本 | PowerShell |

默认 Codex home：

- Windows：`%USERPROFILE%\.codex`
- macOS / Linux：`~/.codex`

如需指定路径：

```bash
CODEX_HOME=/path/to/.codex npm start
```

## 快速开始

```bash
git clone https://github.com/falyx6851-byte/codex-monitor.git
cd codex-monitor
npm start
```

打开：

```text
http://127.0.0.1:4127
```

第一次加载页面时，服务会扫描变化过的 session JSONL，并创建本地统计库：

```text
data/codex-token-monitor.sqlite
```

`data/` 已经被 `.gitignore` 忽略。它只是派生数据，可以删除后重建。

## Windows 常驻运行

前台启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

后台隐藏启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-hidden.ps1
```

停止服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1
```

安装当前用户登录自启：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup-task.ps1
```

卸载登录自启：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-startup-task.ps1
```

## macOS / Linux 说明

核心服务 `server.js` 和独立统计脚本不是 Windows 专用。只要 Codex 在 `~/.codex/sessions` 下写 session JSONL，理论上可以直接运行：

```bash
npm start
```

Windows 专用部分：

- `scripts/*.ps1`
- `scripts/*.cmd`
- Windows 计划任务自启安装

macOS 如果要常驻启动，可以自行用 `launchd`、`pm2`、`systemd --user` 或其他本地进程管理方案。本仓库暂未内置 macOS 自启脚本。

## 独立统计脚本

独立脚本不依赖 Web 服务，也不依赖 SQLite。它只读取 session JSONL。

```bash
node scripts/codex-token-report.mjs --today --format table
node scripts/codex-token-report.mjs --days 7 --format json --out codex-usage.json
node scripts/codex-token-report.mjs --start 2026-06-01 --end 2026-06-24 --format csv --redact-paths --out codex-records.csv
```

Windows 包装命令：

```powershell
.\scripts\codex-token-report.ps1 --today --format table
.\scripts\codex-token-report.cmd --days 7 --format csv --redact-paths --out codex-records.csv
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--codex-home <dir>` | 指定 Codex home，默认 `CODEX_HOME` 或 `~/.codex` |
| `--today` / `--days <n>` / `--all` | 时间范围 |
| `--start <time>` / `--end <time>` | 自定义时间范围，支持毫秒、ISO、`YYYY-MM-DD` |
| `--format table/json/csv` | 输出格式 |
| `--bucket hour/day/week/none` | 汇总粒度 |
| `--limit <n>` / `--page <n>` / `--page-size <n>` | 明细分页 |
| `--no-dedupe` | 保留重复 `token_count` 事件 |
| `--redact-paths` | 导出前隐藏本地 cwd / session 文件路径 |
| `--out <file>` | 写入文件 |

## 数据源口径

主数据源：

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

主请求记录来自：

```text
row.type = "event_msg"
row.payload.type = "token_count"
row.payload.info.last_token_usage
```

字段口径：

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| 输入 token | `last_token_usage.input_tokens` | session JSONL 记录的 token 字段 |
| 缓存输入 token | `last_token_usage.cached_input_tokens` | 输入 token 子集，不额外加总 |
| 输出 token | `last_token_usage.output_tokens` | 输出侧 token |
| Reasoning token | `last_token_usage.reasoning_output_tokens` | 输出 token 子集，不额外加总 |
| 总 token | `last_token_usage.total_tokens` | 请求级主加总字段 |
| 模型 | 最近的 `turn_context.model` | 本地 session 上下文 |
| 时间戳 | `token_count.timestamp` | 本地 session 事件时间 |
| 状态 | `token_count`、`event_msg/error`、usage 异常 | 只显示成功 / 失败 |
| 错误原因 | `event_msg/error.payload.message` 或本地异常原因 | 没有明确原因时不编造 |
| 费用估算 | `pricing.json` + token usage | 本地估算，不是官方账单 |
| 首输出估算 | 本地边界到首个 `response_item` | 不是官方 TTFT |
| 响应耗时估算 | 本地边界到 `token_count` | 不是服务端耗时 |

已排除数据源：

| 数据源 | 处理 |
| --- | --- |
| `~/.codex/logs_2.sqlite` | 不读取 |
| raw SSE | 不抓取 |
| OpenTelemetry trace | 不读取 |
| `~/.codex/auth.json` | 不读取 |
| OpenAI Admin Usage / Costs API | 不接入 |

## 状态与失败口径

页面只展示：

- 成功
- 失败

失败来源：

- session 中存在明确 `event_msg/error`。
- `last_token_usage.total_tokens > 0`，但输入、缓存、输出全是 `0`。这类记录视为本地 session usage 明细不完整或异常。

如果 session JSONL 没有写 HTTP status 或错误码，本项目不会推断 `429`、`500` 或网络错误。

## 费用口径

费用来自 `pricing.json` 的本地估算：

```text
未缓存输入 token * input rate
+ 缓存输入 token * cached input rate
+ 输出 token * output rate
```

注意：

- `reasoning_output_tokens` 已包含在输出 token 中，不重复加总。
- `cached_input_tokens` 已包含在输入 token 中，不重复加总。
- 只有总 token、没有输入/输出拆分的异常记录不计入已计价记录。
- 这不是 OpenAI 官方账单，也不是 billing API 返回值。

## 本地 API

健康检查：

```text
GET /api/health
```

数据接口：

```text
GET /api/data
```

查询参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `start_ms` | UI 默认当天 0 点 | Unix 毫秒 |
| `end_ms` | 当前时间 | Unix 毫秒 |
| `page` | `1` | 页码 |
| `page_size` | `7` | 每页条数，限制 `5..100` |
| `bucket` | `day` | `hour`、`day`、`week` |

## 本地 SQLite

Web 看板维护一个派生 SQLite：

```text
data/codex-token-monitor.sqlite
```

同步模式：

1. 页面或 API 请求 `/api/data`。
2. 服务扫描 `sessions/**/*.jsonl`。
3. 比较文件 `size` 与 `mtime`。
4. 只解析新增或变化文件。
5. 写入本项目 SQLite。

没有后台 tail，也没有持续写盘。

## 目录结构

```text
server.js
pricing.json
package.json
public/
  index.html
  app.js
  styles.css
scripts/
  codex-token-report.mjs
  codex-token-report.ps1
  codex-token-report.cmd
  start.ps1
  start-hidden.ps1
  stop.ps1
  install-startup-task.ps1
  uninstall-startup-task.ps1
docs/
  data-source-audit.md
  official-openai-usage.md
  monitoring-research.md
```

## 隐私提醒

Codex session 文件可能包含 prompt、输出内容、本地路径和工具调用上下文。不要直接发布你自己的 `data/` 目录或导出的报告，除非你已经检查并脱敏。

`.gitignore` 已排除：

```text
data/
*.sqlite
*.sqlite-shm
*.sqlite-wal
.env
.env.*
```

## 已知限制

- 没有官方单请求 HTTP status，除非 session JSONL 自己记录。
- 没有官方 TTFT。
- 没有请求 IP。
- 没有历史请求 Fast 开关，除非 session JSONL 为该请求写出 `service_tier` / `serviceTier`。当前 `config.toml` 只代表当前默认配置，不用于反推历史请求。
- 不读取 ChatGPT OAuth 额度百分比。
- 不接 OpenAI 组织级 Usage / Costs API。
- 不读取 `logs_2.sqlite`。

更多细节：

- [docs/data-source-audit.md](docs/data-source-audit.md)
- [docs/official-openai-usage.md](docs/official-openai-usage.md)
- [docs/monitoring-research.md](docs/monitoring-research.md)

## License

MIT，见 [LICENSE](LICENSE)。
