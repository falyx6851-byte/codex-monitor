# Codex Token Monitor 数据源与统计口径审计

审计时间：2026-06-23 18:21:15 +08:00

## 结论先行

当前看板必须改成“请求级 token 为主、会话累计为辅”的统计模型。原因很直接：`.codex/sessions` 里的 `total_token_usage` 是单个 session 到某一时刻的累计值，不是任意时间窗口内的增量；如果用它做“今日 / 本周 / 自定义时间”的主指标，会系统性高估。

可作为主统计口径的数据源是 `logs_2.sqlite` 中的 Responses SSE `response.completed.response.usage`，以及 Codex OTel 里可去重的 `codex.sse_event response.completed` token 字段。它们都必须按请求完成时间落入窗口后再聚合。

`rate_limits` 可以展示“最近一次本地日志观察到的额度百分比”，但不是实时查询个人资料页。这里不读取 `~/.codex/auth.json`，不做反代，不劫持 OAuth 流程。

`source_ip` 当前不可观测。本机日志没有每次请求的上游出口 IP，官方 Responses usage 对象也不返回客户端出口 IP。页面只能显示“未记录”，不能伪造。

## 官方语义边界

### Codex 认证与计费

官方 Codex 文档说明 Codex 使用 OpenAI 模型时有两类登录方式：

- ChatGPT 登录：使用订阅 / workspace 权限 / Codex entitlement。
- API key 登录：走 OpenAI Platform 账号，按标准 API 价格计费。

因此：

- `auth_mode=ApiKey` 的请求可以做“API 价格估算”。
- `auth_mode=ChatGPT` 或 ChatGPT access token 的请求不能直接换算成真实美元账单，只能显示“API 等价估算”或“ChatGPT 额度消耗观察”。
- Codex fast mode 对 ChatGPT credits 有额外倍率；API key 不使用 fast mode credits。当前本机日志没有足够字段把每个请求可靠归因到 fast/standard credit 倍率，所以不能把 fast credit 余额消耗反推成账单。

参考来源：

- Codex Pricing：`https://developers.openai.com/codex/pricing`
- Codex Authentication：`https://developers.openai.com/codex/auth`
- Codex Speed / Fast mode：`https://developers.openai.com/codex/speed`
- API Pricing：`https://developers.openai.com/api/docs/pricing/`

### Responses API usage

Responses API 的完成响应 / `response.completed` 事件可返回 `response.usage`。本机原始 SSE 中已观测到这些官方 usage 字段：

- `usage.input_tokens`
- `usage.input_tokens_details.cached_tokens`
- `usage.output_tokens`
- `usage.output_tokens_details.reasoning_tokens`
- `usage.total_tokens`

统计含义：

- `input_tokens` 是输入 token 总数。
- `cached_tokens` 是输入 token 的缓存命中子集，不应额外加到 `total_tokens`。
- `output_tokens` 是输出 token 总数。
- `reasoning_tokens` 是输出 token 的 reasoning 子集，不应额外加到 `total_tokens`。
- `total_tokens` 正常应按 `input_tokens + output_tokens` 理解；若字段缺失，才可 fallback 到两者相加。

参考来源：

- Responses create：`https://developers.openai.com/api/reference/resources/responses/methods/create/`
- Responses streaming events：`https://developers.openai.com/api/reference/resources/responses/streaming-events/`
- Count input tokens：`https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count/`
- Prompt caching：`https://developers.openai.com/api/docs/guides/prompt-caching/`

### API rate limits

OpenAI API rate limits 使用 RPM、RPD、TPM、TPD 等指标。当前 Codex JSONL 里的 `rate_limits.primary/secondary.used_percent` 是 Codex 本地日志暴露的额度窗口百分比，不等同于官方 Platform API usage dashboard 的完整账单或全部限制状态。

参考来源：

- Rate limits：`https://developers.openai.com/api/docs/guides/rate-limits/`

## 本机数据源审计

### 数据源 A：`.codex/sessions/**/*.jsonl`

路径：

```text
C:\Users\Administrator\.codex\sessions\YYYY\MM\DD\*.jsonl
```

审计结果：

- 文件数：448
- JSONL 行数：337,608
- 解析失败行：0
- 时间范围：2026-02-23T05:34:21.053Z 到 2026-06-23T10:10:59.418Z
- `token_count` 事件数：67,317
- 有 token 事件的文件：385
- 无 token 事件的文件：63

主要 `row.type`：

- `session_meta`
- `turn_context`
- `event_msg`
- `response_item`
- `compacted`

主要 `payload.type`：

- `token_count`
- `user_message`
- `agent_message`
- `task_started`
- `task_complete`
- `function_call`
- `function_call_output`
- `web_search_call`
- `web_search_end`
- `exec_command_end`
- `patch_apply_end`
- `error`

可用字段：

- `session_meta`：`id`、`cwd`、`source`、`thread_source`、`originator`、`model_provider`、`cli_version`、`git.*`、`parent_thread_id`、`forked_from_id`。
- `turn_context`：`model`、`effort`、`approval_policy`、`sandbox_policy`、`permission_profile`、`current_date`、`timezone`、`workspace_roots`、`turn_id`。
- `event_msg token_count`：
  - `info.total_token_usage.input_tokens`
  - `info.total_token_usage.cached_input_tokens`
  - `info.total_token_usage.output_tokens`
  - `info.total_token_usage.reasoning_output_tokens`
  - `info.total_token_usage.total_tokens`
  - 同结构的 `info.last_token_usage`
  - `info.model_context_window`
  - `rate_limits.primary.used_percent`
  - `rate_limits.primary.window_minutes`
  - `rate_limits.primary.resets_at`
  - `rate_limits.secondary.used_percent`
  - `rate_limits.secondary.window_minutes`
  - `rate_limits.secondary.resets_at`
  - `rate_limits.credits.balance`
  - `rate_limits.credits.has_credits`
  - `rate_limits.credits.unlimited`
  - `rate_limits.plan_type`
  - `rate_limits.limit_name`
  - `rate_limits.individual_limit`

统计口径：

- `total_token_usage`：只能表示该 session 文件内截至该事件的累计 token。适合做“会话累计 / 诊断”，不适合做“今日消耗”。
- `last_token_usage`：表示某次 `token_count` 事件附带的 last usage，但当前日志没有稳定 Response ID 绑定。除非后续建立事件时间线和请求关联，否则不作为主请求统计。
- `rate_limits`：展示最新观测值时必须按事件 timestamp 取最大值，不能按文件遍历顺序覆盖。
- `user_message` / `agent_message`：可做输入输出摘要，但不能保证与单个 `response.completed` 精确一一对应。当前只应标注为“附近消息摘要”。

### 数据源 B：`.codex/logs_2.sqlite`

路径：

```text
C:\Users\Administrator\.codex\logs_2.sqlite
```

`logs` 表结构：

- `id INTEGER`
- `ts INTEGER`
- `ts_nanos INTEGER`
- `level TEXT`
- `target TEXT`
- `feedback_log_body TEXT`
- `module_path TEXT`
- `file TEXT`
- `line INTEGER`
- `thread_id TEXT`
- `process_uuid TEXT`
- `estimated_bytes INTEGER`

主要 targets：

- `codex_api::sse::responses`
- `codex_otel.log_only`
- `codex_otel.trace_safe`
- `codex_app_server_transport::transport::remote_control::websocket`
- `codex_app_server::outgoing_message`
- `codex_tui::markdown_stream`
- `codex_core::session::turn`
- `codex_core::stream_events_utils`

#### B1：原始 SSE

target：

```text
codex_api::sse::responses
```

`feedback_log_body` 格式：

```text
SSE event: {...}
```

审计结果：

- `codex_api::sse::responses` 总行数：6,343
- `SSE event:%response.%` 行数：5,771
- SQL 匹配 `response.completed` 行数：42
- 采样解析到 `response.completed` 且带 usage：40

主要事件类型：

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.function_call_arguments.delta`
- `response.custom_tool_call_input.delta`
- `response.output_text.done`
- `response.output_item.done`
- `response.web_search_call.searching`
- `response.web_search_call.in_progress`
- `response.web_search_call.completed`
- `response.completed`
- `keepalive`

可用统计：

- 请求开始：`response.created.response.id`、`response.created.response.created_at`
- 请求结束：`response.completed.response.completed_at` 或日志时间
- 请求 token：`response.completed.response.usage`
- 模型：`response.*.response.model`
- 输出摘要：`response.completed.response.output`
- 首 token 估算：同一 response 的 `response.created` 日志时间到首个 `response.output_text.delta` 或 `response.function_call_arguments.delta` 日志时间

限制：

- 首 token 是本地日志估算，不是服务端官方 TTFT。
- 当前实现用全局 `activeId` 跟踪流，多个 response 交错时可能归错。应改成按 response id / sequence 维护状态；无法明确归因时不要给 TTFT。
- 原始 SSE 本身不包含 `conversation.id`、`auth_mode`、`originator` 等 Codex 来源字段，需要和 OTel 合并。

#### B2：Codex OTel

targets：

```text
codex_otel.log_only
codex_otel.trace_safe
```

`feedback_log_body` 格式：空格分隔 key/value，例如：

```text
event.name="codex.sse_event" event.kind=response.completed ...
```

审计结果：

- `response.completed` OTel 行数：117
- `codex_otel.log_only`：78
- `codex_otel.trace_safe`：39
- 带 `input_token_count` 的行：78
- 去重后 token-bearing completed 请求：39
- `trace_safe` 中带 `duration_ms` 的行：39

可用字段：

- `event.name`
- `event.kind`
- `event.timestamp`
- `conversation.id`
- `auth_mode`
- `originator`
- `app.version`
- `terminal.type`
- `model`
- `slug`
- `input_token_count`
- `cached_token_count`
- `output_token_count`
- `reasoning_token_count`
- `tool_token_count`
- `duration_ms`

当前观测值分布：

- `auth_mode`：`ApiKey`
- `originator`：`codex-tui`、`codex_sdk_go`
- `model` / `slug`：`gpt-5.5`
- `terminal.type`：`WindowsTerminal`、`unknown`

统计口径：

- OTel token 字段是请求级 completed 事件，适合作为 raw SSE 的补充。
- `codex_otel.log_only` 对同一 token-bearing completed 事件存在重复记录，必须按 `conversation.id + event.timestamp + model + token tuple` 去重。
- `codex_otel.trace_safe` 更适合补 `duration_ms`，但本次审计中不带 token 字段。
- OTel 字段是 Codex 本地 telemetry，不是 Responses API 官方 schema。页面应标注来源为 `otel` 或 `raw_sse+otel`。

## 指标合同

### 主看板指标

主看板只能使用窗口内“请求级 completed”记录聚合：

- 请求数：窗口内去重后的 completed 请求数。
- 输入 token：`usage.input_tokens` 或 `input_token_count`。
- 缓存 token：`usage.input_tokens_details.cached_tokens` 或 `cached_token_count`。它是输入 token 子集。
- 输出 token：`usage.output_tokens` 或 `output_token_count`。
- reasoning token：`usage.output_tokens_details.reasoning_tokens` 或 `reasoning_token_count`。它是输出 token 子集。
- 总 token：优先 `usage.total_tokens`；否则 `input + output`。
- 花费：仅当模型在 `pricing.json` 中配置了官方 API 单价才计算；ChatGPT auth 必须标注“非真实账单”。
- 平均耗时：优先 OTel `duration_ms`；其次 raw SSE `completed_at - created_at`；否则空。
- 首 token：只在 raw SSE 能明确绑定 response 时显示，并标注估算。

### 会话表 / 诊断指标

会话累计只放在诊断区域：

- session 数
- session 最后累计 token
- session 起止时间
- cwd / source / thread_source / model_provider
- token_count 事件数
- 是否无 token 事件

这些字段不能与主请求统计混用。

### 日 / 周 / 自定义时间维度

时间窗口必须以请求完成时间为准：

```text
completed_ms >= start_ms && completed_ms <= end_ms
```

如果请求没有 `completed_ms`，不能进入主 token 趋势。

会话趋势如果需要保留，必须命名为“会话累计结束时间分布”，不能叫“窗口消耗”。

### 请求来源

来源字段优先级：

1. OTel：`auth_mode`、`originator`、`terminal.type`、`app.version`
2. JSONL：按 `conversation.id` 关联 session 后补 `source`、`thread_source`、`model_provider`、`cwd`
3. 无法关联时显示 `unknown`

### IP

当前 contract：

```text
source_ip_available = false
source_ip = null
```

不允许用以下方式伪造“每请求 IP”：

- 查询本机公网 IP 后套到所有请求。
- 从网络连接当前状态反推历史请求。
- 读取浏览器个人资料页面或 OAuth token 后调用未公开接口。
- 做反代或抓包。

## 当前实现违反合同的位置

- `server.js` 当前把窗口内有重叠的 session 最后累计 token 作为 `summary.session_usage`，前端又把它显示为首屏主 token。这会严重高估任意时间窗口。
- `server.js` 的 `latestRateLimit` 由遍历顺序覆盖，没有按 timestamp 取最新。
- `server.js` 的 raw SSE 首 token 估算使用全局 `activeId`，不能应对交错流。
- `server.js` 只保留每个 session 最后 8 条消息，早期请求摘要会错配或缺失。
- `server.js` 每次 `/api/data` 全量扫描所有 JSONL 和 SQLite，当前“今日”接口曾耗时约 21.5s，不适合 30 秒自动刷新。
- `public/app.js` 的首屏 metrics 和图表使用 session buckets，不符合主指标合同。
- `public/app.js` 自动 30 秒刷新会放大后端全量扫描成本。

## 后续实现顺序

1. 后端改名：`summary.session_usage` 改为 `summary.session_cumulative_usage`，主指标改用 `summary.request_usage`。
2. 后端新增 `data_quality`：记录每项指标来自 `raw_sse`、`otel`、`raw_sse+otel`、`session_cumulative`、`estimate`、`unavailable`。
3. 后端修 `latestRateLimit`：按事件 timestamp 最大值取最新。
4. 后端修 OTel 合并：去重 token-bearing completed；用 `trace_safe.duration_ms` 补耗时。
5. 后端修 raw SSE TTFT：只在能按 response id 明确关联时输出；否则为空。
6. 前端首屏、图表、模型排行全部改为请求级窗口数据。
7. 前端把会话累计移动到“会话诊断”，显式标注“累计，不是窗口消耗”。
8. 安全：本地 API 增加 Host / Origin 校验，必要时再加本地随机访问 token。
9. 性能：先加 JSONL 文件 mtime/size 缓存，再评估是否落本地索引库。

