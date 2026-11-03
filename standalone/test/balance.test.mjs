import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeBalance } from '../src/balance.mjs'

const DAY = 86400000
const NOW = Date.UTC(2026, 10, 3, 0, 0, 0)

test('按到期时间分成永久 / 长期 / 临期', () => {
  const out = summarizeBalance(
    {
      total: 1000,
      packages: [
        { active: true, remaining: 100 }, // 无到期 = 永久
        { active: true, remaining: 200, deductionEndTime: NOW + 5 * DAY }, // 窗口内 = 临期
        { active: true, remaining: 700, deductionEndTime: NOW + 60 * DAY }, // 窗口外 = 长期
      ],
    },
    15,
    NOW,
  )
  assert.equal(out.permanent, 100)
  assert.equal(out.expiring, 200)
  assert.equal(out.longTerm, 700)
  assert.equal(out.nextExpiryAmount, 200)
})

test('失效包不计入，但单独统计 expiredTotal', () => {
  const out = summarizeBalance(
    {
      total: 50,
      expiredTotal: 30,
      packages: [
        { active: true, remaining: 50 },
        { active: false, remaining: 30 },
      ],
    },
    15,
    NOW,
  )
  assert.equal(out.total, 50)
  assert.equal(out.permanent, 50)
  assert.equal(out.expiredTotal, 30)
  assert.equal(out.packageCount, 2)
})

test('已过期的包不进入临期桶，nextExpiryAt 只取未来', () => {
  const out = summarizeBalance(
    { total: 0, packages: [{ active: true, remaining: 10, deductionEndTime: NOW - DAY }] },
    15,
    NOW,
  )
  assert.equal(out.expiring, 10)
  assert.equal(out.nextExpiryAt, null)
})

test('windowDays 缺省按 15 天', () => {
  const out = summarizeBalance(
    { packages: [{ active: true, remaining: 5, deductionEndTime: NOW + 16 * DAY }] },
    undefined,
    NOW,
  )
  assert.equal(out.longTerm, 5)
})
