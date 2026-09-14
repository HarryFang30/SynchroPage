# 用 coproxy 网关（gpt-6-astra）驱动 SynchroPage

SynchroPage 的所有模型调用都从 Python 后端发出，浏览器不持有任何密钥。除了内置的
ChatGPT OAuth 通道，后端还预置了一个名为 `coproxy` 的 provider，指向自建的 coproxy
网关（GitHub Copilot 额度，OpenAI Responses 兼容协议）。本文说明如何配置、验证和排障。

> 密钥即一切：网关唯一的访问控制就是 token。**不要**把 token 写进 `config/`、`docs/`、
> `examples/`、`.env` 或任何会进 git 的文件。它只应存在于 `~/.pdf_agent/model_providers.json`
> （文件权限 0600）或环境变量里。

## 1. 网关事实（2026-09-13 实测）

| 项 | 值 |
|---|---|
| 地址 | `https://us.taohuang.info`（provider 的 API Host 写成 `https://us.taohuang.info/v1`） |
| 鉴权 | `Authorization: Bearer <token>` 或 `X-Api-Key: <token>`，后端发送 Bearer |
| 主力模型 | `gpt-6-astra`：仅 `/v1/responses`；输入上限 872k、输出上限 128k |
| `reasoning.effort` | `gpt-6-astra` 只接受 `low / medium / high / xhigh / max`（**不支持 `none`**）；`gpt-5.5` 只接受 `none…xhigh`（**不支持 `max`**） |
| PDF 附件 | `input_file` data URL 可用，后端会按目标页裁剪后附上 |
| 推理 token | 计入 `max_output_tokens`；后端默认不设上限，避免思考过程吃光正文 |

后端会根据模型前缀自动把不支持的 effort 夹到最近的合法值（例如 `none → low`），
如果上游仍返回 `Unsupported value … Supported values are: …`，会解析错误信息并重发一次。

## 2. 配置方式

### 方法 A：应用内设置（推荐）

1. 打开 SynchroPage → 设置 → Providers → 选择 `coproxy (GPT-6 gateway)`。
2. 粘贴 token 到 API Key，打开启用开关，点击 **Check**（后端会真实请求一次 `/v1/responses`）。
3. 设置 → Models：把 Assistant / Quality / Balanced / Quick 四个默认模型都指向
   `gpt-6-astra | coproxy`，保存。

配置会写入 `~/.pdf_agent/model_providers.json`，权限 0600。

### 方法 B：环境变量

不想把 token 落盘时，在启动后端的 shell 里设置任一变量：

```bash
export COPROXY_API_KEY="<token>"      # 也兼容 PDF_AGENT_COPROXY_API_KEY / COPROXY_TOKEN
```

设置后 `coproxy` provider 会自动视为已启用；设置界面会显示 "A key is saved"。
网关地址可用 `PDF_AGENT_COPROXY_BASE_URL` 覆盖（默认 `https://us.taohuang.info/v1`）。

### 方法 C：直接写配置文件

```json
{
  "selectedProviderId": "coproxy",
  "providers": [
    {
      "id": "coproxy",
      "type": "openai-responses",
      "apiHost": "https://us.taohuang.info/v1",
      "apiKey": "<token>",
      "enabled": true,
      "models": ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gemini-3.8-flash", "grok-4.6"]
    }
  ],
  "defaults": {
    "assistant": { "providerId": "coproxy", "model": "gpt-6-astra" },
    "teachingQuality": { "providerId": "coproxy", "model": "gpt-6-astra" },
    "teachingBalanced": { "providerId": "coproxy", "model": "gpt-6-astra" },
    "teachingFast": { "providerId": "coproxy", "model": "gpt-6-astra" }
  }
}
```

其余 provider 字段会由后端用预置值补全。

## 3. 验证

```bash
# 后端健康
curl -s http://127.0.0.1:8765/api/health

# 当前生效的 provider / 默认模型（不含密钥）
curl -s http://127.0.0.1:8765/api/model-config | python3 -m json.tool | grep -A2 '"defaults"'

# 让后端真实打一次网关
curl -s http://127.0.0.1:8765/api/model-config/check \
  -H 'content-type: application/json' \
  -d '{"provider":{"id":"coproxy"},"model":"gpt-6-astra"}'
```

期望最后一条返回 `{"ok": true, "endpoint": "openai-responses", ..., "text": "OK"}`。

## 4. 超时与重试（与网关相关的默认值）

生成链路的数值策略集中在 `src/pdf_agent/server/generation_policy.py`。

| 项 | 默认 | 说明 |
|---|---|---|
| 流式读取 | 开启 | 对 OpenAI Responses 类 provider 发送 `stream: true`，socket 超时变成"多久没有新字节"的空闲超时 |
| `PDF_AGENT_TEACHING_INACTIVITY_SECONDS` | 120 | 空闲超时：连续 120 秒没有收到字节才判定 `upstream_timeout` |
| 整体截止时间 | low 180 s / medium 300 s / high 480 s / xhigh·max 600 s | 按 `reasoning.effort` 计算，批量每多 1 页（超过 2 页）再加 60 s；前端请求超时 = 该值 + 20 s |
| `max_output_tokens` | 16k（low/medium）/ 24k（high）/ 32k（xhigh/max） | 推理 token 计入其中；批量按每页 8k、上限 48k；命中上限返回 `output_truncated` |
| 瞬时错误重试 | 2 / 6 / 15 s 全抖动，最多 3 次 | 只重试 408/425/429/5xx 和首字节前的网络错误；`Retry-After` 最长遵守 120 s |
| 429 冷却 | max(Retry-After, 5 s)，上限 120 s | 全局生效，新请求也会等待 |
| `PDF_AGENT_TEACHING_CONCURRENCY` | 6 | 后端并发；排队超过 30 s 返回 503 `queue_timeout` + `Retry-After: 10` |
| 相同请求合并 | 自动 | 同一文档、同一页、同一模型的并发请求共用一次上游调用（`timing.coalesced`） |
| JSON 修复重试 | 1 次 | 返回不是合法 JSON 时按低一档 effort 重发一次；批量结果部分解析成功时返回 `missing` 页码列表 |
| `PDF_AGENT_AGENT_TIMEOUT_SECONDS` | 240 | 右侧助手单次请求上游超时 |
| effort 兜底 | 自动 | 静态夹取（如 `none → low`）+ 解析上游错误重发一次 |

前端与之配合：请求超时不低于后端截止时间；批量"仍在生成"的提示只是状态文字，不再中断请求；
重试计划按失败原因决定（超时/网络不升级为附 PDF 的重型计划，限流走共享冷却门，仅内容过弱才升级一次）；
并发窗口按 AIMD 自适应（推理模型从 2 路起步）。`GET /api/generate/status` 可查看当前活跃/排队/冷却状态。

## 5. 排障

- **全部 403**：token 不对或没带。先 `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $COPROXY_API_KEY" https://us.taohuang.info/health`。
- **`unsupported_api_for_model`**：provider 的 Endpoint 被改成了 Chat Completions；`gpt-6-astra` 只能走 OpenAI Responses。
- **`invalid_request_body` 提到 effort**：模型不接受该强度；后端会自动重发，若仍失败请把设置里的“模型思考强度”调回 `medium`。
- **返回 200 但正文为空**：`max_output_tokens` 太小被推理 token 吃光。后端默认不传该字段；自定义请求请给到 2048 以上。
- **网关上没有 Claude 模型**：这是 Copilot 侧的地区/企业策略问题，与本项目无关；用 `gpt-6-astra` 替代。
