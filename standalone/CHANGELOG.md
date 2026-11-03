# Changelog

## [0.1.2] - 2026-11-03

- 新增附件服务（`src/attachments.mjs`）：图片输入可用
  - 支持 PNG / JPEG / GIF / WebP，内容寻址（sha256）去重
  - 内存存储：单张 ≤20MB、总量 ≤128MB、最多 128 张、10 分钟 TTL
  - 修复 `当前 profile 未装载附件服务` 的 400


## [0.1.0] - 2026-11-03

首个可用版本：

- 独立宿主：不启动 DeepSeek Harness，直接加载上游插件 `apply()`
- OpenAI 兼容网关：`/v1/models`、`/v1/chat/completions`、`/v1/responses`
- 管理端：渠道/账号、多账号登录、积分明细、签到、聚合路由、模型开关、备份
- Token 用量账本与最近 7 天历史
- Cline 订阅额度与请求记录
- 定时签到（每天两次 + 随机浮动）
- 接入 new-api，支持一键同步模型
