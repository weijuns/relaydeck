/**
 * 独立版配置：环境变量 + HUB_HOME/config.json。
 *
 * 优先级：环境变量 > config.json > 默认值。
 * 生成型密钥（adminToken / gatewayKey）首次启动时创建并持久化，0600。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

const DEFAULTS = {
  gatewayHost: '127.0.0.1',
  gatewayPort: 8326,
  adminHost: '127.0.0.1',
  adminPort: 8327,
}

function env(name) {
  const v = process.env[name]
  return v === undefined || v.trim() === '' ? undefined : v.trim()
}

function bool(name, fallback) {
  const v = env(name)?.toLowerCase()
  if (v === undefined) return fallback
  return !['0', 'false', 'off', 'no'].includes(v)
}

function int(name, fallback) {
  const raw = env(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} 必须是 1..65535 的整数，收到 ${JSON.stringify(raw)}`)
  }
  return n
}

function atomicWrite(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

export function loadConfig() {
  const home = resolve(env('HUB_HOME') ?? join(process.cwd(), 'data'))
  mkdirSync(home, { recursive: true })
  mkdirSync(join(home, 'jet-hub'), { recursive: true })
  mkdirSync(join(home, 'openai-gateway'), { recursive: true })

  const configFile = join(home, 'config.json')
  let stored = {}
  if (existsSync(configFile)) {
    try {
      stored = JSON.parse(readFileSync(configFile, 'utf8'))
    } catch (error) {
      throw new Error(`无法解析 ${configFile}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let dirty = false
  if (typeof stored.adminToken !== 'string' || stored.adminToken.length < 24) {
    stored.adminToken = randomBytes(32).toString('base64url')
    dirty = true
  }
  if (typeof stored.gatewayKey !== 'string' || stored.gatewayKey.length < 24) {
    stored.gatewayKey = randomBytes(32).toString('base64url')
    dirty = true
  }
  if (dirty) atomicWrite(configFile, JSON.stringify(stored, null, 2))

  const config = {
    home,
    configFile,
    gateway: {
      host: env('HUB_GATEWAY_HOST') ?? stored.gatewayHost ?? DEFAULTS.gatewayHost,
      port: int('HUB_GATEWAY_PORT', stored.gatewayPort ?? DEFAULTS.gatewayPort),
      key: env('HUB_GATEWAY_KEY') ?? stored.gatewayKey,
      enabled: bool('HUB_GATEWAY_ENABLED', true),
      allowLan: bool('HUB_GATEWAY_ALLOW_LAN', false),
    },
    admin: {
      host: env('HUB_ADMIN_HOST') ?? stored.adminHost ?? DEFAULTS.adminHost,
      port: int('HUB_ADMIN_PORT', stored.adminPort ?? DEFAULTS.adminPort),
      token: env('HUB_ADMIN_TOKEN') ?? stored.adminToken,
    },
    // 仅供诊断：打印完整请求/响应头（默认关闭）
    debug: bool('HUB_DEBUG', false),
  }
  // 记住用户显式改过的监听参数，下次启动仍生效
  if (env('HUB_GATEWAY_HOST') || env('HUB_GATEWAY_PORT')) {
    stored.gatewayHost = config.gateway.host
    stored.gatewayPort = config.gateway.port
    atomicWrite(configFile, JSON.stringify(stored, null, 2))
  }
  return config
}

/** 把独立版配置翻译成插件认识的环境变量（必须在 apply() 之前调用）。 */
export function applyPluginEnv(config) {
  process.env.DSH_HOME = config.home
  process.env.DSH_JET_HUB_STATE_DIR = config.home
  process.env.DSH_OPENAI_GATEWAY_ENABLED = config.gateway.enabled ? '1' : '0'
  process.env.DSH_OPENAI_GATEWAY_HOST = config.gateway.host
  process.env.DSH_OPENAI_GATEWAY_PORT = String(config.gateway.port)
  process.env.DSH_OPENAI_GATEWAY_API_KEY = config.gateway.key
  // 说明：网关只接受具体地址，拒绝 0.0.0.0/::（上游插件的 fail-closed 设计）。
  // 需要跨机访问时，请填本机网卡 IP，或让 new-api 与网关同机走 127.0.0.1。
}

export { atomicWrite }
