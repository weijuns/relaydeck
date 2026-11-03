/**
 * 定时签到：按 UTC+8 的固定时刻（默认 09:00 / 21:00）调用插件的
 * `credits.claimAll`，带随机抖动，结果落盘。
 *
 * 为什么不直接用插件自带的 auto-checkin：那是「每日首次启动跑一次」，
 * 没有时刻表与抖动配置。这里保留插件的能力实现（真正的领取逻辑），
 * 只替换调度层。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './config.mjs'

const FILE = 'auto-checkin-config.json'
const UTC8 = 8 * 3600 * 1000

export const DEFAULT_CONFIG = {
  enabled: true,
  times: ['09:00', '21:00'],
  jitterMinutes: 10,
}

function sanitize(raw) {
  const out = { ...DEFAULT_CONFIG }
  if (raw && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    if (Array.isArray(raw.times)) {
      const times = raw.times
        .filter((t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t))
        .slice(0, 4)
      if (times.length > 0) out.times = [...new Set(times)].sort()
    }
    if (Number.isFinite(raw.jitterMinutes)) {
      out.jitterMinutes = Math.min(120, Math.max(0, Math.round(raw.jitterMinutes)))
    }
    if (raw.lastRun && typeof raw.lastRun === 'object') out.lastRun = raw.lastRun
    if (typeof raw.lastSlot === 'string') out.lastSlot = raw.lastSlot
  }
  return out
}

/** 计算下一次执行时刻（UTC+8 固定时刻 + 抖动）。 */
export function computeNextSlot(times, jitterMinutes, nowMs = Date.now()) {
  const d = new Date(nowMs + UTC8)
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  const day = d.getUTCDate()
  const sorted = [...times].sort()
  let best = null
  for (const t of sorted) {
    const [hh, mm] = t.split(':').map(Number)
    const base = Date.UTC(y, mo, day, hh, mm) - UTC8
    if (base > nowMs && (best === null || base < best.base)) {
      best = {
        base,
        slot: `${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')} ${t}`,
      }
    }
  }
  if (best === null) {
    const [hh, mm] = sorted[0].split(':').map(Number)
    const base = Date.UTC(y, mo, day + 1, hh, mm) - UTC8
    const nd = new Date(base + UTC8)
    const slot = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')} ${sorted[0]}`
    best = { base, slot }
  }
  const jitter = jitterMinutes > 0 ? Math.floor(Math.random() * (jitterMinutes * 60000 + 1)) : 0
  return { at: best.base + jitter, slot: best.slot }
}

/**
 * @param {{home: string, pool: any, callRpc: (m: string, p?: any) => Promise<any>, logger?: Console}} deps
 */
export function createAutoCheckinScheduler({ home, pool, callRpc, logger = console }) {
  const file = join(home, FILE)
  let config = DEFAULT_CONFIG
  if (existsSync(file)) {
    try {
      config = sanitize(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      logger.warn?.(
        `[autocheckin] 配置解析失败，使用默认值：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  let timer = null
  let next = null
  let running = false

  const save = () => atomicWrite(file, JSON.stringify(config, null, 2))

  async function providersWithAccounts() {
    const accounts = await pool.listAllAccounts()
    return [...new Set(accounts.map((a) => a.provider))].sort()
  }

  async function runOnce(trigger) {
    if (running) return { skipped: 'running' }
    running = true
    const startedAt = Date.now()
    const channels = []
    const totals = {
      claimed: 0,
      totalCredit: 0,
      alreadyClaimed: 0,
      inactive: 0,
      failed: 0,
      coversToday: 0,
    }
    let providers = []
    try {
      providers = await providersWithAccounts()
    } catch (error) {
      running = false
      throw error
    }
    for (const provider of providers) {
      try {
        const res = await callRpc('credits.claimAll', { provider })
        const s = res?.summary ?? {}
        for (const k of Object.keys(totals)) totals[k] += Number(s[k] ?? 0)
        channels.push({ provider, text: describeSummary(s) })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        channels.push({ provider, text: `跳过：${msg.slice(0, 80)}` })
      }
    }
    const lastRun = {
      at: startedAt,
      trigger,
      slot: trigger === 'manual' ? 'manual' : (next?.slot ?? ''),
      providers: providers.length,
      totals,
      channels,
    }
    config.lastRun = lastRun
    if (trigger !== 'manual') config.lastSlot = lastRun.slot
    save()
    running = false
    logger.info?.(
      `[autocheckin] ${trigger} 完成：${providers.length} 个渠道，领取 ${totals.claimed}，失败 ${totals.failed}`,
    )
    return lastRun
  }

  function describeSummary(s) {
    const parts = []
    if (s.claimed) parts.push(`领取 ${s.claimed}`)
    if (s.alreadyClaimed) parts.push(`已领 ${s.alreadyClaimed}`)
    if (s.failed) parts.push(`失败 ${s.failed}`)
    if (s.inactive) parts.push(`不可用 ${s.inactive}`)
    if (parts.length === 0) parts.push('无可用账号')
    return parts.join(' · ')
  }

  function scheduleNext() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    next = null
    if (!config.enabled) return
    const slot = computeNextSlot(config.times, config.jitterMinutes)
    // 同一时刻已经跑过（进程重启后）就跳过，排下一轮。
    if (config.lastSlot === slot.slot) {
      const later = computeNextSlot(config.times, config.jitterMinutes, slot.at + 60_000)
      next = later
    } else {
      next = slot
    }
    const delay = Math.max(1000, next.at - Date.now())
    timer = setTimeout(() => {
      timer = null
      runOnce('auto')
        .catch((error) =>
          logger.warn?.(
            `[autocheckin] 自动执行失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => scheduleNext())
    }, delay)
    timer.unref?.()
  }

  return {
    start() {
      scheduleNext()
    },
    stop() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    async state() {
      return {
        enabled: config.enabled,
        times: config.times,
        jitterMinutes: config.jitterMinutes,
        running,
        nextRunAt: next?.at ?? null,
        nextSlot: next?.slot ?? null,
        lastRun: config.lastRun ?? null,
        providers: await providersWithAccounts().catch(() => []),
      }
    },
    async update(patch) {
      if (patch.enabled !== undefined) config.enabled = patch.enabled === true
      if (Array.isArray(patch.times)) {
        const times = patch.times
          .filter((t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t))
          .slice(0, 4)
        if (times.length > 0) config.times = [...new Set(times)].sort()
      }
      if (patch.jitterMinutes !== undefined) {
        const n = Number(patch.jitterMinutes)
        if (Number.isFinite(n)) config.jitterMinutes = Math.min(120, Math.max(0, Math.round(n)))
      }
      save()
      scheduleNext()
      return await this.state()
    },
    async runNow() {
      const result = await runOnce('manual')
      scheduleNext()
      return result
    },
  }
}
