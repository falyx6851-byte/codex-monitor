# OpenAI Responses 官方返回字段参考

审计时间：2026-06-24

## 当前项目处理

本项目现在不再读取 `logs_2.sqlite`，也不再接入 raw SSE / OTel。下面内容只作为官方 Responses 字段参考，不进入 Web 看板或独立统计脚本的数据源。

当前看板主 token 口径见 `docs/data-source-audit.md`：session JSONL 的 `token_count.last_token_usage`。

当前看板的金额字段不是官方账单字段，而是按 `pricing.json` 的公开费率做本地估算。

## 单次 Responses terminal event 样式

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
    "model": "gpt-5.6-sol",
    "service_tier": "default",
    "usage": {
      "input_tokens": 129926,
      "input_tokens_details": {
        "cached_tokens": 128384,
        "cache_write_tokens": 512
      },
      "output_tokens": 1099,
      "output_tokens_details": {
        "reasoning_tokens": 700
      },
      "total_tokens": 131025
    },
    "tools": [
      {
        "type": "function",
        "name": "example_tool"
      }
    ],
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
      },
      {
        "id": "fc_abc123",
        "type": "function_call",
        "status": "completed",
        "name": "example_tool",
        "call_id": "call_abc123"
      }
    ]
  }
}
```

## 官方 usage 字段解释

| 字段 | 口径 |
| --- | --- |
| `input_tokens` | 输入 token 总数 |
| `input_tokens_details.cached_tokens` | 命中缓存的输入 token 子集 |
| `input_tokens_details.cache_write_tokens` | GPT-5.6 及后续模型写入缓存的输入 token 子集；按普通输入费率的 `1.25x` 计费 |
| `output_tokens` | 输出 token 总数 |
| `output_tokens_details.reasoning_tokens` | reasoning 输出 token 子集 |
| `total_tokens` | 总 token，正常等于 `input_tokens + output_tokens` |

约束：

- `cached_tokens` 是输入 token 的一部分，不能再加到总 token。
- `reasoning_tokens` 是输出 token 的一部分，不能再加到总 token。
- failed / incomplete / cancelled 请求可能没有完整 usage。
- 当前看板不使用 `response.usage`，因为已剔除 raw SSE 数据源；看板使用 session `last_token_usage`。

## 费用估算

OpenAI 单次 Responses terminal response 不直接返回账单金额。本项目按公开 token 费率估算。GPT-5.6 的完整公式是：

```text
普通输入 token * input rate
+ 缓存读取 token * cached input rate
+ 缓存写入 token * cache write rate
+ 输出 token * output rate
```

估算使用 `pricing.json`。如果模型没有配置费率，明细费用显示为空，不用其他模型价格代替。

当前 Codex session `last_token_usage` 可能只提供 `cached_input_tokens`，不提供 GPT-5.6 的 `cache_write_tokens`。这种情况下无法精确计算缓存写入附加费，页面用 `≥$...` 显示不含该未知附加费的费用下限；若未来 session 写出该字段，后端会按实际 token 数计入。

## 首输出耗时

官方 terminal response 对象本身没有直接返回 TTFT 字段。理论上只有可靠保留流式事件时，才能用以下本地日志口径估算：

```text
response.created 日志到达时间 -> 第一个 response.output_text.delta / response.function_call_arguments.delta 日志到达时间
```

当前项目已经剔除 raw SSE，因此不按官方流式 delta 计算 TTFT。Web 看板里的 `first_output_ms_estimate` 是另一个本地 session 口径：最近 user/tool/output 边界到首个 `response_item.timestamp`，不是官方 TTFT。

同理，项目 API 内部保留的“流式迹象”只来自 session 内 `token_count` 前的 `response_item_count`，不是官方 `stream=true/false` 参数；Web 看板默认不展示该字段。

## 官方组织 Usage / Costs API

OpenAI 官方还有组织级 Admin Usage / Costs API，但当前阶段不接入：

| API | 官方属性 | 当前处理 |
| --- | --- | --- |
| `GET /v1/organization/usage/completions` | 官方组织级用量 bucket，可按 project/user/api key/model 等过滤或分组 | 不接入；当前需求已取消 API key 用量统计 |
| `GET /v1/organization/costs` | 官方组织级成本 bucket | 不接入；当前只做本地 token 费率估算 |

原因：

- 它们是组织级聚合，不是 Codex 本地单请求明细。
- 需要 Admin key；当前项目不要求用户提供，也不从 Codex OAuth 登录态提取。
- 当前阶段的目标是稳定统计本机 Codex session JSONL。

官方参考：

- Responses API：`https://platform.openai.com/docs/api-reference/responses`
- Responses streaming events：`https://platform.openai.com/docs/api-reference/responses-streaming`
- GPT-5.6 模型说明：`https://developers.openai.com/api/docs/guides/latest-model`
- API 费率：`https://developers.openai.com/api/docs/pricing`
- Prompt caching：`https://developers.openai.com/api/docs/guides/prompt-caching`
- Usage API：`https://platform.openai.com/docs/api-reference/usage`
- Costs API：`https://platform.openai.com/docs/api-reference/usage/costs`
