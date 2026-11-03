#!/usr/bin/env node
/**
 * 把 dsh-hub 的模型目录同步到 new-api 的渠道里。
 *
 * 用法：
 *   NEWAPI_BASE=http://127.0.0.1:3000 \
 *   NEWAPI_USER=root NEWAPI_PASS=xxxx \
 *   CHANNEL_ID=1 \
 *   node scripts/sync-newapi.mjs
 *
 * 也可以直接给 NEWAPI_JWT（管理端 access_token）跳过登录。
 */
const base = (process.env.NEWAPI_BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const channelId = process.env.CHANNEL_ID
if (!channelId) {
  console.error('缺少 CHANNEL_ID')
  process.exit(1)
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

async function login() {
  if (process.env.NEWAPI_JWT) return process.env.NEWAPI_JWT
  const user = process.env.NEWAPI_USER
  const pass = process.env.NEWAPI_PASS
  if (!user || !pass) throw new Error('需要 NEWAPI_JWT 或 NEWAPI_USER/NEWAPI_PASS')
  const res = await api('/api/user/login', {
    method: 'POST',
    body: { username: user, password: pass },
  })
  if (!res?.data?.access_token) throw new Error('登录失败：' + JSON.stringify(res).slice(0, 300))
  return res.data.access_token
}

async function main() {
  const jwt = await login()

  const channel = await api(`/api/channel/${channelId}`, { token: jwt })
  const ch = channel?.data
  if (!ch) throw new Error('渠道不存在：' + channelId)
  console.log(
    `渠道 #${channelId} ${ch.name} 当前模型数：${
      String(ch.models || '')
        .split(',')
        .filter(Boolean).length
    }`,
  )
  // ⚠️ 不能把 GET 返回的整个对象回传：其中包含 `status` 等只读字段，
  //    UpdateChannel 见到 `status` 会直接返回 "Invalid parameters"。
  //    只提交可编辑字段。

  // 从网关读取模型
  const gwBase = process.env.HUB_BASE ?? 'http://127.0.0.1:8326'
  const gwKey = process.env.HUB_KEY
  if (!gwKey) throw new Error('需要 HUB_KEY（网关 API Key）')
  const models = await (
    await fetch(`${gwBase}/v1/models`, { headers: { authorization: `Bearer ${gwKey}` } })
  ).json()
  const ids = (models.data ?? []).map((m) => m.id)
  if (ids.length === 0) throw new Error('网关没有返回任何模型')

  const res = await api(`/api/channel/`, {
    method: 'PUT',
    token: jwt,
    body: {
      id: Number(channelId),
      models: ids.join(','),
      test_model: ids.includes(ch.test_model) ? ch.test_model : ids[0],
    },
  })
  if (res?.success === false) throw new Error(`更新失败：${res.message ?? JSON.stringify(res)}`)
  console.log(`已同步 ${ids.length} 个模型到渠道 #${channelId}`)
}

main().catch((error) => {
  console.error(`[sync] ${error.message}`)
  process.exit(1)
})
