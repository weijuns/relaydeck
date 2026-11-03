#!/usr/bin/env node
/**
 * RelayDeck 独立版入口。
 *
 *   relaydeck start                 启动网关 + 管理端
 *   relaydeck login <provider>      在终端完成登录（设备码/授权链接）
 *   relaydeck accounts [provider]   查看账号池
 *   relaydeck models                列出可用模型
 *   relaydeck test <model> [prompt] 通过网关发一次请求
 *   relaydeck status                查看配置与运行状态
 *   relaydeck key                   打印网关 API Key 与 Base URL
 */
import { startHost, waitForGateway, stopHost } from './host.mjs'
import { createAdminServer, errorMessage } from './admin.mjs'

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, ...rest] = arg.slice(2).split('=')
      flags[k] = rest.length > 0 ? rest.join('=') : true
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cmdStart(config) {
  const host = await startHost()
  await waitForGateway(host.config)
  const admin = createAdminServer({ ...host, logger: console })
  await admin.start()
  console.log('')
  console.log('  RelayDeck 已启动')
  console.log(`  网关      http://${host.config.gateway.host}:${host.config.gateway.port}/v1`)
  console.log(`  管理端    http://${host.config.admin.host}:${host.config.admin.port}/`)
  console.log(`  管理令牌  ${host.config.admin.token}`)
  console.log(`  数据目录  ${host.config.home}`)
  console.log('')
  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    console.log(`\n[relaydeck] 收到 ${signal}，正在退出…`)
    await admin.close().catch(() => {})
    await stopHost(host).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // 常驻
  await new Promise(() => {})
}

async function cmdLogin(config, provider) {
  if (!provider) throw new Error('用法：relaydeck login <provider>')
  const { ctx, pool } = await startHost()
  const svc = ctx.get(`${provider}Auth`)
  if (svc === undefined) {
    const ids = ctx.llm.listProviders().map((p) => p.id)
    throw new Error(`未知渠道 ${provider}。可用：${ids.join(', ')}`)
  }
  const suffix = String(Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase()
  const accountId = `${provider}-${suffix.toLowerCase()}`
  const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`
  if (typeof svc.startLogin === 'function') {
    const started = await svc.startLogin({ accountId, refName, pool })
    console.log('')
    console.log('  请在浏览器打开下面的地址完成授权：')
    console.log(`  ${started.loginUrl}`)
    console.log('')
    console.log('  等待授权结果…（Ctrl+C 取消）')
    try {
      await started.result
      console.log(`\n  登录成功，账号已加入账号池：${accountId}`)
    } finally {
      try { started.close?.() } catch {}
    }
  } else if (typeof svc.login === 'function') {
    console.log(`  渠道 ${provider} 使用阻塞式登录，请按提示完成…`)
    await svc.login({ accountId, refName, pool })
    console.log(`  登录成功，账号已加入账号池：${accountId}`)
  } else {
    throw new Error(`渠道 ${provider} 不支持命令行登录`)
  }
  await stopHost({ ctx })
}

async function cmdAccounts(config, provider) {
  const { ctx, pool } = await startHost()
  const all = provider ? await pool.listAccounts(provider) : await pool.listAllAccounts()
  if (all.length === 0) {
    console.log('（账号池为空）')
  } else {
    for (const a of all) {
      const exp = a.expiresAt ? new Date(a.expiresAt).toISOString() : '-'
      console.log(`${a.provider}\t${a.id}\t${a.nickname ?? ''}\tenabled=${a.enabled !== false}\texpires=${exp}`)
    }
  }
  await stopHost({ ctx })
}

async function cmdModels(config) {
  const { ctx } = await startHost()
  for (const p of ctx.llm.listProviders()) {
    try {
      const models = await ctx.llm.listModels(p.id)
      console.log(`\n[${p.id}] ${models.length} 个模型`)
      for (const m of models) console.log(`  ${p.id}/${m.id}`)
    } catch (error) {
      console.log(`\n[${p.id}] 目录读取失败：${errorMessage(error)}`)
    }
  }
  await stopHost({ ctx })
}

async function cmdTest(config, model, prompt) {
  if (!model) throw new Error('用法：relaydeck test <provider/model> [prompt]')
  const url = `http://${config.gateway.host}:${config.gateway.port}/v1/chat/completions`
  const { ctx } = await startHost()
  await waitForGateway(config)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.gateway.key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt ?? '请只回复两个字：成功' }],
      stream: false,
    }),
  })
  console.log(`HTTP ${res.status}`)
  console.log((await res.text()).slice(0, 4000))
  await stopHost({ ctx })
}

async function cmdStatus(config) {
  console.log(`数据目录     ${config.home}`)
  console.log(`网关监听     ${config.gateway.host}:${config.gateway.port}（enabled=${config.gateway.enabled}）`)
  console.log(`网关 BaseURL http://${config.gateway.host}:${config.gateway.port}/v1`)
  console.log(`网关 Key     ${config.gateway.key}`)
  console.log(`管理端       http://${config.admin.host}:${config.admin.port}/`)
  console.log(`管理令牌     ${config.admin.token}`)
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0] ?? 'start'
  const config = (await import('./config.mjs')).loadConfig()

  switch (command) {
    case 'start': return cmdStart(config)
    case 'login': return cmdLogin(config, positional[1])
    case 'accounts': return cmdAccounts(config, positional[1])
    case 'models': return cmdModels(config)
    case 'test': return cmdTest(config, positional[1], positional.slice(2).join(' ') || undefined)
    case 'status': return cmdStatus(config)
    case 'key':
      console.log(`BASE_URL=http://${config.gateway.host}:${config.gateway.port}/v1`)
      console.log(`API_KEY=${config.gateway.key}`)
      return
    case 'version':
      console.log('RelayDeck 0.1.0')
      return
    default:
      console.error(`未知命令：${command}`)
      console.error('可用：start | login <provider> | accounts [provider] | models | test <model> [prompt] | status | key')
      process.exit(1)
  }
}

main().catch((error) => {
  console.error(`[relaydeck] ${errorMessage(error)}`)
  process.exit(1)
})
