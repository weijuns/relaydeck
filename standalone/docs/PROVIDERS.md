# 各渠道登录方式与可行性

> 结论来自对上游源码的逐文件核对与实测。**"能不能用"取决于登录方式，不取决于适配器。**

## 1. 总表

| provider | 产品 | 登录方式 | 无头服务器 | 续期 | 备注 |
|---|---|---|---|---|---|
| `qoder` | Qoder（国际） | 设备码轮询 | ✅ | refresh_token | Qwen 系列，WASM 加密推理 |
| `qodercn` | Qoder 中国版 | 设备码轮询 | ✅ | refresh_token | 同上 |
| `cline` | Cline | WorkOS 设备码 | ✅ | refresh_token | 标准 OpenAI 协议 |
| `minimax` | MiniMax Code 中国版 | 设备码 + PKCE | ✅ | refresh_token | Anthropic Messages 协议 |
| `minimaxintl` | MiniMax 国际版 | 同上 | ✅ | refresh_token | 同上 |
| `zcode` | ZCode（智谱） | 服务端设备授权 | ✅（登录）/ ⚠️（验证码） | 无 | 领取积分需要 GUI 浏览器 |
| `buddy` | CodeBuddy（腾讯） | 授权页 + 轮询 | ✅ | refresh_token | 有内容指纹风控 |
| `workbuddy` | WorkBuddy 国际版 | 同上 | ✅ | refresh_token | 同上 |
| `loomy` | Loomy（讯飞） | 短信验证码 | ✅ | 无 | 登录需要手机号 |
| `autoclaw` | AutoClaw 国内 | 短信验证码 | ✅ | 依上游 | — |
| `officeace` | OfficeAce（华为云） | 服务端 OAuth + 轮询 | ✅ | 一次性 refresh | 无手动签到 |
| `codely` | Codely | 设备码 | ✅ | — | — |
| `opencode` | OpenCode | **粘贴 API Key** / 匿名 | ✅ | 无（静态 key） | 匿名也有免费模型 |
| `qiniu` | 七牛云 | **粘贴 API Key** | ✅ | 无 | 无积分接口 |
| `modelscope` | ModelScope | **粘贴 API Key** | ✅ | 无 | — |
| `codearts` | CodeArts（华为云） | 浏览器回调（本地端口） | ⚠️ 需 SSH 转发 | refresh_token | HMAC 签名 |
| `trae` | TRAE（字节） | 浏览器回调（18080） | ⚠️ 需 SSH 转发 | refresh_token | 自定义 SOLO 协议 |
| `lobsterai` | LobsterAI（有道） | 浏览器回调 | ⚠️ 需 SSH 转发 | refresh_token | — |
| `gemini` | Gemini Code Assist | 浏览器回调（8845） | ⚠️ 需 SSH 转发 | refresh_token | Cloud Code Assist 协议 |
| `accio` | Accio（阿里） | 浏览器回调（随机端口） | ⚠️ 需 SSH 转发 | refresh_token | — |
| `autoclawintl` | AutoClaw 国际 | 浏览器回调 | ⚠️ 需 SSH 转发 | — | — |
| `raccoon` | Raccoon（商汤） | 微信扫码 / 短信 | ❌ 页面 | — | 需要本地页面承载 |
| `magicrew` | 超级麦吉 | 浏览器自动化 | ❌ | — | 需要 GUI Chromium |
| `astudio` | 讯飞 AstronStudio | 客户端会话导入 | ❌ | — | 需要本机 Electron 会话 |

图例：✅ 纯命令行可完成；⚠️ 可以，但需要把回调端口转发到本地；❌ 必须有图形界面。

---

## 2. 设备码类（最推荐）

以 Qoder 为例：

```bash
node src/index.mjs login qoder
```

输出：

```
  请在浏览器打开下面的地址完成授权：
  https://qoder.com/device/selectAccounts?challenge=...&challenge_method=S256...
  等待授权结果…
```

在任意设备上打开链接 → 选择账号 → 授权 → 命令行自动完成。

Cline 会额外给出 `user_code`：

```
https://authkit.cline.bot/device?user_code=LZXF-FLJS
```

MiniMax / ZCode 同理。

---

## 3. 粘贴 API Key 类

目前管理端没有"手工添加 Key"的表单（适配器的凭据形状因渠道而异）。可以用 CLI 走一次性的 Node 脚本，或直接在 `credentials.json` 里写入正确形状。

### OpenCode（最简单）

OpenCode 的匿名通道无需账号即可用免费模型，`/v1/models` 里已经能看到：

```
opencode/big-pickle
opencode/beam-free
opencode/deepseek-v4.1-flash-free
...
```

要接入付费 key，凭据形状：

```json
{ "api_key": "sk-...", "nickname": "主号" }
```

对应 ref 为 `OPENCODE_ACCOUNT_<后缀>`，并在 `state.json` 的 `accounts` 里加一条：

```json
{
  "id": "opencode-1",
  "provider": "opencode",
  "nickname": "主号",
  "enabled": true,
  "credentialRef": "OPENCODE_ACCOUNT_1",
  "createdAt": 1793620000000,
  "refreshable": false
}
```

### 七牛云 / ModelScope

形状分别是 `{"api_key":"..."}` 与 `{"access_token":"..."}`（以各 provider 的 `*-rpc.ts` 为准），ref 前缀分别为 `QINIU_ACCOUNT_` / `MODELSCOPE_ACCOUNT_`。

> 这三家的"粘贴 Key"流程本质上是写两条记录；如果需要，我可以补一个 `add-key` 子命令。

---

## 4. 本地回调类与 SSH 转发

这些渠道的登录流程会在**服务器本地**监听一个端口，浏览器授权后回调到 `127.0.0.1:<port>`。如果浏览器在你自己电脑上，就必须把该端口转发过去。

| provider | 固定端口 | 转发命令 |
|---|---|---|
| `trae` | 18080（占用则随机） | `ssh -L 18080:127.0.0.1:18080 root@<服务器>` |
| `gemini` | 8845（占用则随机） | `ssh -L 8845:127.0.0.1:8845 root@<服务器>` |
| `codearts` | 随机（≥10000） | 先 `login` 看日志里的端口，再转发 |
| `lobsterai` / `accio` / `autoclawintl` | 随机 | 同上 |

流程：

1. 先开 SSH 隧道
2. 再在管理端点"登录"或在服务器执行 `node src/index.mjs login trae`
3. 把打印出的授权链接复制到**本地浏览器**打开
4. 授权后的回调会经隧道回到服务器进程

---

## 5. 短信类

`loomy` / `autoclaw` 走短信验证码。上游 CLI 没有交互式提示，因此需要调用 auth 服务的登录方法并传入手机号/验证码；当前管理端 UI 不适合这类流程，建议直接在服务器上跑一段脚本（`svc.login({ phone })` 后按提示输入验证码）。

---

## 6. 账号级代理

上游支持为以下渠道设置**每个账号独立的出口 IP**：

- `qoderProxy`
- `minimaxIntlProxy`
- `geminiProxy`
- `opencodeProxy`

字段写在 `state.json` 的账号条目里，例如：

```json
{ "id": "qoder-1", "provider": "qoder", "qoderProxy": "http://user:pass@1.2.3.4:8080", ... }
```

改完后重启服务。多账号同 IP 容易被风控，特别是 Qoder / OpenCode。

---

## 7. 建议的首批渠道

按"能无头登录 + 协议简单 + 免费额度"排序：

1. **OpenCode** —— 零配置，匿名免费模型即可验证整条链路
2. **Qoder / Qoder CN** —— 设备码，Qwen 系列额度价值高
3. **Cline** —— 设备码，标准 OpenAI 协议，最稳
4. **MiniMax** —— 设备码，Anthropic 协议
5. **ZCode** —— 设备码（登录容易，验证码相关功能受限）

先接 1–2 个跑通，再逐个加。每加一个账号，记得把新模型同步到 new-api（见 `OPERATIONS.md` 第 3 节）。
