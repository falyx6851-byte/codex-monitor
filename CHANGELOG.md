# Changelog / 更新日志

All notable changes to this project are recorded here.

本文件记录项目的重要功能和统计口径变更。

## [0.4.0] - 2026-09-11

- 补采 archived_sessions，按会话原子合并与去重；支持归档移动、旧索引迁移及解析失败回滚。
- 大型会话日志逐行读取；索引移至后台进程并使用 SQLite WAL，避免索引更新阻塞页面查询。
- 未知服务档位明确标记为标准价假设，汇总与明细展示不确定性。
- 健康接口增加版本、解析器版本、费率日期和扫描来源。

- Windows 登录任务增加持续进程托管、退出重启及任务失败重试；手动停止先停托管任务。

- 2026-09-07：新增 GPT-6 Astra 识别与标准 / Fast / Flex 计价，同步 GPT-5.6 最新官方费率。
- 支持新模型超过 272K 输入的 Fast / Flex 长上下文费率；未知服务档位不再误按标准价计费。
- 兼容模型名称大小写和已知推理强度后缀；新增模型切换、缓存缺失、长上下文边界和旧模型回归测试。
- 明确所有历史记录按当前价格快照重估，不等于历史账单。

- 从 session JSONL 的 `thread_settings_applied.thread_settings.service_tier` 识别标准与 Fast / Priority 请求，不读取 `logs_2.sqlite`。
- 请求列表和详情增加 Fast 标签，并按官方标准、长上下文与 Priority 费率重新估算金额。
- 增加解析器版本迁移，仅重新导入仍存在的 session 文件，保留缺少原始 JSONL 的旧历史记录。

## [0.3.0] - 2026-07-10

### 中文

- 新增“请求监控”和“周期统计”双视图，以及小时、天、周粒度聚合。
- 周期统计新增 Token 趋势、Token 构成、成功率、模型占比、费用与响应耗时图表。
- 明确排除 compact、abort 和 rollback 产生的无明细系统 token 事件，避免误计为失败请求或真实用量。
- 更新 GPT-5.6 Sol、Terra、Luna 和 `gpt-5.6` 别名的公开标准费率配置。
- 按监控中心设计稿重构桌面界面、语义配色、指标卡和周期明细分页。
- 修复 Canvas 缓冲区与 CSS 尺寸不一致导致的环形图和窄屏图表变形。
- 请求明细默认每页由 7 条调整为 6 条，减少普通笔记本视口内的列表滚动。
- 保持页面外层固定视口；请求表格和低高度周期工作区在内部滚动。

### English

- Added separate Request Monitor and Period Analytics views with hourly, daily, and weekly aggregation.
- Added token volume, token mix, success rate, model share, cost, and latency visualizations.
- Excluded breakdown-less compact, abort, and rollback system token events from request and usage statistics.
- Added public standard pricing configuration for GPT-5.6 Sol, Terra, Luna, and the `gpt-5.6` alias.
- Rebuilt the desktop dashboard, semantic palette, metric cards, and period pagination from the monitoring design reference.
- Fixed canvas backing-size mismatches that distorted donut charts and narrow-screen charts.
- Changed the default request page size from 7 to 6 rows for laptop-height viewports.
- Kept the page shell fixed while allowing internal scrolling in request and low-height analytics workspaces.

## [0.2.0] - 2026-06-24

- Prepared the repository for public distribution with English and Chinese documentation.
- Added the local SQLite-derived statistics store, request ledger, cost estimates, and Windows resident-run helpers.
- Removed OAuth, reverse-proxy, packet-capture, API-key billing, and `logs_2.sqlite` dependencies from the supported data path.

## [0.1.0] - 2026-06-23

- Initial local Codex session JSONL token monitor.
- Added normalized request usage fields and the first local Web dashboard.
