# OpenAI 官方返回字段与 Usage 接口

审计时间：2026-06-23

## 单次 Responses 请求返回样式

Codex 本地 raw SSE 能记录到官方 Responses API 的 `response.completed` 事件。该事件中的 `response` 是官方返回对象，当前看板会把其中的结构化字段保存在每条请求的 `official_response`。

示例结构如下，数值为示例：

```json
{
  "type": "response.completed",
  "sequence_number": 42,
  "response": {
    "id": "resp_abc123",
    "object": "response",
    "created_at": 1782210000,
    "completed_at": 1782210042,
    "status": "completed",
    "model": "gpt-5.5",
    "service_tier": "default",
    "usage": {
      "input_tokens": 129926,
      "input_tokens_details": {
        "cached_tokens": 128384
      },
      "output_tokens": 1099,
      "output_tokens_details": {
        "reasoning_tokens": 700
      },
      "total_tokens": 131025
    },
    "tool_usage": {
      "web_search": {
        "num_requests": 1
      }
    },
    "reasoning": {
      "effort": "medium",
      "summary": null
    },
    "text": {
      "format": {
        "type": "text"
      },
      "verbosity": "medium"
    },
    "truncation": "auto",
    "parallel_tool_calls": true,
    "prompt_cache_key": null,
    "prompt_cache_retention": null,
    "metadata": {},
    "error": null,
    "incomplete_details": null,
    "output": [
      {
        "id": "msg_abc123",
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "content": [
          {
            "type": "output_text",
            "text": "..."
          }
        ]
      }
    ]
  }
}
```

当前项目不会把完整 `output` 正文、`instructions` 等大字段原样塞进详情。页面请求详情中保留：

- `official_response.id`
- `official_response.object`
- `official_response.status`
- `official_response.model`
- `official_response.created_at`
- `official_response.completed_at`
- `official_response.service_tier`
- `official_response.usage`
- `official_response.tool_usage`
- `official_response.error`
- `official_response.incomplete_details`
- `official_response.metadata`
- `official_response.reasoning`
- `official_response.text`
- `official_response.truncation`
- `official_response.parallel_tool_calls`
- `official_response.prompt_cache_key`
- `official_response.prompt_cache_retention`
- `official_response.output_items`：只保留 output item 的 id/type/status/role/content_types/tool_name/call_id 摘要
- `official_response.tools`：只保留工具 type/name 摘要

## 官方 usage 字段解释

`response.usage` 是单次 completed 请求的官方 token 用量字段，适合作为本地看板的主请求级 token 统计来源。

字段口径：

- `input_tokens`：输入 token 总数。
- `input_tokens_details.cached_tokens`：命中缓存的输入 token 子集。
- `output_tokens`：输出 token 总数。
- `output_tokens_details.reasoning_tokens`：reasoning 输出 token 子集。
- `total_tokens`：总 token，正常等于 `input_tokens + output_tokens`。

不能做的事：

- 不能把 `cached_tokens` 再加到 `total_tokens`。
- 不能把 `reasoning_tokens` 再加到 `total_tokens`。
- 没有 `response.completed` 的失败/中断请求，通常不能拿到最终官方 usage。

官方参考：

- Responses create：`https://developers.openai.com/api/reference/resources/responses/methods/create/`
- Responses streaming events：`https://developers.openai.com/api/reference/resources/responses/streaming-events/`
- Prompt caching：`https://developers.openai.com/api/docs/guides/prompt-caching/`
- Count input tokens：`https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count/`

## 官方组织级 Usage 接口

OpenAI 官方提供组织级 Usage API，可按 bucket 查询用量。这个接口不是普通 Responses API 返回值，它属于 Admin / Organization 范围。

### Completions usage

接口：

```http
GET https://api.openai.com/v1/organization/usage/completions
Authorization: Bearer $OPENAI_ADMIN_KEY
```

用途：

- 查询组织维度的 completions / responses token 用量。
- 返回按时间 bucket 聚合的 `input_tokens`、`output_tokens`、`input_cached_tokens`、`input_audio_tokens`、`output_audio_tokens`、`num_model_requests` 等。
- 可按 `start_time`、`end_time`、`bucket_width`、`project_ids`、`user_ids`、`api_key_ids`、`models`、`batch`、`group_by` 等参数过滤或分组。

官方返回样式示例：

```json
{
  "object": "page",
  "data": [
    {
      "object": "bucket",
      "start_time": 1736616660,
      "end_time": 1736640000,
      "results": [
        {
          "object": "organization.usage.completions.result",
          "input_tokens": 141201,
          "output_tokens": 9756,
          "input_cached_tokens": 0,
          "input_audio_tokens": 0,
          "output_audio_tokens": 0,
          "num_model_requests": 470,
          "project_id": null,
          "user_id": null,
          "api_key_id": null,
          "model": null,
          "batch": null
        }
      ]
    }
  ],
  "has_more": false,
  "next_page": null
}
```

看板中的使用方式建议：

- 这是“官方组织级聚合口径”，可新增一个独立区块叫“官方组织 Usage”。
- 不要和本地 Codex 请求表直接强行一一对账，因为官方 Usage 是组织/API key/project/user 维度的 bucket 聚合，不返回本地 `conversation.id`、cwd、prompt 摘要。
- 如果 `group_by=["api_key_id","model"]`，可以把本机 API key 的官方总量与本地 raw SSE 总量做“差异对账”。
- 需要 `$OPENAI_ADMIN_KEY`，不能从 Codex OAuth 登录态里偷取。

官方参考：

- Completions usage：`https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions/`

### Costs

接口：

```http
GET https://api.openai.com/v1/organization/costs
Authorization: Bearer $OPENAI_ADMIN_KEY
```

用途：

- 查询组织维度成本金额。
- 返回按时间 bucket 聚合的成本，通常包含 `amount.value` 和 `amount.currency`。
- 可按 `start_time`、`end_time`、`bucket_width`、`project_ids`、`group_by`、`limit`、`page` 等参数过滤或分页。

官方返回样式示例：

```json
{
  "object": "page",
  "data": [
    {
      "object": "bucket",
      "start_time": 1736616660,
      "end_time": 1736640000,
      "results": [
        {
          "object": "organization.costs.result",
          "amount": {
            "value": 0.06,
            "currency": "usd"
          },
          "project_id": null
        }
      ]
    }
  ],
  "has_more": false,
  "next_page": null
}
```

看板中的使用方式建议：

- 这是“官方账单金额口径”，优先级高于本地 `pricing.json` 估算。
- 本地估算仍有价值，因为它能按 Codex session/cwd/request 细分；官方 Costs 更适合做总量对账。
- 如果没有 Admin key，就保持本地 API 等价估算，不要读取 OAuth token 或反代个人资料页。

官方参考：

- Costs：`https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs/`

## 当前项目保留策略

当前项目保留三层信息，不混淆：

| 层级 | 字段 | 来源 | 用途 |
| --- | --- | --- | --- |
| 官方单次请求 | `request.official_response` | raw SSE `response.completed.response` | 请求详情追溯官方返回字段 |
| Codex 本地补充 | `auth_mode`、`originator`、`terminal_type`、`conversation_id`、`cwd` | OTel + JSONL | 来源、上下文、会话关联 |
| 本地估算 | `request.cost` | `pricing.json` + token | 模型配置了官方 API 单价时估算成本 |

后续如果接官方组织 Usage API，应新增第四层：

| 层级 | 字段 | 来源 | 用途 |
| --- | --- | --- | --- |
| 官方组织聚合 | `official_usage_buckets`、`official_cost_buckets` | Admin Usage API / Costs API | 官方总量和账单对账 |

