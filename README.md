# Codex Token 本地监控看板

## 目录说明

这是一个独立任务目录。默认不要把本目录与其他根级任务目录混读，除非用户明确要求。

## 任务元数据

- 目录名：2026-06-23-codex-token-monitor
- 创建时间：2026-06-23 17:22:11
- 当前状态：local_sqlite_session_token_ledger
- 任务类型：general

## 任务范围

- 构建一个本地常驻 Web 看板，监听 `127.0.0.1:4127`。
- 当前阶段做“session token 请求明细表 + 分页 + 本项目本地统计库”。
- 主数据源使用本机 Codex session JSONL：
  - `C:\Users\Administrator\.codex\sessions\YYYY\MM\DD\*.jsonl`
  - `event_msg` / `payload.type='token_count'`
  - `payload.info.last_token_usage`
- 已剔除 Codex 的 `logs_2.sqlite` / raw SSE / OTel 数据源；Web 看板和脚本都不读取 Codex 日志 SQLite。
- Web 看板会维护本项目自己的轻量统计库：`data/codex-token-monitor.sqlite`。该库只保存从 session JSONL 解析出的规范化记录，可删除后重建。
- 不读取 `~\.codex\auth.json` 明文 token；不做抓包、反代或 OAuth 中间人。
- 不做 API key 用量统计、个人资料额度百分比、IP 反推。
- 费用是本地估算：按 `pricing.json` 中的官方公开 token 费率，用 session token 数计算，不等同于 OpenAI 账单。

## 关键文件

- `server.js`：本地 HTTP 服务、按需 session token 采集器、本项目 SQLite 统计库查询层。
- `public/index.html`：请求明细看板页面。
- `public/styles.css`：看板样式。
- `public/app.js`：前端渲染、当前页过滤、分页和导出逻辑。
- `pricing.json`：公开 token 费率配置；费用估算会读取这个文件。
- `scripts/codex-token-report.mjs`：可独立分发的本地 Codex token 统计脚本，无第三方依赖。
- `scripts/codex-token-report.ps1` / `.cmd`：Windows 下调用独立统计脚本的轻量包装。
- `docs/data-source-audit.md`：session 主口径和排除项审计。
- `docs/official-openai-usage.md`：OpenAI Responses 单次请求官方返回字段说明。
- `docs/monitoring-research.md`：官方与社区监控方案调研。
- `scripts/start.ps1`：前台启动。
- `scripts/start-hidden.ps1`：后台隐藏启动。
- `scripts/stop.ps1`：停止本地服务。
- `scripts/install-startup-task.ps1`：安装当前用户登录自启计划任务。
- `scripts/uninstall-startup-task.ps1`：卸载登录自启计划任务。

## 相关会话 / Codex Resume

- 会话 1：codex resume 019ef3ad-7c31-7fc3-a89d-a600be2d17ba

## 当前统计口径

- 请求记录：来自 session JSONL 的 `token_count` 事件。
- 本地统计库：`/api/data` 被请求时，先检查 session JSONL 的 size / mtime，只解析新增或变化文件，并把去重后的记录写入 `data/codex-token-monitor.sqlite`；没有后台 tail，不持续写盘。
- Token：来自 `payload.info.last_token_usage`。
- 缓存 token：`cached_input_tokens`，是输入 token 子集，不额外加总。
- Reasoning token：`reasoning_output_tokens`，是输出 token 子集，不额外加总。
- 总 token：`last_token_usage.total_tokens`。
- 响应时间戳：`token_count` 事件 timestamp。
- 状态：`success` 表示 session 已记录该 token 事件；`failed` 来自 session `event_msg/error`，错误原因保存在 `error_reason`。
- 实际模型：优先使用同 session 内最近的 `turn_context.model`。
- 本地响应耗时估算：最近 user/tool/output 边界到 `token_count.timestamp`，字段为 `request_duration_ms_estimate`，不是官方服务端耗时；超过 10 分钟的陈旧边界会被排除。
- 首输出估算：同一模型请求中第一个 `response_item` 减去最近 user/tool/output 边界，字段为 `first_output_ms_estimate`；这不是官方 TTFT。
- 输出形态：前端只显示“流式 / 非流式”。当前本地判断依据是同一 `token_count` 前观察到的 `response_item_count`，`>1` 记为“流式”；这不是官方 `stream=true/false` 字段。
- 消耗金额：按 `pricing.json` 里的每百万 token 费率估算。公式为未缓存输入 token * input rate + 缓存输入 token * cached input rate + 输出 token * output rate。
- `total_token_usage`：只作为详情里的会话累计快照，不参与请求窗口加总。
- 去重：默认按 `session_id + last_token_usage_tuple + total_token_usage_snapshot_tuple` 去重；如需原始事件审计，独立脚本可使用 `--no-dedupe`。

## 已排除功能

- API key 用量统计。
- OpenAI Admin Usage / Costs API 接入。
- ChatGPT OAuth 额度百分比读取。
- `logs_2.sqlite` / raw SSE / OTel 历史增强。
- `total_token_usage` / session 累计 token 作为主指标。
- 官方 response status、首 token、工具用量。当前主数据源 session JSONL 不稳定提供这些字段。
- 官方 streaming 参数。当前只保留本地 `response_item` 流式迹象。
- 单请求来源 IP。当前主数据源没有这个字段。

## 本地接口

- `/api/health`：返回 `ok: true`，`sessions_dir_exists`，`data_source`，本项目 `local_db_file`。
- `/api/data`：按需同步变化的 session JSONL 到本项目 SQLite，然后返回 session token 请求聚合、请求明细、分页信息。
- `/api/data` 也返回 `buckets[]`，按当前 `bucket` 参数输出小时 / 日 / 周汇总。
- `/api/data` 分页参数：
  - `page`：页码，默认 `1`。
  - `page_size`：每页数量，默认 `7`，当前限制 `5` 到 `100`。
  - `start_ms` / `end_ms`：时间窗口，按 session `token_count` 事件时间筛选。

## 独立统计脚本

脚本不依赖 Web 服务，不读 `logs_2.sqlite`，默认只读 `~/.codex/sessions`。Node.js 18+ 可运行。Web 看板使用 Node.js 内置 `node:sqlite`，需要 Node.js 24+。

```powershell
node .\scripts\codex-token-report.mjs --today --format table
node .\scripts\codex-token-report.mjs --days 7 --format json --out codex-usage.json
node .\scripts\codex-token-report.mjs --start 2026-06-01 --end 2026-06-24 --format csv --out codex-records.csv
.\scripts\codex-token-report.ps1 --today --format table
.\scripts\codex-token-report.cmd --days 7 --format csv --redact-paths --out codex-records.csv
```

通过 npm 也可以：

```powershell
npm run report -- --today --format table
```

主要参数：

| 参数 | 说明 |
| --- | --- |
| `--codex-home <dir>` | 指定 Codex home；默认 `CODEX_HOME` 或 `~/.codex` |
| `--today` / `--days <n>` / `--all` | 时间范围 |
| `--start <time>` / `--end <time>` | 自定义时间范围，支持毫秒、ISO、`YYYY-MM-DD` |
| `--format table/json/csv` | 输出格式 |
| `--bucket hour/day/week/none` | 汇总粒度 |
| `--limit <n>` / `--page <n>` / `--page-size <n>` | 记录分页 |
| `--no-dedupe` | 保留重复 `token_count` 事件 |
| `--redact-paths` | 输出前隐藏本地 cwd / session 文件路径，方便分享报告 |
| `--out <file>` | 写入文件 |

## 快速分发部署

把本目录发给别人时，最小必需文件是：

- `server.js`、`public/`、`scripts/start*.ps1`、`scripts/stop.ps1`、`package.json`：Web 看板，Node.js 24+。
- `pricing.json`：费用估算费率配置。
- `scripts/codex-token-report.mjs`
- Windows 可选：`scripts/codex-token-report.ps1`、`scripts/codex-token-report.cmd`
- 说明文档：`README.md`、`docs/monitoring-research.md`、`docs/data-source-audit.md`

如果只跑 CLI， 对方机器只需要已有 Codex session 日志和 Node.js 18+：

```powershell
.\scripts\codex-token-report.ps1 --today --format table
.\scripts\codex-token-report.ps1 --days 30 --bucket day --format json --redact-paths --out codex-usage.json
```

## 操作

- 前台运行：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1`
- 后台常驻：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-hidden.ps1`
- 安装登录自启：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup-task.ps1`
- 打开：`http://127.0.0.1:4127`
- 停止：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1`

## 交接说明

下一步如果继续扩展日 / 周 / 自定义维度看板，默认以 session `token_count` 事件时间归窗，并且只能聚合 `last_token_usage`。不要再接入 `logs_2.sqlite`；这条数据源样本太少且用户已明确要求剔除。
