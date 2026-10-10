# Codex Token Monitor

[中文说明](README.zh-CN.md) | English | [Changelog / 更新日志](CHANGELOG.md)

Local Codex token and request monitoring dashboard.

This project reads Codex session JSONL files from your local machine, normalizes token usage records into a local SQLite database, and serves a dashboard at `http://127.0.0.1:4127`.

The pricing configuration supports GPT-6.1 Sol, GPT-6 Astra / Sol / Luna, and GPT-5.6 Sol / Terra / Luna with Standard, Fast, and Flex rates, plus the `gpt-5.6` alias. GPT-6.1 Sol and GPT-6 Astra also support Ultrafast pricing.

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

The startup task keeps `scripts/run-supervised.ps1` running under Windows Task Scheduler. Node is restarted about 5 seconds after exit; supervisor failures retry after 1 minute (up to 999 times). The task has no execution time limit and starts at logon. This handles process exits, not hung servers, and never kills another port listener. `scripts/stop.ps1` stops supervision before stopping Node.

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

### v0.5.0 query and accounting rules

- The first session header identifies the file. Inherited subagent history is excluded; response IDs provide deduplication with legacy counter/event fallbacks.
- Prefer `token_usage_record.payload.usage`, with `event_msg/token_count` fallback. The dashboard and CLI share one parser.
- Model-output boundaries exclude subsequent tool waits; unavailable timing remains unknown.
- Today, Yesterday, 7 days and 30 days are recomputed on each query. Ranges include start and exclude end; Yesterday is the previous local calendar day.
- Filtering and pagination read the index. Manual/120-second refresh starts background indexing and automatically reloads the completed result.
- Export All JSON streams every record in range from one consistent database snapshot. Unpriced costs remain unknown.
- SQLite aggregates stored pricing columns and fetches only the requested detail page; bounded range caches follow database revisions. Restart and refresh after changing rates.



Since v0.4.0, both `sessions/` and `archived_sessions/` under the current `CODEX_HOME` are scanned. Copies are merged by logical session and deduplicated across archive moves and repeated refreshes. Indexed history without original files is retained. Failed parsing preserves existing data and retries on refresh. Large logs are read incrementally; the first upgrade reindexes available originals. Indexing runs in a background process; the page serves indexed data and displays refresh status. SQLite WAL keeps reads available during ingestion.

Coverage is limited to model calls visible in these local logs, not other devices, other CODEX_HOME directories, or unlogged calls.

Primary source:

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
~/.codex/archived_sessions/*.jsonl
```

Legacy fallback records come from (new-format precedence is described above):

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
| Timestamp | response usage / last model output timestamp | Local session event timestamp |
| Status | normal request-level `token_count`, explicit `event_msg/error` | Displayed as success / failed |
| Error reason | `event_msg/error.payload.message` | Not fabricated when unavailable |
| Cost estimate | `pricing.json` + token usage | Local estimate, not official billing |
| First output estimate | local boundary to first `response_item` | Not official TTFT |
| Response duration estimate | local boundary to completed model output | Not server-side latency |

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

Requests with missing or `auto` service tiers retain a Standard-rate reference estimate, explicitly marked as assumed. The summary counts these records and detail tooltips disclose uncertainty. These estimates are neither complete nor guaranteed lower bounds.

Costs are estimates from `pricing.json`. The complete GPT-6.1 / GPT-6 / GPT-5.6 formula is:

```text
regular_input_tokens * input_rate
+ cache_read_tokens * cached_input_rate
+ cache_write_tokens * cache_write_rate
+ output_tokens * output_rate
```

Notes:

- `reasoning_output_tokens` is already included in output tokens.
- `cached_input_tokens` is already included in input tokens.
- GPT-6.1 / GPT-6 / GPT-5.6 cache writes use the official cache-write rate for the selected service tier. If a Codex session does not expose `cache_write_tokens` and the service tier is known, the estimate is marked as a lower bound.
- `thread_settings_applied.thread_settings.service_tier=priority/fast` uses official Fast rates; `default/standard` uses Standard rates. `ultrafast` uses its separately configured rates. The setting is carried forward to following request-level usage records.
- GPT-6.1 / GPT-6 / GPT-5.6 requests above `272K` input tokens use long-context rates for the entire request in Standard, Fast, and Flex. Ultrafast supports both context lengths for GPT-6.1 Sol and GPT-6 Astra. Unconfigured models or service tiers stay unpriced instead of falling back to Standard.
- Records without input/output breakdown are not counted as priced records.
- This is an API token-rate estimate, not an OpenAI invoice, ChatGPT subscription charge, credit usage, or quota measurement.

Current GPT-6.1 / GPT-6 / GPT-5.6 rates verified on **2026-10-10**. `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna` each resolve to their own rates; `gpt-5.6` resolves to GPT-5.6 Sol. Model matching accepts case differences and known effort suffixes such as `(xhigh)` and `-max`, while preserving the original display name. Unknown variants and undocumented aliases remain unpriced.

All requests, including historical requests, are revalued using the current pricing snapshot; historical billing rates are not reconstructed. GPT-5.6 Sol promotional pricing is available at least through 2026-11-21 and should be rechecked then. Regional processing uplifts and non-token tool fees are excluded.

| Model | Standard input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | $10 | $1 | $12.5 | $50 |
| GPT-6.1 Sol | $2 | $0.10 | $2.5 | $10 |
| GPT-6 Sol | $2 | $0.20 | $2.5 | $10 |
| GPT-6 Luna | $0.10 | $0.01 | $0.125 | $0.50 |
| GPT-5.6 Sol | $4 | $0.4 | $5 | $20 |
| GPT-5.6 Terra | $2 | $0.2 | $2.5 | $12 |
| GPT-5.6 Luna | $0.2 | $0.02 | $0.25 | $1.2 |

USD per million tokens, short-context Standard rates for the models above. Fast is 2x the applicable Standard rates and Flex is 0.5x. Ultrafast is 6x Standard for GPT-6.1 Sol and GPT-6 Astra only. Long context doubles input/cache rates and multiplies output rates by 1.5. GPT-6.1 Sol cache reads cost 5% of its uncached input rate; GPT-6 Sol uses 10%. Sources: [official pricing](https://developers.openai.com/api/docs/pricing), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).

After updating, restart the monitor and refresh the dashboard. Existing indexed records are revalued from their stored token counts using the new pricing snapshot, including records whose original session files are no longer available.

## API

Full export: `GET /api/export`, using the same time parameters. `refresh=0` reads the index; `refresh=1` starts indexing. Health checks never trigger indexing.


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
| `page_size` | `6` | Page size, clamped to `5..100` |
| `bucket` | `day` | `hour`, `day`, or `week` |

## Local Database

The web dashboard maintains a derived SQLite database:

```text
data/codex-token-monitor.sqlite
```

Ingestion is on-demand:

1. `/api/data` is requested.
2. The server scans `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl`.
3. It compares file `size`, `mtime`, and parser version.
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
- Fast can only be determined for periods where session JSONL writes `thread_settings.service_tier` / `serviceTier`; the current `config.toml` is not used to infer historical requests.
- No ChatGPT OAuth quota percentage.
- No OpenAI organization usage/cost API integration.
- No `logs_2.sqlite` ingestion.

For detailed source auditing, see:

- [docs/data-source-audit.md](docs/data-source-audit.md)
- [docs/official-openai-usage.md](docs/official-openai-usage.md)
- [docs/monitoring-research.md](docs/monitoring-research.md)

## License

MIT. See [LICENSE](LICENSE).
