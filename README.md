# 中转站计划

把订阅制 AI 编程服务的额度，接成一个标准 OpenAI 兼容接口，再挂到 new-api 上做统一分发。

本仓库包含两部分：

| 目录 | 内容 |
|---|---|
| `vendor/dsh-providers-hub/` | 上游开源项目 [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) 的源码快照（MIT），**未修改** |
| `standalone/` | 我们写的**独立宿主**：不启动 DeepSeek Harness，直接加载插件的 `apply()`，对外提供网关和管理端 |

## 它做了什么

```
用户 / 客户端
   │  OpenAI 兼容协议
   ▼
new-api（计费、用户、令牌、分组）
   │  内部渠道：http://172.20.0.1:8326
   ▼
RelayDeck（本项目）
   │  账号池 + 静默续期 + 18 个 provider 适配器
   ▼
上游：Qoder / Cline / MiniMax / Trae / CodeBuddy / CodeArts / OpenCode ...
```

- **new-api** 负责"对外收钱、发 key、限流、统计"
- **RelayDeck** 负责"把订阅账号变成 OpenAI 接口"
- 两者通过 Docker 网桥地址直连，网关端口**不对公网开放**

## 线上地址

| 用途 | 地址 |
|---|---|
| new-api 后台 / API | `https://api.example.com` · `https://api.example.com/v1` |
| RelayDeck 管理端 | `https://relay.example.com` |

旧地址 `api.example.com` 仍然可用。

## 快速开始

```bash
cd standalone
ln -sfn ../vendor/dsh-providers-hub/node_modules node_modules   # 开发环境；部署环境见文档
npm run build --prefix ../vendor/dsh-providers-hub              # 构建插件 lib/
node src/index.mjs start
```

默认监听：

- 网关 `http://127.0.0.1:8326/v1`
- 管理端 `http://127.0.0.1:8327/`

首次启动会在 `standalone/data/config.json` 生成两把密钥：管理令牌与网关 API Key。

## 文档

- [独立版说明（安装、命令、配置）](standalone/README.md)
- [架构与实现原理](standalone/docs/ARCHITECTURE.md)
- [服务器部署（systemd / Docker / nginx）](standalone/docs/DEPLOY.md)
- [日常运维：登录账号、模型同步、排障](standalone/docs/OPERATIONS.md)
- [各 provider 登录方式与可行性](standalone/docs/PROVIDERS.md)

## 重要提醒

1. **合规**：把订阅账号的额度转供给他人，通常违反上游服务条款。请自行评估法律与账号风险；"公益"不等于"无风险"。
2. **不要用来源不明的二改版本**：本项目只基于上游官方源码，宿主代码在本仓库可审计。
3. **凭据是明文文件**（`0600`）：服务器被入侵等于账号全部泄露，请做好主机安全。
