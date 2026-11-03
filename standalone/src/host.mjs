/**
 * 独立宿主：不启动 DeepSeek Harness 应用，只提供插件所需的最小服务面，
 * 然后加载 dsh-providers-hub 的 apply()。
 *
 * 依赖面（全部来自 npm 上的 MIT/BSD 开源包，或插件自身的 lib/）：
 *   - @deepseek-ai/cordis        （MIT）        上下文 / 服务 / 生命周期
 *   - @deepseek-ai/dsh-llm       （MIT）        LlmRuntime：适配器注册表
 *   - dsh-providers-hub/lib      （MIT）        18 个 provider 适配器 + 账号池 + OpenAI 网关
 *
 * 不依赖：dsh CLI、桌面端、Web 宿主、profile 系统、DSH 的任何 UI 或 RPC 服务。
 */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { loadConfig, applyPluginEnv } from './config.mjs'
import { FileCredentialProvider } from './credentials.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STANDALONE_ROOT = resolve(HERE, '..')

/** dsh 的 commands 服务在独立版里没有实现，但插件的 inject 声明需要它存在。 */
class NoopCommands extends Service {
  constructor(ctx) {
    super(ctx, 'commands')
  }
}

/**
 * connection 服务的最小实现。
 *
 * 插件用 `ctx.connection.fetch.register({ path, fetch })` 注册整套管理 RPC
 * （账号、积分、签到、备份……）。我们把它捕获下来，管理端就能直接调用
 * 与 dsh 宿主**完全相同**的处理逻辑，而不是重写一份。
 */
class ConnectionService extends Service {
  constructor(ctx) {
    super(ctx, 'connection')
    this.registrations = []
    this.fetch = {
      register: (options) => {
        this.registrations.push(options)
        return () => {
          const i = this.registrations.indexOf(options)
          if (i >= 0) this.registrations.splice(i, 1)
        }
      },
    }
  }
}

/** 调用插件注册的 Jet Hub RPC。 */
export async function callRpc(connection, method, payload = {}) {
  const reg = connection?.registrations?.find((r) => typeof r.fetch === 'function')
  if (reg === undefined) throw new Error('Jet Hub RPC 未注册（connection 服务未生效）')
  const body = {
    type: 'client-request',
    rpcId: randomUUID(),
    method: 'jet-hub',
    payload: { method, payload },
  }
  const response = await reg.fetch(
    new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  const json = await response.json()
  const result = json?.result
  if (result?.ok === false) throw new Error(result.error?.message ?? `${method} 失败`)
  return result?.value
}

export function resolvePluginEntry() {
  const candidates = [
    process.env.HUB_PLUGIN_ENTRY,
    resolve(STANDALONE_ROOT, '..', 'app', 'lib', 'index.js'),
    resolve(STANDALONE_ROOT, '..', 'vendor', 'dsh-providers-hub', 'lib', 'index.js'),
  ].filter((v) => typeof v === 'string' && v.length > 0)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    '找不到 dsh-providers-hub 的构建产物。请先构建插件（npm run build），' +
      '或用 HUB_PLUGIN_ENTRY 指定 lib/index.js 的绝对路径。' +
      `\n已尝试：\n  ${candidates.join('\n  ')}`,
  )
}

/**
 * @returns {Promise<{ctx: Context, config: object, pool: any, llm: any, credentials: FileCredentialProvider}>}
 */
export async function startHost({ logger = console } = {}) {
  const config = loadConfig()
  applyPluginEnv(config)

  const ctx = new Context()
  const credentials = new FileCredentialProvider(ctx, config.home)
  new NoopCommands(ctx)
  const connection = new ConnectionService(ctx)
  const llm = new LlmRuntime(ctx)

  const entry = resolvePluginEntry()
  if (config.debug) logger.info(`[relaydeck] 加载插件：${entry}`)
  const plugin = await import(pathToFileURL(entry).href)
  if (typeof plugin.apply !== 'function') throw new Error(`${entry} 未导出 apply()`)

  plugin.apply(ctx)

  // apply() 是同步装配，但网关收敛是异步的；由调用方用 waitForGateway() 确认。
  const pool = ctx.get('accountPool')
  // ctx.inject(['connection']) 的回调可能是异步排定的，等一拍再交出去。
  await new Promise((r) => setTimeout(r, 0))
  return { ctx, config, pool, llm, credentials, connection, pluginEntry: entry }
}

/** 供 CLI / 管理端使用：等待网关真正监听（最多 timeoutMs）。 */
export async function waitForGateway(config, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  const url = `http://${config.gateway.host}:${config.gateway.port}/v1/models`
  let lastError
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${config.gateway.key}` },
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return true
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `网关在 ${timeoutMs}ms 内未就绪：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/** 关停：释放网关与定时器。 */
export async function stopHost({ ctx }, logger = console) {
  try {
    await ctx?.dispose?.()
  } catch (error) {
    logger.warn?.(`[host] dispose 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export { STANDALONE_ROOT }
