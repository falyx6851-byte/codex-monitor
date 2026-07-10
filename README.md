# Codex Token Monitor

[中文说明](README.zh-CN.md) | English

Local Codex token and request monitoring dashboard.

This project reads Codex session JSONL files from your local machine, normalizes token usage records into a local SQLite database, and serves a dashboard at `http://127.0.0.1:4127`.

The pricing configuration supports GPT-5.6 Sol, Terra, Luna, and the `gpt-5.6` alias.

It is intentionally local-first:

- No reverse proxy.
- No packet capture.
- No OAuth token reading.
- No `logs_2.sqlite` dependency.
- No OpenAI API key billing lookup.
- No request IP inference.

## Screenshot

The dashboard shows request records, token totals, cache hit rate, estimated cost, first-output estimate, and response-duration estimate. It is designed for a local laptop viewport with the page shell fixed to one screen and the request table scrolling internally.

## Requirements

| Component | Requirement |
| --- | --- |
| Codex | Local Codex session logs under `~/.codex/sessions` or `%USERPROFILE%\.codex\sessions` |
| Web dashboard | Node.js 24+ because it uses `node:sqlite` |
| Standalone report script | Node.js 18+ |
| Windows helpers | PowerShell |

The default Codex home is:

- Windows: `%USERPROFILE%\.codex`
- macOS / Linux: `~/.codex`

You can override it with:

```bash
CODEX_HOME=/path/to/.codex npm start
```

## Quick Start

Clone the repository:

```bash
git clone https://github.com/falyx6851-byte/codex-monitor.git
cd codex-monitor
```

Run the dashboard:

```bash
npm start
```

Open:

```text
http://127.0.0.1:4127
```

The first load scans changed session JSONL files and creates:

```text
data/codex-token-monitor.sqlite
```

`data/` is ignored by Git and is safe to delete. It will be rebuilt from local session files.

## Windows Helpers

Foreground:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

Hidden background service:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-hidden.ps1
```

Stop:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1
```

Install current-user logon startup task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup-task.ps1
```

Uninstall startup task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-startup-task.ps1
```

## macOS / Linux Notes

The core server and report script are not Windows-specific. If Codex writes session JSONL files under `~/.codex/sessions`, the dashboard should work with:

```bash
npm start
```

What is Windows-specific:

- `scripts/*.ps1`
- `scripts/*.cmd`
- scheduled-task startup installation

For macOS autostart, use your own `launchd` plist or another local process manager. This repository does not ship a macOS autostart wrapper yet.

## Standalone Report Script

The report script reads session JSONL directly and does not require the web server or SQLite database.

```bash
node scripts/codex-token-report.mjs --today --format table
node scripts/codex-token-report.mjs --days 7 --format json --out codex-usage.json
node scripts/codex-token-report.mjs --start 2026-06-01 --end 2026-06-24 --format csv --redact-paths --out codex-records.csv
```

Windows wrappers:

```powershell
.\scripts\codex-token-report.ps1 --today --format table
.\scripts\codex-token-report.cmd --days 7 --format csv --redact-paths --out codex-records.csv
```

Main options:

| Option | Description |
| --- | --- |
| `--codex-home <dir>` | Codex home directory. Defaults to `CODEX_HOME` or `~/.codex` |
| `--today`, `--days <n>`, `--all` | Time range |
| `--start <time>`, `--end <time>` | Custom range. Supports milliseconds, ISO strings, and `YYYY-MM-DD` |
| `--format table/json/csv` | Output format |
| `--bucket hour/day/week/none` | Aggregation bucket |
| `--limit <n>`, `--page <n>`, `--page-size <n>` | Record pagination |
| `--no-dedupe` | Keep duplicate `token_count` events |
| `--redact-paths` | Hide local cwd and session file paths before sharing |
| `--out <file>` | Write output to a file |

## Data Sources

Primary source:

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

The main request records come from:

```text
row.type = "event_msg"
row.payload.type = "token_count"
row.payload.info.last_token_usage
```

Relevant session fields:

| Metric | Source | Notes |
| --- | --- | --- |
| Input tokens | `last_token_usage.input_tokens` | Official token field as recorded in local session JSONL |
| Cached input tokens | `last_token_usage.cached_input_tokens` | Subset of input tokens; not added again to total |
| Output tokens | `last_token_usage.output_tokens` | Output side of the request |
| Reasoning output tokens | `last_token_usage.reasoning_output_tokens` | Subset of output tokens; not added again to total |
| Total tokens | `last_token_usage.total_tokens` | Main per-record total |
| Model | Latest local `turn_context.model` | Local session context |
| Timestamp | `token_count.timestamp` | Local session event timestamp |
| Status | normal request-level `token_count`, explicit `event_msg/error` | Displayed as success / failed |
| Error reason | `event_msg/error.payload.message` | Not fabricated when unavailable |
| Cost estimate | `pricing.json` + token usage | Local estimate, not official billing |
| First output estimate | local boundary to first `response_item` | Not official TTFT |
| Response duration estimate | local boundary to `token_count` | Not server-side latency |

Excluded sources:

| Source | Reason |
| --- | --- |
| `~/.codex/logs_2.sqlite` | Not used; can be noisy and write-heavy |
| raw SSE stream | Not used; avoids proxy/capture design |
| OpenTelemetry traces | Not used |
| `~/.codex/auth.json` | Not read |
| OpenAI Admin Usage / Costs API | Not used |

## Status and Error Semantics

The dashboard only shows:

- `success`
- `failed`

`failed` means one of:

- The session contains an explicit `event_msg/error`.

Events where `last_token_usage.total_tokens > 0` but input/cache/output are all `0` are not requests and are not failures. Auditing real session sequences shows that Codex emits these breakdownless token events during context compaction, turn abort, or thread rollback. They are excluded from request counts, costs, status totals, and period analytics.

If no explicit HTTP status or error code is present in the session JSONL, the project does not invent one. In particular, it does not infer `429`, `500`, or network failure unless Codex wrote that information into the session.

## Cost Semantics

Costs are estimates from `pricing.json`. The complete GPT-5.6 formula is:

```text
regular_input_tokens * input_rate
+ cache_read_tokens * cached_input_rate
+ cache_write_tokens * cache_write_rate
+ output_tokens * output_rate
```

Notes:

- `reasoning_output_tokens` is already included in output tokens.
- `cached_input_tokens` is already included in input tokens.
- GPT-5.6 cache writes are billed at `1.25x` the regular input rate. If a Codex session does not expose `cache_write_tokens`, the UI prices the unknown portion at the regular input rate; the remaining difference is cache-write tokens multiplied by the cache-write rate minus the regular input rate.
- Current Codex model metadata reports a `372,000` total GPT-5.6 context window and a `95%` effective window, producing the session value `model_context_window=353,400`. OpenAI's current GPT-5.6 pricing table has no long-context surcharge tier, so this project does not switch GPT-5.6 to a higher rate above `272K`.
- Records without input/output breakdown are not counted as priced records.
- This is not an OpenAI invoice or billing API result.

Configured models are `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; the official `gpt-5.6` alias resolves to Sol pricing. Rate source: `https://developers.openai.com/api/docs/pricing`.

## API

Health:

```text
GET /api/health
```

Data:

```text
GET /api/data
```

Query parameters:

| Parameter | Default | Description |
| --- | --- | --- |
| `start_ms` | today start in UI | Unix milliseconds |
| `end_ms` | now | Unix milliseconds |
| `page` | `1` | Page number |
| `page_size` | `7` | Page size, clamped to `5..100` |
| `bucket` | `day` | `hour`, `day`, or `week` |

## Local Database

The web dashboard maintains a derived SQLite database:

```text
data/codex-token-monitor.sqlite
```

Ingestion is on-demand:

1. `/api/data` is requested.
2. The server scans `sessions/**/*.jsonl`.
3. It compares file `size` and `mtime`.
4. Only changed files are parsed.
5. Normalized records are inserted into local SQLite.

There is no background tailer and no continuous write loop.

## Repository Layout

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

## Privacy

This tool reads local Codex session files. Those files may include prompts, outputs, local paths, and tool-call context. Do not publish your generated `data/` directory or exported reports unless you have reviewed and redacted them.

The repository `.gitignore` excludes:

```text
data/
*.sqlite
*.sqlite-shm
*.sqlite-wal
.env
.env.*
```

## Limitations

- No official per-request HTTP status unless the session JSONL contains it.
- No official TTFT.
- No request IP.
- No historical per-request Fast state unless the session JSONL writes `service_tier` / `serviceTier` for that request. The current `config.toml` only describes the current default and is not used to backfill historical requests.
- No ChatGPT OAuth quota percentage.
- No OpenAI organization usage/cost API integration.
- No `logs_2.sqlite` ingestion.

For detailed source auditing, see:

- [docs/data-source-audit.md](docs/data-source-audit.md)
- [docs/official-openai-usage.md](docs/official-openai-usage.md)
- [docs/monitoring-research.md](docs/monitoring-research.md)

## License

MIT. See [LICENSE](LICENSE).
