/**
 * 管理端：账号登录、账号池查看、模型目录、网关信息。
 *
 * 默认只监听 127.0.0.1；所有 /api/* 都要求 x-admin-token（或 ?token=）。
 * 浏览器里打开 / 会提示输入 token（存在 localStorage）。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { callRpc } from './host.mjs'
import { createAutoCheckinScheduler } from './autocheckin.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, '..', 'public')

const AUTH_METHODS = ['startLogin', 'login', 'startDeviceLogin', 'deviceLogin']

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length > 1024 * 1024) throw new Error('请求体过大')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function tokenOk(req, url, config) {
  const header = req.headers['x-admin-token']
  const query = url.searchParams.get('token')
  const provided = typeof header === 'string' ? header : query
  return provided === config.admin.token
}

function authServiceOf(ctx, provider) {
  const candidates = [`${provider}Auth`, `${provider}AuthService`]
  for (const name of candidates) {
    const svc = ctx.get(name)
    if (svc !== undefined && svc !== null) return svc
  }
  return undefined
}

function detectLoginMethod(svc) {
  for (const m of AUTH_METHODS) {
    if (typeof svc?.[m] === 'function') return m
  }
  return undefined
}

/** 允许管理端透传的 RPC 方法（全部来自插件自身的 Jet Hub 管理面）。 */
const RPC_ALLOWED = new Set([
  'account.list', 'account.update', 'account.delete', 'account.reorder',
  'account.refresh', 'account.retest', 'account.retestAll', 'account.test',
  'account.reset', 'account.resetAll',
  'credits.status', 'credits.balances', 'credits.claimAll', 'credits.permanentLock',
  'model.list', 'model.setDisabled', 'model.setDisabledMany', 'model.setAllDisabled',
  'provider.status', 'provider.setEnabled', 'provider.getOrder', 'provider.setOrder',
  'backup.export', 'backup.import', 'backup.status',
  'usage.tokenLedger', 'usage.tokenLedgerHistory', 'usage.tokenLedgerDeleteDay',
  'usage.badge', 'usage.badgePreference',
  'gateway.getEnabled', 'gateway.setEnabled', 'gateway.setAllowLan',
  'nativeSearch.getEnabled', 'nativeSearch.setEnabled',
  'sessionBalance.getEnabled', 'sessionBalance.setEnabled',
  'minimax.getXff', 'minimax.setXff',
  'cline.quota', 'cline.requestLog',
  'buddy.compensationStatus', 'buddy.claimCompensation',
  'onboarding.status', 'onboarding.claim',
  'login.poll',
  // 账号级代理（各 provider 自己的端点，走同一 RPC 分发）
  'qoder.setProxy', 'qoder.testProxy',
  'minimaxintl.setProxy', 'minimaxintl.testProxy',
  'gemini.setProxy', 'gemini.testProxy',
  'opencode.setProxy', 'opencode.testProxy',
])

/** 聚合目录的依赖按需加载：它们来自插件 lib/，与宿主同源。 */
let aggregateModules
async function loadAggregateModules(pluginEntry) {
  if (aggregateModules !== undefined) return aggregateModules
  const libDir = dirname(pluginEntry)
  const [catalog, core, expiry] = await Promise.all([
    import(pathToFileURL(join(libDir, 'aggregate-catalog.js')).href),
    import(pathToFileURL(join(libDir, 'aggregate-core.js')).href),
    import(pathToFileURL(join(libDir, 'aggregate-expiry.js')).href),
  ])
  aggregateModules = {
    buildVirtualModels: catalog.buildVirtualModels,
    resolveCandidateGate: core.resolveCandidateGate,
    WIRED_EXPIRY_PROVIDERS: expiry.WIRED_EXPIRY_PROVIDERS,
  }
  return aggregateModules
}

export function createAdminServer({ ctx, config, pool, connection, pluginEntry, logger = console }) {
  const startedAt = Date.now()
  const rpc = (method, payload) => callRpc(connection, method, payload)
  const autoCheckin = createAutoCheckinScheduler({ home: config.home, pool, callRpc: rpc, logger })
  // 插件自带的自动签到是「每日启动跑一次」，与我们的时刻表会重复触发；
  // 这里把它关掉，领取逻辑仍由同一 RPC 执行。
  rpc('usage.autoCheckin', { enabled: false }).catch(() => {})
  autoCheckin.start()
  /** @type {Map<string, {id:string,provider:string,url:string|null,status:string,error?:string,createdAt:number,promise:Promise<any>,close?:Function}>} */
  const flows = new Map()

  const providerIds = () => {
    try {
      return ctx.llm.listProviders().map((p) => p.id)
    } catch {
      return []
    }
  }

  const providerLabel = (id) => {
    try {
      return ctx.llm.listProviders().find((p) => p.id === id)?.name ?? id
    } catch {
      return id
    }
  }

  async function providerStatus(id) {
    const svc = authServiceOf(ctx, id)
    let status = null
    try {
      if (typeof svc?.status === 'function') status = await svc.status()
    } catch (error) {
      status = { error: error instanceof Error ? error.message : String(error) }
    }
    let accounts = []
    try {
      accounts = await pool.listAccounts(id)
    } catch (error) {
      accounts = []
    }
    return {
      id,
      label: providerLabel(id),
      hasAuthService: svc !== undefined,
      loginMethod: detectLoginMethod(svc),
      status,
      accounts: accounts.map((a) => ({
        id: a.id,
        nickname: a.nickname,
        enabled: a.enabled !== false,
        credentialRef: a.credentialRef,
        expiresAt: a.expiresAt,
        refreshable: a.refreshable,
        createdAt: a.createdAt,
      })),
    }
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (!tokenOk(req, url, config)) {
      json(res, 401, { error: 'invalid admin token' })
      return
    }

    // ---- 概览 ----
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const ids = providerIds()
      const providers = []
      for (const id of ids) providers.push(await providerStatus(id))
      let models = []
      try {
        const all = await collectModels(ctx)
        models = all
      } catch (error) {
        models = []
      }
      json(res, 200, {
        gateway: {
          baseUrl: `http://${config.gateway.host}:${config.gateway.port}/v1`,
          publicUrl: process.env.HUB_PUBLIC_URL ?? null,
          key: config.gateway.key,
          enabled: config.gateway.enabled,
          host: config.gateway.host,
          port: config.gateway.port,
        },
        home: config.home,
        providers: providers.filter((p) => p.accounts.length > 0 || p.hasAuthService),
        modelCount: models.length,
        modelProviders: [...new Set(models.map((m) => m.provider))],
        generatedAt: new Date().toISOString(),
      })
      return
    }

    // ---- 登录 ----
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req)
      const provider = String(body.provider ?? '')
      const svc = authServiceOf(ctx, provider)
      if (svc === undefined) return json(res, 404, { error: `provider ${provider} 没有认证服务` })
      const method = detectLoginMethod(svc)
      if (method === undefined) return json(res, 400, { error: `provider ${provider} 不支持自助登录` })

      const id = randomUUID()
      const suffix = String(Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase()
      const accountId = `${provider}-${suffix.toLowerCase()}`
      // ⚠️ 必须给每个账号独立的 credentialRef：缺省会落到 provider 的默认 ref，
      //    第二个账号登录时会覆盖第一个账号的凭据（多账号场景的必现缺陷）。
      const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`
      try {
        if (method === 'startLogin') {
          const started = await svc.startLogin({ accountId, refName, pool })
          const entry = {
            id, provider, url: started.loginUrl ?? null, status: 'pending',
            createdAt: Date.now(), close: started.close,
          }
          entry.promise = Promise.resolve(started.result)
            .then(() => { entry.status = 'done' })
            .catch((error) => { entry.status = 'error'; entry.error = errorMessage(error) })
            .finally(() => { try { started.close?.() } catch {} })
          flows.set(id, entry)
          json(res, 200, { id, url: entry.url, status: entry.status })
          return
        }
        // 阻塞式 login（buddy / workbuddy 等）：插件内部流程是
        // 「取 authUrl → 打开浏览器 → 轮询授权结果」。
        // 服务器没有图形浏览器，因此注入 openBrowser 把 URL 捕获出来交给前端，
        // 而不是让它去执行 xdg-open（那会失败，调用方也永远看不到链接）。
        const entry = { id, provider, url: null, status: 'pending', createdAt: Date.now() }
        const openBrowser = async (loginUrl) => {
          if (typeof loginUrl === 'string' && loginUrl.length > 0) entry.url = loginUrl
        }
        flows.set(id, entry)
        entry.promise = Promise.resolve(svc.login({ accountId, refName, pool, openBrowser }))
          .then(() => { entry.status = 'done' })
          .catch((error) => { entry.status = 'error'; entry.error = errorMessage(error) })
        flows.set(id, entry)
        json(res, 202, { id, url: null, status: entry.status, note: '该渠道为阻塞式登录，请在服务器日志观察进度' })
        return
      } catch (error) {
        json(res, 500, { error: errorMessage(error) })
        return
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/login/')) {
      const id = url.pathname.slice('/api/login/'.length)
      const entry = flows.get(id)
      if (entry === undefined) return json(res, 404, { error: 'flow not found' })
      json(res, 200, { id, provider: entry.provider, url: entry.url, status: entry.status, error: entry.error })
      return
    }

    // ---- 账号 ----
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      const all = await pool.listAllAccounts()
      json(res, 200, { accounts: all })
      return
    }

    // 单账号启停
    if (req.method === 'POST' && url.pathname.startsWith('/api/accounts/') && url.pathname.endsWith('/enabled')) {
      const id = decodeURIComponent(url.pathname.slice('/api/accounts/'.length, -'/enabled'.length))
      const body = await readBody(req)
      await pool.updateAccount(id, { enabled: body.enabled !== false })
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/enabled') {
      const body = await readBody(req)
      const provider = String(body.provider ?? '')
      const enabled = body.enabled !== false
      const changed = await pool.setAccountsEnabled(provider, enabled)
      json(res, 200, { changed })
      return
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/accounts/'.length))
      await pool.removeAccount(id)
      json(res, 200, { ok: true })
      return
    }

    // ---- 模型 ----
    if (req.method === 'GET' && url.pathname === '/api/models') {
      json(res, 200, { object: 'list', data: await collectModels(ctx) })
      return
    }

    // ---- 网关 ----
    if (req.method === 'GET' && url.pathname === '/api/gateway') {
      json(res, 200, {
        baseUrl: `http://${config.gateway.host}:${config.gateway.port}/v1`,
        key: config.gateway.key,
      })
      return
    }

    // ---- 连通性测试 ----
    if (req.method === 'POST' && url.pathname === '/api/test') {
      const body = await readBody(req)
      const model = typeof body.model === 'string' ? body.model : ''
      const prompt = typeof body.prompt === 'string' && body.prompt.length > 0 ? body.prompt : '请只回复两个字：成功'
      if (model === '') return json(res, 400, { error: 'model 必填' })
      const started = Date.now()
      try {
        const upstream = await fetch(`http://${config.gateway.host}:${config.gateway.port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.gateway.key}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
          signal: AbortSignal.timeout(120000),
        })
        const text = await upstream.text()
        json(res, 200, { ok: upstream.ok, status: upstream.status, ms: Date.now() - started, body: safeJson(text) })
      } catch (error) {
        json(res, 502, { ok: false, error: errorMessage(error), ms: Date.now() - started })
      }
      return
    }

    // ---- 账号：单账号刷新凭据 ----
    if (req.method === 'POST' && url.pathname.startsWith('/api/accounts/') && url.pathname.endsWith('/refresh')) {
      const id = decodeURIComponent(url.pathname.slice('/api/accounts/'.length, -'/refresh'.length))
      const entry = (await pool.listAllAccounts()).find((a) => a.id === id)
      if (entry === undefined) return json(res, 404, { error: '账号不存在' })
      const svc = authServiceOf(ctx, entry.provider)
      if (svc === undefined) return json(res, 404, { error: `provider ${entry.provider} 没有认证服务` })
      try {
        if (typeof svc.refreshAccountCredential === 'function') {
          await svc.refreshAccountCredential(entry.credentialRef, pool, id)
        } else if (typeof svc.refresh === 'function') {
          await svc.refresh()
        } else {
          return json(res, 400, { error: '该渠道不支持刷新' })
        }
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 500, { ok: false, error: errorMessage(error) })
      }
      return
    }

    // ---- 健康检查 ----
    if (req.method === 'GET' && url.pathname === '/api/health') {
      let gatewayOk = false
      try {
        const r = await fetch(`http://${config.gateway.host}:${config.gateway.port}/v1/models`, {
          headers: { authorization: `Bearer ${config.gateway.key}` },
          signal: AbortSignal.timeout(3000),
        })
        gatewayOk = r.ok
      } catch { /* ignore */ }
      const mem = process.memoryUsage()
      json(res, 200, {
        ok: gatewayOk,
        gateway: gatewayOk,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        memory: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
        node: process.version,
        pid: process.pid,
      })
      return
    }

    // ---- 聚合路由 ----
    if (req.method === 'GET' && url.pathname === '/api/aggregate') {
      const force = url.searchParams.get('force') === '1'
      json(res, 200, await buildAggregateView(ctx, pool, pluginEntry, force))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/aggregate/gate') {
      const body = await readBody(req)
      const canonicalId = String(body.canonicalId ?? '')
      const provider = String(body.provider ?? '')
      const realId = String(body.realId ?? '')
      if (!canonicalId || !provider || !realId) return json(res, 400, { error: 'canonicalId / provider / realId 必填' })
      const { WIRED_EXPIRY_PROVIDERS } = await loadAggregateModules(pluginEntry)
      const wired = WIRED_EXPIRY_PROVIDERS.includes(provider)
      // 已接入临期折算的渠道默认参与 ⇒ 用拒绝表；未接入的默认不参与 ⇒ 用白名单。
      if (wired) {
        await pool.setAggregateRejected(canonicalId, provider, realId, body.enabled === false)
      } else {
        await pool.setAggregateAllowed(canonicalId, provider, realId, body.enabled === true)
      }
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/aggregate/reject-non-expiring') {
      const { WIRED_EXPIRY_PROVIDERS } = await loadAggregateModules(pluginEntry)
      const result = await pool.clearAggregateAllowedExcept(WIRED_EXPIRY_PROVIDERS)
      json(res, 200, { ok: true, cleared: result.cleared })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/aggregate/order-mode') {
      const body = await readBody(req)
      const mode = body.mode === 'manual' ? 'manual' : 'expiry'
      await pool.setAggregateOrderMode(mode)
      json(res, 200, { ok: true, mode })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/aggregate/order') {
      const body = await readBody(req)
      const canonicalId = String(body.canonicalId ?? '')
      if (!canonicalId) return json(res, 400, { error: 'canonicalId 必填' })
      const order = Array.isArray(body.order) ? body.order.map(String) : []
      const saved = await pool.setAggregateOrder(canonicalId, order)
      json(res, 200, { ok: true, order: saved })
      return
    }

    // ---- 同步模型到 new-api ----
    if (req.method === 'POST' && url.pathname === '/api/newapi/sync') {
      const body = await readBody(req)
      const base = String(body.base ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
      const channelId = Number(body.channelId)
      if (!Number.isInteger(channelId) || channelId <= 0) return json(res, 400, { error: 'channelId 必填' })
      try {
        const models = await collectModels(ctx)
        const done = await syncToNewApi({
          base, channelId,
          jwt: typeof body.jwt === 'string' ? body.jwt : undefined,
          username: typeof body.username === 'string' ? body.username : undefined,
          password: typeof body.password === 'string' ? body.password : undefined,
          models: models.map((m) => m.id),
        })
        json(res, 200, done)
      } catch (error) {
        json(res, 502, { ok: false, error: errorMessage(error) })
      }
      return
    }

    // ---- 通用 RPC 透传（白名单）----
    //
    // 插件已经通过 Jet Hub RPC 暴露了完整的账号/模型/备份/用量能力。
    // 与其为每个功能写一条新路由，这里做一层白名单透传，前端直接调用，
    // 行为与 dsh 里的 Jet Hub 完全一致。
    if (req.method === 'POST' && url.pathname === '/api/rpc') {
      const body = await readBody(req)
      const method = String(body.method ?? '')
      if (!RPC_ALLOWED.has(method)) return json(res, 403, { error: `method 不在白名单：${method}` })
      try {
        const value = await rpc(method, body.payload ?? {})
        json(res, 200, { ok: true, value })
      } catch (error) {
        json(res, 200, { ok: false, error: errorMessage(error) })
      }
      return
    }

    // ---- 积分与签到 ----
    if (req.method === 'GET' && url.pathname === '/api/credits') {
      json(res, 200, await collectCreditsView(pool, rpc))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/credits/claim') {
      const body = await readBody(req)
      const only = typeof body.provider === 'string' && body.provider.length > 0 ? body.provider : null
      const accounts = await pool.listAllAccounts()
      const providers = [...new Set(accounts.map((a) => a.provider))]
        .filter((p) => only === null || p === only)
        .sort()
      const results = []
      for (const provider of providers) {
        try {
          const value = await rpc('credits.claimAll', { provider, runTasks: body.runTasks === true })
          results.push({ provider, ok: true, summary: value?.summary ?? null, results: value?.results ?? [] })
        } catch (error) {
          results.push({ provider, ok: false, error: errorMessage(error) })
        }
      }
      json(res, 200, { ok: results.every((r) => r.ok), results })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/autocheckin') {
      json(res, 200, await autoCheckin.state())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/autocheckin') {
      const body = await readBody(req)
      json(res, 200, await autoCheckin.update(body))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/autocheckin/run') {
      const run = await autoCheckin.runNow()
      json(res, 200, { ok: true, run, state: await autoCheckin.state() })
      return
    }

    json(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      logger.error?.(`[relaydeck] ${errorMessage(error)}`)
      if (!res.headersSent) json(res, 500, { error: errorMessage(error) })
      else res.end()
    })
  })

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.admin.port, config.admin.host, () => resolve())
      })
      logger.info?.(`[relaydeck] 管理端已监听 http://${config.admin.host}:${config.admin.port}/`)
    },
    async close() {
      autoCheckin.stop()
      await new Promise((resolve) => server.close(() => resolve()))
    },
    autoCheckin,
    flows,
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function collectModels(ctx) {
  const out = []
  for (const provider of ctx.llm.listProviders()) {
    try {
      const models = await ctx.llm.listModels(provider.id)
      for (const m of models) {
        out.push({
          id: `${provider.id}/${m.id}`,
          provider: provider.id,
          name: m.name ?? m.id,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          inputModalities: m.inputModalities,
        })
      }
    } catch {
      // 单个渠道失败不影响整体目录
    }
  }
  return out
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return text.slice(0, 2000) }
}

/** 计算聚合目录视图：虚拟模型 → 候选 → 三态门控。 */
async function buildAggregateView(ctx, pool, pluginEntry, force) {
  const { buildVirtualModels, resolveCandidateGate, WIRED_EXPIRY_PROVIDERS } = await loadAggregateModules(pluginEntry)
  void force // 目录在独立版里没有 TTL 缓存，每次都从各适配器现取
  const providers = ctx.llm.listProviders()
    .map((p) => p.id)
    .filter((id) => id !== 'aggregate' && id !== 'jet-hub-auto')
  const catalogs = {}
  for (const id of providers) {
    try {
      catalogs[id] = await ctx.llm.listModels(id)
    } catch {
      catalogs[id] = []
    }
  }
  const virtuals = buildVirtualModels(catalogs)
  const rejections = pool.listAggregateRejections()
  const allowed = pool.listAggregateAllowed()
  const orderTable = pool.listAggregateOrder()
  const orderMode = pool.listAggregateOrderMode()
  return {
    orderMode,
    expiryWiredProviders: [...WIRED_EXPIRY_PROVIDERS],
    providerCount: providers.length,
    models: virtuals.map((v) => ({
      canonicalId: v.key,
      name: v.name,
      order: orderTable?.[v.key] ?? [],
      candidates: v.candidates.map((c) => {
        const rejected = rejections?.[v.key]?.[c.provider]?.[c.realId] === true
        const isAllowed = allowed?.[v.key]?.[c.provider]?.[c.realId] === true
        const expiryWired = WIRED_EXPIRY_PROVIDERS.includes(c.provider)
        return {
          provider: c.provider,
          realId: c.realId,
          realName: c.realName,
          price: Number.isFinite(c.price) ? c.price : null,
          viaPatch: c.via === 'patch',
          rejected,
          allowed: isAllowed,
          expiryWired,
          state: resolveCandidateGate({ rejected, allowed: isAllowed, expiryWired }),
        }
      }),
    })),
  }
}

/** 汇总各渠道的余额与今日签到状态。 */
async function collectCreditsView(pool, rpc) {
  const accounts = await pool.listAllAccounts()
  const providers = [...new Set(accounts.map((a) => a.provider))].sort()
  const out = []
  for (const provider of providers) {
    const mine = accounts.filter((a) => a.provider === provider)
    const enabledIds = mine.filter((a) => a.enabled !== false).map((a) => a.id)
    let balances = null
    let statuses = null
    let error
    try {
      balances = await rpc('credits.balances', {
        provider,
        ...(enabledIds.length > 0 ? { accountIds: enabledIds } : {}),
      })
    } catch (e) {
      error = errorMessage(e)
    }
    try {
      statuses = await rpc('credits.status', { provider })
    } catch { /* 状态查询失败不影响余额展示 */ }
    const balanceMap = new Map((balances?.accounts ?? []).map((b) => [b.accountId, b]))
    const statusMap = new Map((statuses?.accounts ?? []).map((s) => [s.accountId, s.status]))
    out.push({
      provider,
      windowDays: balances?.windowDays ?? null,
      error,
      accounts: mine.map((a) => {
        const b = balanceMap.get(a.id)
        const s = statusMap.get(a.id)
        return {
          id: a.id,
          nickname: a.nickname,
          enabled: a.enabled !== false,
          expiresAt: a.expiresAt,
          balance: b?.balance ? summarizeBalance(b.balance, balances?.windowDays) : null,
          balanceError: b?.error ?? error,
          status: s
            ? {
                active: s.active,
                todayCheckedIn: s.todayCheckedIn,
                streakDays: s.streakDays,
                dailyCredit: s.dailyCredit,
                todayCredit: s.todayCredit,
                actionRequired: s.actionRequired === true,
                activityName: s.activityName,
              }
            : null,
        }
      }),
    })
  }
  return { providers: out, generatedAt: new Date().toISOString() }
}

/** 把资源包按到期时间分成：永久 / 长期 / 临期。 */
function summarizeBalance(balance, windowDays) {
  const now = Date.now()
  const windowMs = (typeof windowDays === 'number' ? windowDays : 15) * 86400000
  let permanent = 0
  let longTerm = 0
  let expiring = 0
  let nextExpiryAt = 0
  let nextExpiryAmount = 0
  for (const pkg of balance.packages ?? []) {
    if (pkg.active === false) continue
    const remaining = Number(pkg.remaining) || 0
    const end = Number(pkg.deductionEndTime) || 0
    if (end === 0) permanent += remaining
    else if (end - now <= windowMs) {
      expiring += remaining
      if (end > now && (nextExpiryAt === 0 || end < nextExpiryAt)) {
        nextExpiryAt = end
        nextExpiryAmount = remaining
      }
    } else longTerm += remaining
  }
  return {
    total: Number(balance.total) || 0,
    permanent,
    longTerm,
    expiring,
    expiredTotal: Number(balance.expiredTotal) || 0,
    packageCount: (balance.packages ?? []).length,
    nextExpiryAt: nextExpiryAt || null,
    nextExpiryAmount: nextExpiryAmount || null,
  }
}

/** 登录 new-api 并把模型目录整体写到指定渠道。 */
async function syncToNewApi({ base, channelId, jwt, username, password, models }) {
  const api = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    if (!res.ok) throw new Error(`new-api HTTP ${res.status}: ${String(text).slice(0, 200)}`)
    return parsed
  }

  let token = jwt
  if (!token) {
    if (!username || !password) throw new Error('需要 jwt 或 username/password')
    const login = await api('/api/user/login', { method: 'POST', body: { username, password } })
    token = login?.data?.access_token
    if (!token) throw new Error('new-api 登录失败')
  }
  const channel = await api(`/api/channel/${channelId}`, { token })
  const ch = channel?.data
  if (!ch) throw new Error(`渠道 ${channelId} 不存在`)

  const res = await api('/api/channel/', {
    method: 'PUT',
    token,
    body: {
      id: channelId,
      models: models.join(','),
      test_model: models.includes(ch.test_model) ? ch.test_model : models[0],
    },
  })
  if (res?.success === false) throw new Error(res.message ?? '更新失败')
  return { ok: true, channel: channelId, count: models.length }
}
