# 架构与实现原理

## 1. 为什么可以"脱离 dsh"

上游 `dsh-providers-hub` 是一个 cordis 插件。它的入口是：

```ts
export const inject = ['credentials', 'commands', 'llm']
export function apply(ctx: Context): void
```

也就是说，它需要的宿主面只有三样：

| 服务 | 用途 | 我们的实现 |
|---|---|---|
| `credentials` | `resolve/describe/set/unset` 凭据读写 | `FileCredentialProvider`（`src/credentials.mjs`） |
| `llm` | 适配器注册表 + 流式调用 | `new LlmRuntime(ctx)`（上游 npm 包） |
| `commands` | 插件声明依赖，实际未使用 | `NoopCommands`（空 Service） |

其余一切——`logger`、`effect`、`get()`——cordis 的根 `Context` 自带，或者插件本身用可选链访问。

所以独立宿主只需要 ~60 行：

```js
const ctx = new Context()
new FileCredentialProvider(ctx, home)   // 注册 credentials
new NoopCommands(ctx)                   // 注册 commands
new LlmRuntime(ctx)                     // 注册 llm
plugin.apply(ctx)                       // 插件自己装配 18 个 provider + 账号池 + 网关
```

`plugin.apply(ctx)` 内部会：

1. 创建各家 auth 服务（`ctx.qoderAuth`、`ctx.clineAuth`…）
2. 创建 `AccountPool`，从 `$DSH_JET_HUB_STATE_DIR/jet-hub/state.json` 恢复账号索引
3. 用 `registerAdapterIdempotent(ctx.llm, ...)` 注册各 provider 的 `LlmAdapter`
4. 装配 30 分钟一轮的静默续期调度器
5. 调用 `mountOpenAiGateway(ctx, pool)` 启动 OpenAI 网关

因此"独立版"的本质是：**去掉宿主，保留插件**。

---

## 2. 进程结构

```
┌──────────────────────────── Node 进程 ────────────────────────────┐
│                                                                  │
│  cordis Context                                                  │
│   ├─ credentials  ← FileCredentialProvider                       │
│   ├─ llm          ← LlmRuntime（适配器注册表）                    │
│   ├─ commands     ← Noop                                          │
│   ├─ accountPool  ← 插件创建（账号索引 + 选号 + 限流标记）         │
│   ├─ qoderAuth / clineAuth / minimaxAuth …（插件创建）            │
│   └─ openai-gateway（插件创建）                                   │
│         :8326  /v1/models /v1/chat/completions /v1/responses      │
│                                                                  │
│  Admin HTTP server（本项目）                                      │
│         :8327  /  /api/overview /api/login /api/accounts …        │
└──────────────────────────────────────────────────────────────────┘
```

两个 HTTP 服务同进程、不同端口：

- **网关**：给客户端/new-api 用，Bearer 鉴权，OpenAI 协议
- **管理端**：给运维用，`x-admin-token` 鉴权，JSON API + 单页 UI

默认都只绑回环地址。部署时网关绑到 Docker 网桥的宿主侧 IP（如 `172.20.0.1`），管理端保持 `127.0.0.1` 再由 nginx 反代。

---

## 3. 一次请求的完整路径

```
POST /v1/chat/completions
  model = "qoder/qwen3.8-max"
        │
        ▼
[网关] parseModelRoute → provider=qoder, model=qwen3.8-max
        │
        ▼
[网关] resolveModelInfo(provider, model) → 档位/上下文信息
        │
        ▼
[网关] messages → DSH 消息格式 + tools + maxTokens + reasoningEffort
        │
        ▼
[LlmRuntime] 找到 qoder 的 LlmAdapter，调用 stream(options)
        │
        ▼
[QoderAdapter] resolver → 账号池选号 → 读凭据 → 构造加密请求
        │
        ├─ 429/额度错误 → 标记该账号在该模型上的限流时间 → 换下一个账号
        └─ 401/过期     → auth.refresh() → 写回凭据 → 重试
        │
        ▼
[上游 SSE] → StreamChunk → 网关转回 OpenAI SSE/JSON
```

**选号策略**（插件内置）：

- 按账号池中的**手动顺序**取第一个可用账号
- 跳过 `enabled=false`、被该模型限流、凭据解析失败的账号
- 命中限流后该账号"沉底"，解禁前不再优先

**续期**（插件内置）：

- 全局调度器每 30 分钟扫一轮，启动时立刻跑一轮
- 距到期不足 1 小时才真正刷新
- 刷新成功写回 `credentials.json` 并同步 `state.json` 的 `expiresAt/refreshable`
- 一次性 refresh_token 的渠道已做单飞去重（CodeArts / MiniMax）；其余渠道建议单账号使用

---

## 4. 数据模型

### 4.1 账号索引（`state.json`）

```jsonc
{
  "accounts": [
    {
      "id": "qoder-a1b2c3d4",
      "provider": "qoder",
      "nickname": "主号",
      "enabled": true,
      "credentialRef": "QODER_ACCOUNT_A1B2C3D4",
      "createdAt": 1793620000000,
      "expiresAt": 1793623600000,
      "refreshable": true,
      "modelRateLimits": { "qwen3.8-max": 1793621000000 }
    }
  ],
  "disabledModels": {},
  "gatewayEnabled": true,
  "gatewayAllowLan": false
}
```

### 4.2 凭据（`credentials.json`）

```jsonc
{
  "QODER_ACCOUNT_A1B2C3D4": "{\"access_token\":\"...\",\"refresh_token\":\"...\",\"machine_id\":\"...\"}"
}
```

- 一条 ref 对应一个账号
- 值是 provider 自己定义的 JSON 字符串，插件不解释、只透传
- 文件权限 `0600`，读取时整份载入内存

### 4.3 密钥（`config.json`）

```jsonc
{
  "adminToken": "...",      // 管理端 API
  "gatewayKey": "...",      // 网关 Bearer
  "gatewayHost": "172.20.0.1",
  "gatewayPort": 8326
}
```

---

## 5. 与上游插件的边界

| 组件 | 来源 | 是否修改 |
|---|---|---|
| provider 适配器、账号池、续期、网关 | `vendor/dsh-providers-hub/lib` | ❌ 原样 |
| cordis / dsh-llm | npm | ❌ 原样 |
| 宿主 bootstrap | `standalone/src/host.mjs` | ✅ 本项目 |
| 凭据存储 | `standalone/src/credentials.mjs` | ✅ 本项目 |
| 管理端 / CLI | `standalone/src/admin.mjs`、`index.mjs` | ✅ 本项目 |
| 部署脚本 / 文档 | `standalone/`、`deploy/` | ✅ 本项目 |

升级策略：只替换 `vendor/` 并重新构建，`standalone/` 通常不需要改动（除非上游改了 `apply` 的服务契约）。

---

## 6. 关键技术验证（已实测）

1. **裸 cordis 可以创建 `LlmRuntime`**：`new Context()` → `new LlmRuntime(ctx)` → `registerAdapter()` → `stream()` 全链路可用，不需要 dsh 宿主。
2. **插件 `apply()` 可以在裸 Context 上运行**：提供 credentials + commands + llm 三个服务后，18 个 provider 全部注册，账号池可用。
3. **网关可以正常起监听**：`/v1/models` 返回目录，`/v1/chat/completions` 返回非流式结果。
4. **端到端打通**：`用户 → new-api → RelayDeck → OpenCode 免费模型`，返回 200 与正确内容。

未实现的部分及原因：

- **图片输入**：网关需要 `ctx.get('attachments').saveImage`。独立版不提供，收到图片会返回明确的 `unsupported_content`，不会静默丢图。
- **聚合路由 `aggregate` / `jet-hub-auto`**：它们是插件注册的普通 provider，账号池为空时模型目录仍会出现，但请求会失败；接入多个渠道后会自然可用。
