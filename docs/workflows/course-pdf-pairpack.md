# Course PDF PairPack Workflow

这是 harness 的规范流程。实现时可以由 FastAPI worker、队列任务或本地 CLI 调用。

## 1. Planning

调用 `document_planner`，输入整份 PDF。

必须产出：

- `page_count`
- `sections`
- `page_inventory`
- `generation_strategy`
- `needs_parser_fallback_pages`

失败策略：

- PDF 无法读取或页数未知：run 标记 `failed`，除非本地 parser fallback 能恢复 page map。

## 2. Generation

调用 `page_teacher`，按 1 到 5 页小批量生成。

必须：

- 使用 `lecture_pairpack.page_batch.v1` schema。
- 拒绝非 target pages 的输出。
- 每页必须有 evidence。
- 失败页标记 `needs_review`，继续其他页面。

## 3. Review

调用 `page_reviewer` 审查每页。

检查：

- 页码对齐；
- evidence 是否来自当前页；
- 图表页是否有 visual explanations；
- 公式页是否有 formula explanations；
- 是否编造页面中没有的定义、数字、结论。

## 4. Repair

只修复失败页。

限制：

- 不重写其他页。
- 不改变 `page_no`。
- 不足以判断时设置 `needs_parser_fallback`，不要补编。

## 5. Publish

持久化：

- `lecture_pairpack.v1.json`
- page thumbnails
- journal
- event log
- prompt/schema/model metadata

前端读取：

- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/events`
- `GET /api/documents/:document_id/pages/:page_no`

