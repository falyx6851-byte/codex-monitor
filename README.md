# Codex Token 本地监控看板

## 目录说明

这是一个独立任务目录。默认不要把本目录与其他根级任务目录混读，除非用户明确要求。

## 任务元数据

- 目录名：2026-06-23-codex-token-monitor
- 创建时间：2026-06-23 17:22:11
- 当前状态：running_resident_verified
- 任务类型：general

## 任务范围

- 构建一个本地常驻 Web 看板，监听 `127.0.0.1:4127`。
- 只读采集本机 Codex 日志：
  - `C:\Users\Administrator\.codex\sessions\YYYY\MM\DD\*.jsonl`
  - `C:\Users\Administrator\.codex\logs_2.sqlite`
- 展示 session token、请求级 token、缓存 token、首 token 估算、耗时、模型、来源、额度百分比、日/周/小时趋势和自定义时间范围。
- 不读取 `~\.codex\auth.json` 明文 token；不做抓包、反代或 OAuth 中间人。

## 关键文件

- `server.js`：本地 HTTP 服务和日志采集器。
- `public/index.html`：监控看板页面。
- `public/styles.css`：看板样式。
- `public/app.js`：前端渲染、过滤、图表和导出逻辑。
- `pricing.json`：API token 价格配置。只对配置了官方 API 单价的模型估算美元成本。
- `scripts/start.ps1`：前台启动。
- `scripts/start-hidden.ps1`：后台隐藏启动。
- `scripts/stop.ps1`：停止本地服务。
- `scripts/install-startup-task.ps1`：安装当前用户登录自启计划任务。
- `scripts/uninstall-startup-task.ps1`：卸载登录自启计划任务。

## 相关会话 / Codex Resume

- 会话 1：codex resume 019ef3ad-7c31-7fc3-a89d-a600be2d17ba

## 当前结论

- 已实现本地 Web 看板。
- JSONL 统计口径：每个 session 文件取最后一次 `total_token_usage`，避免重复累计同一会话内多次 `token_count`。
- 请求统计口径：从 `logs_2.sqlite` 的原始 SSE `response.completed` 和 `codex.sse_event` 合并生成请求记录。
- 额度百分比：优先读取 `token_count.rate_limits.primary/secondary.used_percent`，这是本地日志字段，不需要 OAuth 反代。
- IP：当前本地日志没有上游出口 IP 字段，因此看板明确显示“未记录”。
- 首 token：按 `response.created` 到首个 `output_text.delta` / `function_call_arguments.delta` 的日志时间估算，非服务端精确 TTFT。
- 花费：API key 请求可按 `pricing.json` 估算；ChatGPT OAuth 请求只显示 API 等价估算，不等于真实套餐账单。
- 当前服务已后台运行：`http://127.0.0.1:4127`
- 当前用户登录自启任务已安装：`CodexTokenMonitor`

## 验证记录

- `node --check .\server.js`：通过。
- `node --check .\public\app.js`：通过。
- PowerShell 脚本 Parser 语法检查：通过。
- `/api/health`：返回 `ok: true`，`sessions_dir_exists: true`，`log_db_exists: true`，`sqlite_available: true`。
- `/api/data`：可返回 session 汇总、请求记录、额度百分比和趋势数据。
- Browser 桌面视口：指标卡、额度条、趋势图、请求表、会话表均正常渲染。
- Browser 移动视口 `390x844`：无横向溢出，指标和表格数据正常。
- 计划任务：`schtasks /Query /TN CodexTokenMonitor /V /FO LIST` 显示 `Status: Ready`。

## 下一步

- 运行：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1`
- 后台常驻：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-hidden.ps1`
- 安装登录自启：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup-task.ps1`
- 打开：`http://127.0.0.1:4127`
- 停止：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1`
