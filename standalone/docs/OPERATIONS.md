# 日常运维

## 1. 登录账号

### 方式 A：管理端（推荐）

打开管理端 → 找到渠道卡片 → **登录新账号**：

- 页面会给出授权链接（设备码类还会显示 user_code）
- 在**你自己的浏览器**里打开链接并完成授权
- 管理端每秒轮询，成功后自动刷新账号列表

### 方式 B：命令行

```bash
node src/index.mjs login qoder
```

输出示例：

```
  请在浏览器打开下面的地址完成授权：
  https://qoder.com/device/selectAccounts?challenge=...&nonce=...
  等待授权结果…（Ctrl+C 取消）
```

把链接复制到浏览器完成授权即可，命令行会自动把账号写入账号池。

### 方式 C：导入已有备份

如果你之前用过 dsh 版本，可以直接导入 Jet Hub 的账号备份：

```bash
# 在 Node 环境里调用插件的 importBackup（需要自己写 10 行胶水代码）
```

> 备份导入功能尚未封装成 CLI 命令；账号格式见 `ARCHITECTURE.md` 第 4 节。

---

## 2. 账号池管理

| 操作 | 管理端 | 说明 |
|---|---|---|
| 启用/停用单个账号 | 账号行的"停用/启用" | 只影响选号，不影响续期 |
| 启用/停用整条渠道 | 渠道卡片的"全部停用" | 批量修改该 provider 的全部账号 |
| 删除账号 | 账号行的"删除" | 同时删除 `credentials.json` 里的凭据 |
| 查看过期时间 | 账号行副标题 | `过期 2026/11/02 22:00 · 可续期` |

命令行：

```bash
node src/index.mjs accounts            # 全部
node src/index.mjs accounts qoder      # 指定渠道
```

---

## 3. 模型同步到 new-api

渠道增减账号后，可用模型会变化（例如新登录 Qoder 后才出现 `qoder/*`）。两种做法：

### 手动

new-api 后台 → 渠道 → 编辑 → 点"获取模型列表" → 保存。

### 脚本

```bash
NEWAPI_BASE=http://127.0.0.1:3000 \
NEWAPI_USER=root NEWAPI_PASS='...' \
CHANNEL_ID=1 HUB_KEY='<网关Key>' \
node scripts/sync-newapi.mjs
```

脚本会读取 `http://127.0.0.1:8326/v1/models`（或 `HUB_BASE`）并整体更新渠道的模型列表。

> ⚠️ 更新 new-api 渠道时**只提交 `id` / `models` / `test_model`**。把 `GET /api/channel/:id`
> 的整个对象回传会带上只读字段 `status`，`UpdateChannel` 遇到它会直接返回
> `Invalid parameters`（HTTP 200 但 `success:false`）。脚本已按此处理。

---

## 3.1 客户端报 `Insufficient user quota`

new-api 会**同时**检查「令牌额度」和「令牌所属用户额度」。令牌勾了"无限额度"但用户
`quota=0` 时，仍会返回：

```
Insufficient user quota, remaining quota: ＄0.000000
```

处理：在 new-api 用户管理里给该用户充值/设置额度，或用 root（初始额度 1 亿）名下的令牌。
公益站通常给用户组设置固定额度，而不是逐令牌无限。

---

## 4. 查看状态

```bash
systemctl status RelayDeck
journalctl -u RelayDeck -n 100 --no-pager
curl -s -H "x-admin-token: <token>" http://127.0.0.1:8327/api/overview | jq
node src/index.mjs models
```

关键日志：

| 日志 | 含义 |
|---|---|
| `[admin] 管理端已监听 …` | 管理端启动成功 |
| `[openai-gateway] 已监听 http://…/v1` | 网关启动成功 |
| `[openai-gateway] 网关期望运行但未能监听：listen EADDRINUSE` | 端口被占，见排障 |
| `[jet-hub] settings 服务不可用，账号列表仅存在于内存中` | 正常（独立版没有 settings，会走 `state.json`） |

---

## 5. 排障

### 5.1 网关端口被占（EADDRINUSE）

```bash
ss -tlnp | grep 8326
```

常见原因：本机已有一个 dsh 桌面端占用了 8326。改配置：

```bash
HUB_GATEWAY_PORT=18326 node src/index.mjs start
```

（systemd 场景修改 unit 里的 `HUB_GATEWAY_PORT`。）

### 5.2 new-api 报 `No available channel for model ...`

按顺序检查：

1. 模型名是否与网关 `/v1/models` 一致（区分大小写、包含 `provider/` 前缀）
2. new-api 渠道的**分组**是否与令牌/用户分组一致
3. 渠道是否被自动禁用（建渠道后第一次请求前，new-api 有 ~1 秒的能力缓存）
4. `docker exec new-api wget ... http://<网桥IP>:8326/v1/models` 是否 200

### 5.3 上游 401 / 403

- 账号过期：管理端看 `expiresAt`，或在 CLI 里重新 `login`
- 刷新失败：`journalctl` 里搜 `refresh`，确认是网络问题还是 `invalid_grant`（后者只能重新登录）
- 出口 IP 被风控：部分渠道要求一号一 IP，插件支持账号级代理字段（`qoderProxy` / `minimaxIntlProxy` / `geminiProxy` / `opencodeProxy`），但目前没有管理端入口，需要改 `state.json`

### 5.4 管理端 500

```bash
tail -20 /www/wwwlogs/nginx_error.log
```

- `Permission denied` 打开 htpasswd → `chown www:www` + `chmod 640`
- `connect() failed (111: Connection refused)` → hub 没起或端口不对

### 5.5 登录后账号没出现

- 设备码类：确认授权页面提示"已授权"，管理端轮询需要保持页面打开
- 本地回调类：远程服务器必须做 SSH 转发，例如 TRAE 固定端口 18080：

  ```bash
  ssh -L 18080:127.0.0.1:18080 root@<服务器>
  ```

  然后在本地浏览器打开管理端给出的授权链接。

### 5.6 内存不足

```bash
systemctl status RelayDeck   # 看 Memory 行
```

- 单进程 80–150 MB 属正常
- 如果服务器总内存只有 2GB，注意 Docker 里其它服务的占用；unit 已设 `MemoryMax=800M`
- 不要在同一个 `HUB_HOME` 上跑多个实例

---

## 6. 备份与恢复

```bash
# 备份
tar czf RelayDeck-data-$(date +%F).tar.gz /opt/RelayDeck/data

# 恢复
systemctl stop RelayDeck
tar xzf RelayDeck-data-YYYY-MM-DD.tar.gz -C /
systemctl start RelayDeck
```

`data/` 里包含**明文凭据**，备份文件请加密保存。

---

## 7. 安全清单

- [ ] 管理端只经 nginx + Basic Auth 暴露，或只走 SSH 隧道
- [ ] 管理端令牌（`config.json` 的 `adminToken`）足够长且未泄露
- [ ] 网关端口只对 Docker 网段开放（`ufw allow from 172.20.0.0/16`）
- [ ] `data/` 权限 700，`credentials.json` 600
- [ ] 服务器 root 密码已更换、SSH 已改用密钥
- [ ] 定期检查账号是否被上游封禁（401/403 激增）

---

## 8. 聚合路由（aggregate）

### 它是怎么工作的

上游插件把「同一个真实模型在多个渠道的条目」归到**一个规范名**下，例如
`Deepseek-V4.1-Flash` 在 `buddy` 和 `codebuddy` 都有。请求 `aggregate/<规范名>` 时：

1. 取该虚拟模型的全部候选；
2. 按**门控**过滤：显式拒绝 > 显式允许 > 渠道是否接入临期折算；
3. 按**额度到期时间**排序（`expiry` 模式）或**手工顺序**（`manual` 模式）；
4. 依次尝试候选，只在**还没输出任何可见内容**时切换；
5. `aggregate/auto` 则把所有参与轮换渠道的全部模型当作候选池。

`jet-hub-auto/auto` 是另一套自动选路（不看规范名归并，直接按渠道优先级）。

### 哪些渠道默认参与

- **已接入临期折算**（`WIRED_EXPIRY_PROVIDERS`，18 家）：默认参与，可逐条拒绝；
- **未接入**：默认**不参与**，需要在面板里逐条手工打开；
- 这样做的原因是：没有到期信息时，按临期排序会把未知当已知。

### 管理端操作

打开「聚合路由」页：

| 操作 | 效果 |
|---|---|
| 展开某个虚拟模型 | 看到它在各渠道的真实 `modelId` 与倍率 |
| 候选右侧开关 | 已接入渠道：关 = 写入拒绝表；未接入渠道：开 = 写入白名单 |
| 排序方式 | `临期优先` 或 `手工顺序` |
| 拒绝非临期 | 清空所有"未接入渠道"的手工放行，恢复默认 |

改动立即写入 `state.json`，下一次请求生效；不需要重启。

### 验证

```bash
curl https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"aggregate/auto","messages":[{"role":"user","content":"hi"}]}'
```

## 9. 常见运维动作

| 想做 | 做法 |
|---|---|
| 看进程健康 | 管理端「概览」，或 `curl -H "x-admin-token: …" /api/health` |
| 刷新某个账号凭据 | 账号行「刷新」按钮 |
| 换主题 | 右上角月亮/太阳图标 |
| 同步新模型到 new-api | 「设置 → 同步模型到 new-api」 |
| 换管理令牌 | 右上角钥匙图标，或改 `config.json` 后重启 |


---

## 10. 积分与签到

### 积分明细

「渠道与账号」页每个账号下方会显示：

```
5912.10   永久 0   长期 1800   临期 4112.10   今日已签 · 连续 3 天
```

分桶规则（`windowDays` 由上游返回，默认 15 天）：

| 桶 | 判据 |
|---|---|
| 永久 | 资源包没有 `deductionEndTime`（上游不下发到期时间） |
| 长期 | 到期时间距今 > `windowDays` |
| 临期 | 到期时间距今 ≤ `windowDays` |

颜色：总数蓝、永久绿、长期黄、临期红。读取失败会显示具体错误，不会把失败当成 0。

### 定时签到

「概览 → 定时签到」：

- 开关、两个执行时刻（UTC+8）、随机浮动分钟数
- 下次执行时间与倒计时
- 上次结果与逐渠道明细

配置保存在 `$HUB_HOME/auto-checkin-config.json`：

```json
{
  "enabled": true,
  "times": ["09:00", "21:00"],
  "jitterMinutes": 10,
  "lastSlot": "2026-11-03 09:00",
  "lastRun": { "at": 1793667935452, "totals": { "claimed": 1, "failed": 0 }, "channels": [] }
}
```

⚠️ 进程在计划时刻**不在运行**时不会补跑；重启后只排下一轮。

### 与插件自带自动签到的关系

插件自带的是「每日首次启动跑一次」，没有时刻表。独立版把它**关闭**（`usage.autoCheckin enabled=false`），
改由本项目的调度器按时刻表调用同一个 `credits.claimAll` —— 领取逻辑完全复用，只是换了调度层。


---

## 11. 用量与其它运维面板

- **用量页**：Token 账本（内存 500 条）+ 最近 7 天历史（落盘 90 天）。按渠道/模型汇总，
  显示请求数、输入/输出、缓存命中、失败数、平均首字与速度。
- **Cline**：渠道页「订阅额度」看 5 小时/周/月窗口；账号「更多 → 请求记录」看逐笔调用。
- **功能开关**（设置页）：渠道原生搜索、ZCode 会话负载均衡、MiniMax 国际站 XFF。
- **排序**：账号卡片与左侧渠道列表都支持拖拽，顺序即选号优先级。
