import test from 'node:test'
import assert from 'node:assert/strict'
import { computeNextSlot } from '../src/autocheckin.mjs'

// 2026-11-03 08:00 UTC+8 = 2026-11-03 00:00 UTC
const NOW = Date.UTC(2026, 10, 3, 0, 0, 0)

test('选择当天最近的下一个时刻（UTC+8）', () => {
  const slot = computeNextSlot(['09:00', '21:00'], 0, NOW)
  assert.equal(slot.slot, '2026-11-03 09:00')
  // 09:00 UTC+8 = 01:00 UTC
  assert.equal(slot.at, Date.UTC(2026, 10, 3, 1, 0, 0))
})

test('当天时刻已过则排到明天', () => {
  const late = Date.UTC(2026, 10, 3, 14, 0, 0) // 22:00 UTC+8
  const slot = computeNextSlot(['09:00', '21:00'], 0, late)
  assert.equal(slot.slot, '2026-11-04 09:00')
})

test('抖动控制在 0..jitter 分钟内', () => {
  const slot = computeNextSlot(['09:00'], 10, NOW)
  const base = Date.UTC(2026, 10, 3, 1, 0, 0)
  assert.ok(slot.at >= base)
  assert.ok(slot.at <= base + 10 * 60000)
})

test('时刻表排序不影响结果', () => {
  const a = computeNextSlot(['21:00', '09:00'], 0, NOW)
  const b = computeNextSlot(['09:00', '21:00'], 0, NOW)
  assert.equal(a.at, b.at)
})
