/**
 * 积分余额的分桶计算：把资源包按到期时间分成 永久 / 长期 / 临期。
 *
 * 抽成纯函数模块，便于单测（不依赖 ctx / 网络）。
 */

/**
 * @param {{ total?: number, packages?: Array<{ active?: boolean, remaining?: number, deductionEndTime?: number }>, expiredTotal?: number }} balance
 * @param {number|undefined} windowDays 上游下发的「临时积分」窗口；缺省 15 天
 * @param {number} [now] 测试注入
 */
export function summarizeBalance(balance, windowDays, now = Date.now()) {
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
