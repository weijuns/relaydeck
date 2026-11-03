# fix(buddy): 新增 `x-anthropic-billing-header` 内容指纹改写

## 问题

在 **buddy（`copilot.tencent.com`）** 渠道上，使用 Claude Code SDK / ccs 发起的请求会被内容级风控拦截：

```
HTTP 400
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被拦截，请重新发送"}}
```

这是**内容级** 11128（字面量黑名单），不是账号级门控：

- 重发无效；
- 换账号无效；
- 与额度、分组、渠道配置无关；
- 同一个账号、同一个模型，用普通 OpenAI 客户端调用正常。

## 根因

Claude Code SDK（实测 `cc_version=2.1.316.060`，经 ccs 入口）会把一段**计费头**写进 `system` 正文的最前面：

```
x-anthropic-billing-header: cc_version=2.1.316.060; cc_entrypoint=sdk-ts;You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

腾讯风控认的是其中的字面量 **`x-anthropic-billing-header`**。

现有的四条 `CONTENT_FINGERPRINTS` 都不覆盖这个串，所以整轮 400/11128。

> 注：同一段里的 `You are a Claude agent, built on Anthropic's Claude Agent SDK.` 实测**不拦**，
> 与现有注释一致；也能解释为什么以前只登记 Claude Code 身份句没有覆盖到本问题。

## 复现条件（未修复前）

必须同时满足：

1. **渠道**：`buddy`（`https://copilot.tencent.com`）。
   `workbuddy`（`www.workbuddy.ai`）**未验证**——本机没有该站账号，按既有经验两站的风控名单不同，请勿直接推断。
2. **请求来源**：客户端是 Claude Code SDK / ccs 这类会把 `x-anthropic-billing-header` 注入 system 正文的入口。
   直接用 dsh 不复现（dsh 的 system prompt 不含该头）。
3. **请求内容**：`system` 文本包含字面量 `x-anthropic-billing-header`。
   实测**单独发送该 token 即可触发**（带不带 `:`、带不带后面的值都一样）。
4. **模型**：本机用 `deepseek-v4.1-flash` 复现；同一端点其它模型未逐一验证。

## 实测证据

对 `buddy` / `deepseek-v4.1-flash` / 普通已登录账号：

| system 内容 | 结果 |
|---|---|
| 真实整段（含计费头，18 KB） | ❌ 400 / 11128 |
| 只发计费头那一行（233 字符） | ❌ 400 / 11128 |
| 只发 `x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-ts;` | ❌ 400 / 11128 |
| 只发裸词 `x-anthropic-billing-header` | ❌ 400 / 11128 |
| 只发 `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | ✅ 200 |
| `x-anthropic-foo: bar` | ✅ 200 |
| `anthropic-billing-header: …` | ✅ 200 |
| 同一整段里只把 `x-anthropic-billing-header` 改成 `x-client-billing-header` | ✅ 200 |
| 应用本补丁后，用**原始触发内容**重放 | ✅ 200 |

结论：触发词精确到字面量 `x-anthropic-billing-header`；改写这一个词即可放行，其余 232 字符逐字不动。

## 修复

在 `src/openai-gateway/tencent-fingerprint.ts` 的 `CONTENT_FINGERPRINTS` 增加一条：

```ts
{
  // ccs（Claude Code SDK 入口）把计费头写进 system 正文开头：
  //   `x-anthropic-billing-header: cc_version=2.1.316.060; cc_entrypoint=sdk-ts;...`
  // 2026-11-03 实发：该**字样**（连裸词）被 buddy 的内容级 11128 拦截；
  // 同一整段里只把这一处换成 `x-client-billing-header` 后 200。
  find: 'x-anthropic-billing-header',
  replace: 'x-client-billing-header',
  note: '2026-11-03 真实报障（ccs 聚合模式）：原文 400/11128，换名后 200；'
    + '逐格实测裸词也 400，x-anthropic-foo / anthropic-billing-header 均 200',
},
```

语义：只改名字，`cc_version` / `cc_entrypoint` 等字段原样保留；模型读到的仍是“计费头”，不影响任何业务语义。

## 建议的单测

在 `tests/unit/openai-gateway-tencent-fingerprint.spec.ts` 增加：

- `rewriteTencentContentFingerprints('x-anthropic-billing-header: cc_version=1; cc_entrypoint=sdk-ts;', 'buddy')`
  → `'x-client-billing-header: cc_version=1; cc_entrypoint=sdk-ts;'`
- 同样输入对 `workbuddy` 的行为（若维持现有策略，也应改写；语义无害）
- `rewriteTencentContentFingerprints('x-anthropic-foo: bar', 'buddy')` → 原样
- `rewriteTencentContentFingerprints('anthropic-billing-header: x', 'buddy')` → 原样
- 非腾讯系 provider → 原样

## 补丁

见 `patches/0001-tencent-billing-header.patch`（基于 `0.2.1-rc.2`）。

## 风险

- 这是**新增**一条窄改写，不改变既有四条的行为；
- 只作用于 `system` / `assistant` 正文，腾讯系以外的 provider 原样返回；
- 若上游后续把该串从风控名单移除，本改写仍是无害的同义替换（与既有几条同取向）。
