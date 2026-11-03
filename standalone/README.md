# RelayDeck

把 [dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) 从 DeepSeek Harness 插件里拆出来，做成一个**独立进程**：

- 不需要安装 / 启动 dsh 桌面端、CLI、Web 宿主
- 不需要 dsh profile、cordis 配置层、任何 DSH UI
- 对外提供标准 OpenAI 接口（`/v1/models`、`/v1/chat/completions`、`/v1/responses`）
- 自带一个轻量管理端（登录账号、查看账号池、模型目录、连通性测试）

> **"独立"的准确含义**：运行时不依赖 DSH 应用，但仍以 npm 上的 `@deepseek-ai/dsh-llm`（MIT）作为适配器 ABI，以 `@deepseek-ai/cordis`（MIT）作为服务容器。这是**库依赖**，不是宿主依赖；两个包都可以单独 `npm i` 并在裸 Node 进程里使用（已实测）。

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | `^22.19.0` 或 `>=24`（实测 v24.22.2、v26.12.1） |
| 内存 | 常驻约 80–150 MB |
| 磁盘 | 约 120 MB（插件 lib 17 MB + 依赖约 96 MB） |
| 网络 | 能访问各上游 API；不需要出网代理（实测 OpenAI/Anthropic/Gemini 直连可达） |

---

## 2. 安装

### 2.1 从本仓库构建（开发机）

```bash
# 1) 构建插件（若 vendor 里还没有 lib/）
cd vendor/dsh-providers-hub
npm install --ignore-scripts
npm run build
node scripts/copy-assets.mjs      # 复制 Qoder WASM 到 lib/

# 2) 链接依赖
cd ../../standalone
ln -sfn ../vendor/dsh-providers-hub/node_modules node_modules

# 3) 启动
node src/index.mjs start
```

### 2.2 服务器部署

见 [docs/DEPLOY.md](docs/DEPLOY.md)。最短路径：

```bash
/opt/node/bin/node /opt/RelayDeck/standalone/src/index.mjs start
```

---

## 3. 命令

```bash
node src/index.mjs start                 # 启动网关 + 管理端（前台）
node src/index.mjs login qoder           # 终端完成设备码登录
node src/index.mjs accounts [provider]   # 查看账号池
node src/index.mjs models                # 列出所有模型
node src/index.mjs test opencode/big-pickle "你好"   # 走网关发一次请求
node src/index.mjs status                # 打印配置与密钥
node src/index.mjs key                   # 只打印 BASE_URL / API_KEY
```

`login` 支持设备码类渠道（qoder / qodercn / cline / minimax / minimaxintl / zcode 等）；它会打印授权链接并等待结果。

---

## 4. 配置

所有配置都可以用环境变量覆盖，其余持久化在 `HUB_HOME/config.json`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HUB_HOME` | `./data` | 数据目录（凭据、账号池、密钥） |
| `HUB_GATEWAY_HOST` | `127.0.0.1` | 网关监听地址。**不接受 `0.0.0.0` / `::`** |
| `HUB_GATEWAY_PORT` | `8326` | 网关端口 |
| `HUB_GATEWAY_KEY` | 自动生成 | 网关 API Key（客户端用 `Bearer` 携带） |
| `HUB_GATEWAY_ENABLED` | `1` | `0` 关闭网关，只保留管理端和账号功能 |
| `HUB_ADMIN_HOST` | `127.0.0.1` | 管理端监听地址 |
| `HUB_ADMIN_PORT` | `8327` | 管理端端口 |
| `HUB_ADMIN_TOKEN` | 自动生成 | 管理端 API 令牌 |
| `HUB_PLUGIN_ENTRY` | 自动探测 | 插件 `lib/index.js` 的绝对路径 |

数据目录结构：

```
$HUB_HOME/
├─ config.json              # 管理令牌 / 网关 Key / 监听参数（0600）
├─ credentials.json         # 各账号凭据（0600，明文 JSON）
├─ jet-hub/
│  ├─ state.json            # 账号索引、模型黑名单、聚合顺序等
│  └─ permanent-locks.json  # 永久积分锁定
└─ openai-gateway/
   └─ api-key               # 网关 Key 的插件侧副本
```

---

## 5. 管理端

启动后打开 `http://<HUB_ADMIN_HOST>:<HUB_ADMIN_PORT>/`。

- 首次打开会提示输入**管理令牌**（`HUB_HOME/config.json` 的 `adminToken`，或启动日志里的"管理令牌"）
- 深色/浅色主题、响应式布局（手机可用）
- 五个页面：**概览 / 渠道与账号 / 聚合路由 / 模型目录 / 设置**
- 所有 `/api/*` 都要求 `x-admin-token` 头（或 `?token=`）

### 功能

| 页面 | 能力 |
|---|---|
| 概览 | 渠道/账号/模型/网关统计，账号健康列表，快速测试，**定时签到**面板 |
| 渠道与账号 | 多账号登录、账号排序、改名、重测、重置、启停、刷新凭据、删除、**积分明细**、一键签到、模型开关、永久积分锁定、领取积分+成长任务 |
| 聚合路由 | 虚拟模型 → 候选列表，逐条开关参与轮换；排序模式；一键"拒绝非临期" |
| 模型目录 | 搜索、按渠道筛选、一键复制模型 ID |
| 用量 | Token 账本、渠道汇总、最近 7 天趋势、最近请求明细 |
| 设置 | 复制网关地址/Key、运行信息、**同步模型到 new-api**、**账号备份导出/导入**、原生搜索/会话负载均衡/XFF 开关 |

### 管理 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/overview` | 概览数据 |
| GET | `/api/health` | 进程/网关心跳 |
| GET | `/api/models` | 模型目录 |
| POST | `/api/login` | 开始登录，返回 `{id,url}` |
| GET | `/api/login/:id` | 轮询登录状态 |
| POST | `/api/accounts/:id/enabled` | 单账号启停 |
| POST | `/api/accounts/:id/refresh` | 刷新该账号凭据 |
| DELETE | `/api/accounts/:id` | 删除账号 |
| GET | `/api/aggregate` | 聚合目录与候选状态 |
| POST | `/api/aggregate/gate` | 切换某候选是否参与轮换 |
| POST | `/api/aggregate/reject-non-expiring` | 恢复"未接入临期渠道默认不参与" |
| POST | `/api/aggregate/order-mode` | `expiry` / `manual` |
| POST | `/api/newapi/sync` | 把模型目录同步到 new-api 渠道 |
| POST | `/api/rpc` | 白名单透传 Jet Hub RPC（重测/重置/模型开关/备份/用量/代理等） |
| GET | `/api/credits` | 各账号余额（永久/长期/临期分桶）与今日签到状态 |
| POST | `/api/credits/claim` | 一键签到（可指定 provider） |
| GET | `/api/autocheckin` | 定时签到配置与下次执行时间 |
| POST | `/api/autocheckin` | 修改开关 / 时间 / 随机浮动 |
| POST | `/api/autocheckin/run` | 立即执行一轮签到 |

聚合路由的**请求路径**仍然由插件自己完成（`aggregate/<model>` 与 `jet-hub-auto/auto`），管理端只负责配置参与候选；不需要额外服务。

### 反向代理与鉴权

生产环境不要把管理端直接暴露到公网。推荐两层保护：

1. nginx `auth_basic`（HTTP Basic）
2. 应用层 `adminToken`

示例见 [docs/DEPLOY.md](docs/DEPLOY.md#管理端反向代理)。

---

## 6. 接入 new-api

在 new-api 中新建渠道：

| 字段 | 值 |
|---|---|
| 类型 | OpenAI |
| Base URL | `http://<docker网桥网关IP>:8326`（同机 Docker 场景；见部署文档） |
| 密钥 | 网关 API Key |
| 模型 | 从网关 `/v1/models` 获取，或留空后点"获取模型列表" |

也可以用脚本同步模型（账号增减后模型会变）：

```bash
NEWAPI_BASE=http://127.0.0.1:3000 \
NEWAPI_USER=root NEWAPI_PASS=... \
CHANNEL_ID=1 HUB_KEY=... \
node scripts/sync-newapi.mjs
```

模型命名规则是 `<provider>/<model>`，例如：

```
opencode/big-pickle
qoder/qwen3.8-max
minimax/MiniMax-M3.1-Flash-Preview
cline/anthropic/claude-sonnet-5.5     # 上游模型名里本身带 / 的情况
```

---

## 7. 支持哪些渠道

插件本身注册 18+ 个 provider。独立版**不需要为每个渠道写代码**——它们由插件的 `apply()` 一并装配。能不能用，取决于**登录方式**：

- ✅ **设备码 / 轮询类**（可在无头服务器完成）：qoder、qodercn、cline、minimax、minimaxintl、zcode、buddy、workbuddy、loomy（短信）、autoclaw（短信）、officeace、codely
- ⚠️ **本地回环回调类**（需要浏览器能访问服务器 `127.0.0.1:<port>`）：codearts、trae、lobsterai、gemini、accio、autoclawintl —— 远程服务器需要 SSH 端口转发
- ❌ **必须有 GUI 浏览器**：magicrew、zcode 的验证码/领取、Astudio 的客户端会话导入
- ✅ **粘贴 API Key**：opencode、qiniu、modelscope

完整表格与操作步骤见 [docs/PROVIDERS.md](docs/PROVIDERS.md)。

---

## 8. 与上游的关系

- 上游源码位于 `vendor/dsh-providers-hub/`，**保持原样**，便于对照和升级
- 本目录只新增：宿主、凭据存储、管理端、CLI、部署脚本、文档
- 升级上游：替换 `vendor/dsh-providers-hub/` → `npm install && npm run build && node scripts/copy-assets.mjs` → 重启
- 上游许可证：MIT（本项目的宿主代码同样可按 MIT 使用）

---

## 9. 开发与校验

```bash
npm install          # 首次
npm run format       # Prettier 格式化（src / scripts / test / public）
npm run lint         # ESLint
npm test             # node:test（纯函数单测）
npm run check        # lint + test
```

- 缩进/换行/编码：`.editorconfig`
- 格式化：`.prettierrc`（2 空格、单引号、无分号、printWidth 100）
- Lint：`eslint.config.mjs`（flat config）
- 部署：`RELAYDECK_ADMIN_TOKEN=... ./scripts/deploy.sh`（需要 SSH 密钥登录）

## 10. 已知限制

1. **不是所有渠道都能无头登录**（见第 7 节）。
2. **凭据是明文**：参考 dsh 的设计，`credentials.json` 为 0600 明文 JSON。请限制主机访问。
3. **单进程单节点**：没有多副本协调；账号池状态文件不适合多进程同时写。
4. **图片输入**依赖 dsh 的附件服务，独立版未实现 `saveImage`，收到 `image_url` 会明确报错（文本能力不受影响）。
5. **上游协议随时会变**：这是订阅逆向类项目的固有风险，适配器需要跟随上游更新。
6. **合规风险**：转售/共享订阅额度通常违反上游 ToS，账号可能被封，且无申诉渠道。
