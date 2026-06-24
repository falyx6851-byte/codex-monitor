# Codex token 监控调研

调研时间：2026-06-23

## 结论

当前本地监控的主账本应使用 Codex session JSONL 的 `token_count.last_token_usage`。这是本机在不读 OAuth 凭据、不做代理、不依赖 SQLite 日志继续写入的前提下，能稳定覆盖当前请求的来源。

OpenAI 官方可提供两类数据：

| 类型 | 官方来源 | 粒度 | 对本项目的作用 |
| --- | --- | --- | --- |
| Responses 单次返回 | Responses API / streaming terminal event | 单次模型请求 | 作为官方字段参考；当前本地看板不接入 |
| 组织级用量 | Usage API / Codex Enterprise Analytics API | bucket 聚合 | 适合组织报表，不适合替代本机请求明细；本项目不要求 Admin key |

社区常见做法是读取本地日志或 session 文件做离线统计。风险点是 session 里可能有重复 `token_count` 或子会话重放，必须去重并明确口径，不能把 `total_token_usage` 逐条相加。

## 官方信息

| 官方能力 | 能拿到什么 | 不能解决什么 | 本项目处理 |
| --- | --- | --- | --- |
| Responses API | `status`、`model`、`created_at`、`completed_at`、`usage.input_tokens`、`usage.output_tokens`、`usage.total_tokens`、缓存输入和 reasoning 输出细分、错误 / incomplete 信息、输出 item、工具声明或工具调用摘要 | 不直接给本机历史请求列表；不直接给 TTFT | 只作为字段参考，不进入本地看板数据源 |
| Responses streaming events | `response.created`、`response.output_text.delta`、`response.function_call_arguments.delta`、`response.completed` 等流式事件 | 需要可靠流式事件日志；当前 `logs_2.sqlite` 已剔除 | 不接入 |
| Prompt caching | `cached_tokens` 是输入 token 的子集 | 不能把缓存 token 当作额外 token 加总 | 映射为 `cached_input_tokens` |
| Organization Usage API | 按时间 bucket 汇总 completions 用量，可按 project/user/api key/model 等过滤或分组 | 不是 Codex OAuth 本地会话明细；需要 Admin key | 当前不接入 |
| Codex Enterprise Analytics / Compliance | 管理员可看 Codex adoption、credits、tokens、客户端、用户排行；Compliance API 可导出活动日志和请求元数据 | 面向企业 workspace 和管理员，不是个人本机免密接口 | 作为官方可用能力记录，不纳入本地脚本 |
| Codex auth 文档 | `~/.codex/auth.json` 可能保存访问 token，需像密码一样保护 | 不应为了额度百分比或私有接口读取该文件 | 本项目明确不读取 |
| Codex OTel | 可配置导出 run、tool usage、SSE/event、token counts | 需要用户主动配置导出，且不等同于现有历史 session 明细 | 不接入 |

## 本地脚本字段合同

| 字段 | 来源 | 口径 |
| --- | --- | --- |
| `record_id` | 本地生成 | `session-token-<session_id>-<timestamp>-<ordinal>` |
| `timestamp` / `ms` | `token_count.timestamp` | 响应记录落入 session 的时间，用于归窗 |
| `session_id` | `session_meta.id` | 会话标识 |
| `cwd` | `session_meta.cwd` | 本地工作目录，可用 `--redact-paths` 脱敏 |
| `source` / `thread_source` / `originator` | `session_meta` | 请求来源上下文，不是官方 billing 字段 |
| `model_provider` / `cli_version` | `session_meta` | 本地 Codex 客户端上下文 |
| `model` / `effort` | 最近的 `turn_context` | 本地上下文中的模型和 reasoning effort |
| `input_tokens` | `last_token_usage.input_tokens` | 本次 token_count 记录的输入 token |
| `cached_input_tokens` | `last_token_usage.cached_input_tokens` | 输入 token 子集，不加总到 total 之外 |
| `output_tokens` | `last_token_usage.output_tokens` | 本次输出 token |
| `reasoning_output_tokens` | `last_token_usage.reasoning_output_tokens` | 输出 token 子集，不加总到 total 之外 |
| `total_tokens` | `last_token_usage.total_tokens` | 主加总字段 |
| `total_usage_snapshot` | `total_token_usage` | 会话累计快照，只用于去重和详情，不逐条加总 |
| `model_context_window` | `token_count.info.model_context_window` | 模型上下文窗口记录 |
| `turn_elapsed_ms_estimate` | `token_count.timestamp - task_started.timestamp` | 本地估算，不是官方服务端耗时 |
| `turn_duration_ms_estimate` | `task_complete.timestamp - task_started.timestamp` | 本地 turn 总耗时估算 |

## 去重策略

默认去重 key：

```text
session_id + last_token_usage_tuple + total_token_usage_snapshot_tuple
```

原因：

- `last_token_usage` 相同但 `total_token_usage` 不同，可能是两次真实请求碰巧 token 一样，不应合并。
- `last_token_usage` 和 `total_token_usage` 都相同，当前本机样本显示更像重复写入或重放。
- 如果用户需要审计原始事件，可用 `--no-dedupe` 保留全部 `token_count`。

## 参考来源

- OpenAI Codex Governance：`https://developers.openai.com/codex/enterprise/governance`
- OpenAI Codex Authentication：`https://developers.openai.com/codex/auth`
- OpenAI Codex App Server：`https://developers.openai.com/codex/app-server`
- OpenAI Codex Advanced Configuration / OTel：`https://developers.openai.com/codex/config-advanced`
- OpenAI Responses API：`https://platform.openai.com/docs/api-reference/responses`
- OpenAI Responses streaming events：`https://platform.openai.com/docs/api-reference/responses-streaming`
- OpenAI Prompt caching：`https://platform.openai.com/docs/guides/prompt-caching`
- OpenAI Usage API：`https://platform.openai.com/docs/api-reference/usage`
- OpenAI Cookbook Usage / Costs API 示例：`https://cookbook.openai.com/examples/completions_usage_api`
- OpenAI Codex GitHub issue 线索：`https://github.com/openai/codex/issues/9660`
