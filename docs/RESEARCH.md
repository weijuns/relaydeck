# dsh-providers-hub 研究报告

> 对象：[iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub)（MIT，TypeScript，约 5.7 万行）
> 目的：判断能否脱离 DeepSeek Harness 独立运行，以及如何接入 new-api。

## 1. 项目是什么

一个 **DeepSeek Harness（dsh）插件**：管理多个 AI 编程服务的账号（登录、续期、积分领取），并把它们的模型注册进 dsh 的模型选择器。

它同时附带一个**本机 OpenAI 兼容网关**（默认 `127.0.0.1:8326`），供 Pi、Continue、Cline、OpenCode、Codex 等客户端复用已登录账号。

关键事实：

| 项 | 值 |
|---|---|
| 语言 / 构建 | TypeScript → `tsc` 输出 `lib/`；客户端 `esbuild` |
| 许可 | MIT |
| 规模 | 约 325 个源文件；`src/index.ts` 6100+ 行；`account-pool.ts` 3300+ 行 |
| 渠道 | 18 个 provider + 1 个聚合路由 `aggregate` + 1 个 `jet-hub-auto` |
| 宿主契约 | cordis 插件：`inject = ['credentials','commands','llm']`，导出 `apply(ctx)` |
| 网关 | 自带，不依赖宿主，只需 `LlmRuntimeLike` 四个方法 |

## 2. 三层架构

```
产品配置层 product.ts        —— 收敛同一产品族的差异（endpoint / UA / productCode）
        │
认证服务层 *-auth.ts          —— 继承 cordis Service；登录、凭据、静默续期
        │
LLM 适配器层 *-adapter.ts     —— 继承 LlmAdapter；模型目录、请求构造、SSE 转 StreamChunk
        │
账号池 account-pool.ts        —— 多账号索引、选号、限流标记、代理
```

两张注册表：

- `provider-registry.ts`：**纯数据**，零 import（同时被 Node 和浏览器客户端消费）
- `provider-runtime.ts`：**实现表**，运行时按 provider id 查 auth/credits/expiry/probe

设计原则：**编排可抽象，协议不抽象**。各家的签名、端点、载荷转换留在各自模块内。

## 3. 凭据与账号

- 凭据本体：`ctx.credentials`，每条 ref 一个字符串（provider 自己序列化的 JSON）
- 账号索引：`$DSH_HOME/jet-hub/state.json`（无 secret）
- 有效期/可续期：镜像字段，仅用于展示与调度
- 续期：全局调度器 30 分钟一轮，启动先跑一轮；距过期 < 1 小时才真正刷新；一次性 refresh_token 必须原子写回

登录方式三大类：

| 类型 | 例子 | 无头可行性 |
|---|---|---|
| 设备码轮询 | qoder、qodercn、cline、minimax、zcode、buddy | ✅ |
| 本地回环回调 | codearts、trae、gemini、lobby、accio | ⚠️ 需 SSH 转发 |
| 短信 / 扫码 / 浏览器自动化 | loomy、autoclaw、raccoon、magicrew | 部分/不可 |

## 4. 网关

`src/openai-gateway/` 是一个完整的 OpenAI 兼容层：

- `GET /v1/models`、`GET /v1/reasoning-efforts`
- `POST /v1/chat/completions`（JSON + SSE）
- `POST /v1/responses`（完整 Responses 事件流）

它与宿主的耦合只有：

```ts
interface LlmRuntimeLike {
  listProviders()
  listModels(provider)
  resolveModelInfo(provider, model, signal?)
  stream(options)
}
```

外加可选的 `attachments.saveImage` 与 logger。**没有 dsh 业务耦合**。

协议细节上的硬要求（独立实现时不能改）：

- 流式 Chat 只能有一个 `[DONE]`
- 413 必须作为 HTTP 响应返回，不能直接断连
- 模型不存在 → 404，不是 502
- `block-end` 对文本/工具参数有权威覆盖语义
- usage 的 `inputTokens` 不含缓存，需要加回 `cacheRead/cacheWrite`

## 5. 独立运行的可行性（已验证）

### 5.1 直接复用插件

插件的 `apply(ctx)` 只需要三个服务。我们用：

```js
const ctx = new Context()
new FileCredentialProvider(ctx, home)  // credentials
new NoopCommands(ctx)                  // commands
new LlmRuntime(ctx)                    // llm
plugin.apply(ctx)                      // 装配全部 provider + 网关
```

实测结果：

- 18 个 provider 全部注册，`ctx.qoderAuth` 等 auth 服务可用
- 账号池、续期调度器、网关全部正常启动
- `/v1/models` 返回目录；`/v1/chat/completions` 非流式与流式均正常
- `POST /v1/responses` 正常
- 设备码登录（qoder / cline / minimax / zcode）在无头环境返回授权 URL

### 5.2 为什么不用"重写网关"

原生网关已经处理了大量协议边界（缓存计费口径、SSE 语义、Responses 事件、工具调用、错误归一化），重写只会引入回归。正确做法是**保留网关、只替换宿主装配层**。

### 5.3 依赖边界

运行时需要的 npm 包：

| 包 | 许可 | 作用 |
|---|---|---|
| `@deepseek-ai/cordis` | MIT | 服务容器 / 生命周期 |
| `@deepseek-ai/dsh-llm` | MIT | `LlmAdapter` / `LlmError` / `LlmRuntime` |
| `@deepseek-ai/dsh-credentials` | MIT | `CredentialProvider` / `credentialRef` |
| `@deepseek-ai/schemastery` | MIT | 状态文档 schema |
| `wreq-js` | — | OpenCode 传输指纹（可选原生绑定） |
| `jose` / `undici` | MIT | 签名 / HTTP |

不需要：dsh CLI、桌面端、Web 宿主、profile 系统、settings、commands 实现。

## 6. 接入 new-api 的方式

```
new-api 渠道（类型 OpenAI）
  Base URL = http://<docker 网桥 IP>:8326
  Key      = 网关 API Key
  模型      = 从 /v1/models 同步
```

为什么不是 `127.0.0.1`：new-api 在容器里，`127.0.0.1` 是容器自身。网关插件又拒绝绑定 `0.0.0.0`。因此绑定 Docker 网络在宿主侧的网关地址（如 `172.20.0.1`），并用 ufw 只放行该网段。

已验证的完整链路：

```
HTTP 客户端 → new-api:3000 → 172.20.0.1:8326 → OpenCode → 200
```

## 7. 设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 复用插件 vs 重写 | **复用** | 网关与 18 个适配器已被大量测试覆盖；重写风险高 |
| 凭据存储 | 文件 JSON，0600 | 与 dsh 的 `credentials.yaml` 语义一致，便于迁移；不引入 keychain |
| 管理端 | 独立端口 + 简单单页 | 不引入前端构建链；够用即可 |
| 网关监听 | 具体网桥 IP | 上游 fail-closed 拒绝通配地址；最小暴露面 |
| 登录入口 | 管理端 + CLI | 设备码类可完全远程；回调类需隧道 |
| 单进程 | 单节点 | 账号池状态文件无跨进程锁 |

## 8. 风险

1. **合规**：订阅额度转供通常违反上游 ToS；封号无申诉。
2. **上游变更**：适配器需要持续跟进，项目本身日更。
3. **一次性 refresh_token 并发**：多进程/并发登录可能消耗同一 token；建议单实例运行。
4. **明文凭据**：主机被入侵即全部泄露。
5. **图片输入缺失**：独立版未实现附件服务，图片请求会明确报错。
6. **`refreshable` 单向门**：TRAE/Qoder/Cline 的 `refreshAll` 仍以镜像字段为门禁，被误标后不会自愈；遇到"每过一段时间就要重新登录"需手动检查账号字段。

## 9. 代码地图

| 路径 | 作用 |
|---|---|
| `standalone/src/host.mjs` | 宿主 bootstrap：Context + 三个服务 + apply |
| `standalone/src/credentials.mjs` | 文件型 CredentialProvider |
| `standalone/src/config.mjs` | 配置与密钥生成 |
| `standalone/src/admin.mjs` | 管理端 HTTP API |
| `standalone/src/index.mjs` | CLI 入口（start/login/accounts/models/test） |
| `standalone/public/index.html` | 管理端单页 |
| `standalone/scripts/sync-newapi.mjs` | 模型目录同步到 new-api |
| `vendor/dsh-providers-hub/` | 上游源码快照（未修改） |
