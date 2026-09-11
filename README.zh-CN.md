# Codex Token Monitor

中文说明 | [English](README.md) | [更新日志](CHANGELOG.md)

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
- 支持 GPT-6 Astra、GPT-5.6 Sol / Terra / Luna 的标准、Fast 和 Flex 费率，兼容 `gpt-5.6` 别名。
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

安装计划任务后，Windows 持续托管 `scripts/run-supervised.ps1`：Node 退出后约 5 秒重新启动；托管脚本异常退出时，计划任务间隔 1 分钟重试（最多 999 次）。任务没有运行时长上限，登录后自动启动。此机制处理进程退出，不会主动终止占用端口的进程，也不检测服务卡死。`scripts/stop.ps1` 会先停止托管任务，避免手动停止后立即重启。

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

从 v0.4.0 起，同时扫描当前 `CODEX_HOME` 下的 `sessions/` 与 `archived_sessions/`。按逻辑会话合并两处文件并去重，归档、恢复归档及重复刷新不会重复计数；仍缺少原始文件的历史入库记录予以保留。文件解析失败时保留原数据，下次刷新重试。大型日志逐行读取，首次升级会重新索引现有文件。 日志索引在后台进程执行，页面先显示已入库数据并提示更新状态；SQLite 使用 WAL，避免后台写入阻塞查询。

统计仅覆盖本机这些日志可见的模型调用，不能保证包含其他设备、其他 CODEX_HOME 或日志未记录的调用。

主数据源：

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
~/.codex/archived_sessions/*.jsonl
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
| 状态 | 正常请求级 `token_count`、明确的 `event_msg/error` | 只显示成功 / 失败 |
| 错误原因 | `event_msg/error.payload.message` | 没有明确原因时不编造 |
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

`last_token_usage.total_tokens > 0`，但输入、缓存、输出全是 `0` 的事件不会算作请求，也不会算作失败。实际 session 审计表明，这类事件会由上下文压缩、turn abort 或 thread rollback 产生，只代表 Codex 内部状态维护，缺少请求级 usage 拆分。

如果 session JSONL 没有写 HTTP status 或错误码，本项目不会推断 `429`、`500` 或网络错误。

## 费用口径

服务档位缺失或为 `auto` 的请求仍按标准价提供参考估算，但标记为“档位未知，按标准价估算”；汇总显示这类记录数，明细提示实际费用可能不同。这类金额不视为完整计价，也不保证是费用下限。

费用来自 `pricing.json` 的本地估算。GPT-6 Astra / GPT-5.6 的完整公式是：

```text
普通输入 token * input rate
+ 缓存读取 token * cached input rate
+ 缓存写入 token * cache write rate
+ 输出 token * output rate
```

注意：

- `reasoning_output_tokens` 已包含在输出 token 中，不重复加总。
- `cached_input_tokens` 已包含在输入 token 中，不重复加总。
- GPT-6 Astra / GPT-5.6 的缓存写入按对应服务档位的官方 `cache write` 费率计费。若 session 没有提供 `cache_write_tokens`，金额标记为下限。
- `thread_settings_applied.thread_settings.service_tier=priority/fast` 按 Fast / Priority 官方费率；`default/standard` 按标准费率。档位会沿用到后续的请求级 `token_count`。
- GPT-6 Astra / GPT-5.6 在标准、Fast 和 Flex 档位超过 `272K` 输入 token 时，整条请求切换对应的长上下文费率。未配置费率的模型或服务档位保持未计价，不回退为标准价。
- 只有总 token、没有输入/输出拆分的异常记录不计入已计价记录。
- 这不是 OpenAI 官方账单，也不是 billing API 返回值。

费率核对日期：**2026-09-07**。模型 ID `gpt-6-astra` 使用 Astra 费率，`gpt-5.6` 按 Sol 费率解析；兼容大小写及 `(xhigh)`、`-max` 等已知推理强度后缀，保留原始模型名称用于展示。未知 GPT-6 变体不会自动套用 Astra 价格。

所有历史请求也按当前价格快照重新估算，不还原历史账单价格。GPT-5.6 Sol 当前为促销价格，官方说明至少持续至 2026-11-21，届时需要重新核对。估算不包含区域处理附加费及非 token 工具费用。

| 模型 | 标准输入 | 缓存读取 | 缓存写入 | 输出 |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | $10 | $1 | $12.5 | $50 |
| GPT-5.6 Sol | $4 | $0.4 | $5 | $20 |
| GPT-5.6 Terra | $2 | $0.2 | $2.5 | $12 |
| GPT-5.6 Luna | $0.2 | $0.02 | $0.25 | $1.2 |

单位：美元 / 百万 token，表内为短上下文标准价。上述模型的 Fast 为对应标准价 2 倍，Flex 为 0.5 倍；长上下文输入及缓存费率为短上下文 2 倍，输出为 1.5 倍。来源：[OpenAI 官方价格](https://developers.openai.com/api/docs/pricing)、[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)。

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
| `page_size` | `6` | 每页条数，限制 `5..100` |
| `bucket` | `day` | `hour`、`day`、`week` |

## 本地 SQLite

Web 看板维护一个派生 SQLite：

```text
data/codex-token-monitor.sqlite
```

同步模式：

1. 页面或 API 请求 `/api/data`。
2. 服务扫描 `sessions/**/*.jsonl` 和 `archived_sessions/**/*.jsonl`。
3. 比较文件 `size`、`mtime` 与解析器版本。
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
- 只有 session JSONL 写出 `thread_settings.service_tier` / `serviceTier` 的时段能判断 Fast；当前 `config.toml` 不用于反推历史请求。
- 不读取 ChatGPT OAuth 额度百分比。
- 不接 OpenAI 组织级 Usage / Costs API。
- 不读取 `logs_2.sqlite`。

更多细节：

- [docs/data-source-audit.md](docs/data-source-audit.md)
- [docs/official-openai-usage.md](docs/official-openai-usage.md)
- [docs/monitoring-research.md](docs/monitoring-research.md)

## License

MIT，见 [LICENSE](LICENSE)。
