# Codex Token Monitor 数据源与统计口径审计

审计时间：2026-07-10

## 结论

当前看板只有一个主数据源：Codex session JSONL 的 `token_count.last_token_usage`。

Web 服务会把这个主数据源按需同步到本项目自己的轻量统计库 `data/codex-token-monitor.sqlite`。这个 SQLite 是派生缓存 / 查询账本，不是新的外部数据源；删除后可以从 session JSONL 重建。

已剔除 `logs_2.sqlite`、raw SSE 和 OTel。原因很直接：当前机器的 `logs_2.sqlite` 只有极少历史 response 记录，且用户已经通过 trigger 阻止它继续写入；继续把它作为增强源会让页面出现“只有 4 条”的错误感知，收益低于口径复杂度。

## 数据源总表

| 数据源 | 本地位置 / 事件 | 当前用途 | 是否主 token 口径 | 可用字段 | 禁止用途 |
| --- | --- | --- | --- | --- | --- |
| Codex session token_count | `C:\Users\Administrator\.codex\sessions\YYYY\MM\DD\*.jsonl`，`event_msg` / `payload.type='token_count'` | 请求明细主表、token 聚合、分页、时间维度汇总 | 是 | `info.last_token_usage.input_tokens`、`cached_input_tokens`、`output_tokens`、`reasoning_output_tokens`、`total_tokens`、`model_context_window`、事件 timestamp | 不把 `total_token_usage` 当窗口请求消耗 |
| 本项目本地统计库 | `data/codex-token-monitor.sqlite` | Web 查询、分页、看板汇总 | 否，派生账本 | session token_count 的规范化结果、去重 key、请求耗时估算、首输出估算、流式迹象、错误事件 | 只在页面 / API 请求时检查 session 文件变化并增量写入 |
| 费率配置 | `pricing.json` | 消耗金额本地估算 | 否，估算配置 | 每百万 token 的 input / cached input / cache write / output 费率、长上下文倍率；包含 GPT-5.6 Sol / Terra / Luna | 不能当作官方账单或扣费凭证 |
| Codex session metadata | 同 JSONL，`session_meta` / `turn_context` / `task_started` / `task_complete` / `response_item` | 来源、cwd、模型、耗时估算、请求级服务档位 | 否 | `id`、`cwd`、`source`、`thread_source`、`originator`、`model_provider`、`cli_version`、`turn_context.model`、`turn_context.effort`、请求级 `service_tier`（如果 session 写出）、本地 task 时间、`response_item` 时间 | 不读取消息正文做请求内容预览；不伪装成官方响应字段；不使用当前 `config.toml` 反推历史请求 |

## 已剔除数据源

| 数据源 | 状态 | 原因 |
| --- | --- | --- |
| `logs_2.sqlite` raw SSE | 不读取 | 当前只有极少历史记录，且用户已阻止继续写盘；继续使用会让统计口径失真 |
| `codex_otel.trace_safe` / `codex_otel.log_only` | 不读取 | 依赖 SQLite 日志；不作为本地请求明细主账本 |
| OpenAI Admin Usage / Costs API | 不接入 | 组织级 bucket 聚合，不是本机 Codex 请求明细；当前金额只做本地 token 费率估算 |
| OAuth / 个人资料额度 / IP | 不使用 | 不读 `auth.json`；不反代；不抓包；不反推历史 IP |

## 当前请求字段合同

| 看板字段 | 主来源 | 说明 |
| --- | --- | --- |
| 记录 ID | 本地生成 `session-token-...` | 用于分页和详情定位 |
| 会话 ID | `session_meta.id` | 放在详情和来源上下文 |
| 记录时间 | `token_count` 事件 timestamp | 用于日 / 周 / 自定义时间归窗 |
| 输入 token | `last_token_usage.input_tokens` | 本次 token_count 的 last usage |
| 缓存 token | `last_token_usage.cached_input_tokens` | 输入 token 子集 |
| 输出 token | `last_token_usage.output_tokens` | 本次输出 token |
| Reasoning token | `last_token_usage.reasoning_output_tokens` | 输出 token 子集 |
| 总 token | `last_token_usage.total_tokens` | 当前请求记录主加总字段 |
| 模型 | 最近 `turn_context.model` | session 本地上下文 |
| 服务档位 / Fast | 请求级 `service_tier` / `serviceTier`（如果 session JSONL 写出） | 只在有请求级字段时前端展示；`fast` 或 `priority` 标记为 Fast；`config.toml` 当前配置不回填历史 |
| 状态 | `token_count` / `event_msg.error` | 前端只显示“成功 / 失败”；失败悬浮展示 `error_reason`；`last_token_usage` 只有总 token、缺少输入/输出明细时记为失败/异常记录 |
| 来源 | `session_meta.source/originator/model_provider/cwd` | 本地来源补充 |
| 本地响应耗时估算 | `token_count.timestamp - 最近 user/tool/output 边界` | 字段为 `request_duration_ms_estimate`；不是官方响应耗时；超过 10 分钟的陈旧边界排除 |
| 首输出估算 | `首个 response_item.timestamp - 最近 user/tool/output 边界` | 字段为 `first_output_ms_estimate`；不是官方 TTFT |
| 输出形态 | `token_count` 前的 `response_item_count` | API 内部保留本地迹象；前端默认不展示；不是官方 `stream` 参数 |
| 消耗金额 | `pricing.json` + token usage | 本地估算：普通输入、缓存读取、缓存写入、输出分别按费率计算；GPT-5.6 缺少 `cache_write_tokens` 时只给费用下限；不是官方账单 |
| 本地 turn 总耗时 | `task_complete.timestamp - task_started.timestamp` | 字段为 `turn_duration_ms_estimate`；只在能配到 `task_complete` 时存在 |

## 当前不可用字段

| 字段 | 结论 |
| --- | --- |
| 官方 response status | 不可用；已剔除 raw SSE，session token_count 不提供 |
| 官方 created_at / completed_at | 不可用；当前只保留 session token_count timestamp |
| 官方首 token / TTFT | 不可用；session token_count 不提供流式 token delta 时间。当前只做首 `response_item` 本地估算 |
| 官方 stream=true/false | 不可用；当前只做本地 `response_item_count` 流式迹象 |
| 官方账单金额 | 不可用；当前金额为 `pricing.json` 本地估算 |
| GPT-5.6 缓存写入 token | 当前本机 session `last_token_usage` 未提供；后端兼容 `cache_write_tokens` / `input_tokens_details.cache_write_tokens`，缺失时费用标记为下限，不推断具体写入量 |
| 官方工具用量 | 不可用；session token_count 不提供官方 tool_usage |
| 官方错误原因 | 不可用；session token_count 不提供 response.error / incomplete_details |
| 历史请求 Fast 开关 | 不可用，除非 session JSONL 为该请求写出 `service_tier` / `serviceTier`；当前 `config.toml` 只能说明当前默认设置，不能证明历史每条请求 |
| 请求来源 IP | 不可用；session JSONL 没有该字段 |

## 去重规则

session 中 `token_count` 可能重复写入同一次 `last_token_usage`。当前按以下 key 去重：

```text
session_id + last_token_usage_tuple + total_token_usage_snapshot_tuple
```

这个规则会去掉同一 session 内 `last_token_usage` 和 `total_token_usage` 累计快照都完全相同的重复事件。相比只按 `last_token_usage` 去重，它降低了“两次真实请求 token 数碰巧一样”被合并的概率。

## 当前 API 输出合同

`/api/data` 返回：

| 字段 | 说明 |
| --- | --- |
| `summary.request_records` | 时间窗口内 session token_count 去重记录数 |
| `summary.session_token_count_records` | 同上，用于明确来源 |
| `summary.request_usage` | 仅按 `last_token_usage` 聚合 |
| `buckets[]` | 按 `bucket=hour/day/week` 归窗后的记录数和 token 汇总 |
| `data_quality.primary_records` | `codex_session_token_count_events` |
| `data_quality.token_usage` | `codex_session_last_token_usage` |
| `data_quality.excluded_sources` | `logs_2.sqlite`、`raw_sse`、`codex_otel` |
| `data_quality.duration_ms_estimate` | `local_observed_model_request_start_to_token_count` |
| `data_quality.first_output_ms_estimate` | `local_observed_model_request_start_to_first_response_item` |
| `data_quality.stream_observed` | `local_response_item_count_before_token_count_not_official_stream_flag` |
| `data_quality.service_tier` | `codex_session_request_service_tier_when_present_no_current_config_backfill` |
| `data_quality.cost_estimate` | `local_token_rate_estimate_cache_write_lower_bound_when_usage_missing` |
| `data_quality.turn_duration_ms_estimate` | `local_session_task_started_to_task_complete` |
| `pagination` | `page`、`page_size`、`total_records`、`total_pages` |
| `requests[]` | 当前页请求明细 |

## 排除项

- 官方账单金额。
- API key 用量统计。
- ChatGPT OAuth 额度百分比。
- `logs_2.sqlite`、raw SSE、OTel。
- `total_token_usage` 作为窗口消耗。
- 官方 `stream=true/false` 参数。
- 当前 `config.toml` 反推历史 Fast 状态。
- 请求来源 IP。
- 完整消息正文或 assistant 输出正文。
