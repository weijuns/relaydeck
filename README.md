# RelayDeck（中继台）

> 把订阅制 AI 编程服务的账号池，变成一个标准的 OpenAI 兼容 API 网关。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)](https://nodejs.org)
[![Upstream](https://img.shields.io/badge/upstream-dsh--providers--hub-6f42c1)](https://gitee.com/iJetLi/deepseek-harness-codearts)

RelayDeck 是一个**独立进程**的 AI 账号池网关：登录各家订阅账号（CodeBuddy、Qoder、Cline、MiniMax、TRAE、CodeArts…），
自动续期、自动签到、按额度调度，对外暴露 `/v1/models`、`/v1/chat/completions`、`/v1/responses`，
再挂到 [new-api](https://github.com/QuantumNous/new-api) 后面做计费与分发。

它不依赖 DeepSeek Harness 宿主，也不需要桌面端或浏览器插件——`node src/index.mjs start` 即可运行。

---

## 功能

| 能力 | 说明 |
|---|---|
| **18+ 渠道适配** | CodeBuddy / WorkBuddy / Qoder / Qoder CN / Cline / MiniMax / TRAE / CodeArts / LobsterAI / Loomy / Raccoon / ZCode / Gemini / OpenCode / 七牛 / ModelScope … |
| **多账号池** | 同一渠道多个账号，按顺序、余额、限流状态自动选号 |
| **静默续期** | 30 分钟一轮，到期前自动刷新；一次性 refresh_token 做单飞去重 |
| **积分与签到** | 余额分桶（永久 / 长期 / 临期）、每日签到、CodeBuddy 成长任务、新手奖励 |
| **定时签到** | 每天两次 + 随机浮动，逐渠道结果落盘 |
| **聚合路由** | 同名模型跨渠道合并，按额度到期时间自动选路（`aggregate/*`、`jet-hub-auto/auto`） |
| **OpenAI 兼容网关** | Chat Completions、Responses API、流式 SSE、工具调用、图片输入 |
| **管理端** | 渠道 / 账号 / 积分 / 签到 / 聚合 / 模型 / 用量 / 备份，单页控制台 |
| **Token 用量账本** | 请求级明细 + 最近 7 天历史，按渠道/模型汇总 |
| **备份迁移** | 账号与凭据导入 / 导出（合并或整体替换） |
| **new-api 集成** | 一键把模型目录同步到 new-api 渠道 |

---

## 架构

```
客户端 / Claude Code / Cherry Studio ...
        │  OpenAI 兼容协议
        ▼
new-api（用户、令牌、分组、计费、限流）
        │  内部渠道：http://<docker 网桥 IP>:8326
        ▼
RelayDeck（本项目）
        ├─ 账号池 + 静默续期 + 定时签到
        ├─ 18 个 provider 适配器（协议差异封装在各自模块）
        ├─ 聚合路由（临期额度优先）
        └─ 管理端 :8327
        │
        ▼
上游：CodeBuddy / Qoder / Cline / MiniMax / TRAE / CodeArts / OpenCode ...
```

- **new-api** 负责「对外收钱、发 key、限流、统计」
- **RelayDeck** 负责「把订阅账号变成 OpenAI 接口」
- 网关默认只绑回环或 Docker 网桥地址，**不直接暴露公网**

---

## 快速开始

### 环境

- Node.js `^22.19` 或 `>=24`
- 约 120 MB 磁盘（插件 `lib/` 17 MB + 依赖）

### 本地运行

```bash
git clone https://github.com/weijuns/relaydeck.git
cd relaydeck

# 1. 构建上游插件（vendor 里的源码快照）
cd vendor/dsh-providers-hub
npm install --ignore-scripts
npm run build
node scripts/copy-assets.mjs
cd ../..

# 2. 安装独立版依赖
cd standalone
npm install

# 3. 启动
node src/index.mjs start
```

默认地址：

- 网关：`http://127.0.0.1:8326/v1`
- 管理端：`http://127.0.0.1:8327/`

首次启动会在 `standalone/data/config.json` 生成管理令牌与网关 Key。

### CLI

```bash
node src/index.mjs start                 # 启动网关 + 管理端
node src/index.mjs login qoder           # 终端完成设备码登录
node src/index.mjs accounts [provider]   # 查看账号池
node src/index.mjs models                # 列出模型
node src/index.mjs test buddy/deepseek-v4.1-flash "你好"
node src/index.mjs key                   # 打印 Base URL / API Key
```

---

## 接入 new-api

在 new-api 中新建渠道：

| 字段 | 值 |
|---|---|
| 类型 | OpenAI |
| Base URL | `http://<docker 网桥网关 IP>:8326` |
| 密钥 | RelayDeck 网关 API Key |
| 模型 | 从 `/v1/models` 获取，或运行同步脚本 |

同步模型：

```bash
cd standalone
NEWAPI_BASE=http://127.0.0.1:3000 \
NEWAPI_USER=root NEWAPI_PASS=*** \
CHANNEL_ID=1 HUB_KEY=*** \
node scripts/sync-newapi.mjs
```

模型命名规则：`<provider>/<model>`，例如 `buddy/deepseek-v4.1-flash`、
`qoder/qfmodel`、`cline/anthropic/claude-sonnet-5.5`。

---

## 管理端

| 页面 | 能力 |
|---|---|
| 概览 | 渠道 / 账号 / 模型 / 网关统计、账号健康、快速测试、定时签到 |
| 渠道与账号 | 多账号登录、拖拽排序、改名、重测、重置、启停、刷新凭据、设代理、积分明细 |
| 聚合路由 | 虚拟模型 → 候选列表、逐条开关、排序模式、拒绝非临期 |
| 模型目录 | 搜索、按渠道筛选、复制模型 ID |
| 用量 | Token 账本、7 天趋势、最近请求 |
| 设置 | 网关地址/Key、备份导入导出、new-api 同步、功能开关 |

管理端所有 `/api/*` 都要求 `x-admin-token`。生产环境建议再套一层 nginx Basic Auth。

---

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HUB_HOME` | `./data` | 数据目录（凭据、账号池、密钥） |
| `HUB_GATEWAY_HOST` | `127.0.0.1` | 网关监听地址，**不接受 `0.0.0.0`** |
| `HUB_GATEWAY_PORT` | `8326` | 网关端口 |
| `HUB_GATEWAY_KEY` | 自动生成 | 网关 API Key |
| `HUB_GATEWAY_ENABLED` | `1` | `0` 关闭网关 |
| `HUB_ADMIN_HOST` | `127.0.0.1` | 管理端监听地址 |
| `HUB_ADMIN_PORT` | `8327` | 管理端端口 |
| `HUB_ADMIN_TOKEN` | 自动生成 | 管理端令牌 |
| `HUB_PLUGIN_ENTRY` | 自动探测 | 插件 `lib/index.js` 路径 |

数据目录：

```
$HUB_HOME/
├─ config.json              # 管理令牌 / 网关 Key（0600）
├─ credentials.json         # 各账号凭据（0600，明文 JSON）
├─ jet-hub/
│  ├─ state.json            # 账号索引、模型黑名单、聚合配置
│  └─ permanent-locks.json
├─ openai-gateway/api-key
└─ auto-checkin-config.json # 定时签到
```

---

## 支持渠道

| 登录方式 | 渠道 | 无头服务器 |
|---|---|---|
| 设备码 / 轮询 | Qoder、Qoder CN、Cline、MiniMax、ZCode、CodeBuddy、WorkBuddy、OfficeAce | ✅ |
| 浏览器回调 | CodeArts、TRAE、LobsterAI、Gemini、Accio | ⚠️ 需 SSH 端口转发 |
| 短信 / 扫码 | Loomy、AutoClaw、Raccoon | 部分需要人工 |
| GUI 浏览器 | Magicrew、ZCode 验证码、AStudio 会话导入 | ❌ |
| 粘贴 API Key | OpenCode、七牛、ModelScope | ✅ |

详见 [standalone/docs/PROVIDERS.md](standalone/docs/PROVIDERS.md)。

---

## 项目结构

```
.
├─ standalone/                  RelayDeck 本体
│  ├─ src/
│  │  ├─ index.mjs              CLI 入口
│  │  ├─ host.mjs               宿主 bootstrap（cordis + 插件 apply + RPC）
│  │  ├─ admin.mjs              管理端 HTTP API
│  │  ├─ credentials.mjs        文件型凭据库
│  │  ├─ attachments.mjs        图片附件服务
│  │  ├─ balance.mjs            积分分桶
│  │  ├─ autocheckin.mjs        定时签到调度
│  │  └─ config.mjs             配置与密钥
│  ├─ public/index.html         管理端单页
│  ├─ scripts/                  同步 / 部署脚本
│  ├─ test/                     node:test 单测
│  └─ docs/                     架构 / 部署 / 运维 / 渠道
├─ vendor/dsh-providers-hub/    上游源码快照（MIT，含本地补丁）
├─ patches/                     补丁与上游 PR 记录
└─ docs/RESEARCH.md             上游项目研究报告
```

---

## 开发

```bash
cd standalone
npm run format       # Prettier
npm run lint         # ESLint
npm test             # node:test
npm run check        # lint + test
```

- `.editorconfig` / `.prettierrc` / `eslint.config.mjs`
- 单测覆盖：时间计算、积分分桶、图片嗅探与内存预算
- 部署：`RELAYDECK_ADMIN_TOKEN=*** DEPLOY_HOST=root@host ./scripts/deploy.sh`

---

## 安全与合规

1. **凭据是明文文件**（`0600`）：服务器被入侵等于账号全部泄露，请做好主机安全、限制管理端访问。
2. **不要把管理端直接暴露公网**：至少加 Basic Auth 与 IP 白名单，或只走 SSH 隧道。
3. **合规风险**：把订阅额度转供给他人通常违反上游服务条款，可能导致封号且无申诉渠道；
   在部分司法辖区对外提供生成式 AI 服务还需要备案/许可。请自行评估。
4. **上游协议会变**：腾讯等内容风控会随客户端版本更新新增指纹，需要持续维护
   （本项目已向上游贡献并在 `patches/` 中留档）。

---

## License

本项目（`standalone/`）使用 [MIT License](LICENSE)。

`vendor/dsh-providers-hub/` 是 [iJetLi/dsh-providers-hub](https://gitee.com/iJetLi/deepseek-harness-codearts)
的源码快照，同样为 MIT；归属与本地补丁说明见 [NOTICE](standalone/NOTICE)。
运行时依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm` 等均为 MIT。

---

## 文档

- [架构与实现原理](standalone/docs/ARCHITECTURE.md)
- [服务器部署](standalone/docs/DEPLOY.md)
- [日常运维](standalone/docs/OPERATIONS.md)
- [各渠道登录方式](standalone/docs/PROVIDERS.md)
- [上游项目研究](docs/RESEARCH.md)
- [MonkeyCode 工作区 → Tailscale → RelayDeck → FlClash 全记录](docs/MONKEYCODE-CLASH.md)
- [独立版使用说明](standalone/README.md)
