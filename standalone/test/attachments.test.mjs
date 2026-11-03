import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { MemoryAttachments } from '../src/attachments.mjs'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0GQAAAAASUVORK5CYII=',
  'base64',
)

function service() {
  return new MemoryAttachments(new Context())
}

test('保存并读回 PNG，按内容寻址', async () => {
  const svc = service()
  const ref = await svc.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
  assert.equal(ref.mediaType, 'image/png')
  assert.equal(ref.width, 1)
  assert.equal(ref.height, 1)
  assert.equal(ref.bytes, PNG_1X1.length)
  assert.match(ref.attachmentId, /^sha256:[0-9a-f]{64}$/)

  const back = await svc.readImage(ref)
  assert.deepEqual(Buffer.from(back.data), PNG_1X1)
  assert.equal(back.ref.mediaType, 'image/png')
})

test('同一张图重复保存得到同一个 id', async () => {
  const svc = service()
  const a = await svc.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
  const b = await svc.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
  assert.equal(a.attachmentId, b.attachmentId)
})

test('声明的 mime 与字节不符时以字节为准', async () => {
  const svc = service()
  const ref = await svc.saveImage({ data: PNG_1X1, mediaType: 'image/jpeg' })
  assert.equal(ref.mediaType, 'image/png')
})

test('不支持的格式直接报错', async () => {
  const svc = service()
  await assert.rejects(
    () => svc.saveImage({ data: Buffer.from('hello'), mediaType: 'image/png' }),
    /不支持的图片格式/,
  )
})

test('读取不存在的 ref 报错', async () => {
  const svc = service()
  await assert.rejects(() => svc.readImage({ attachmentId: 'sha256:deadbeef' }), /不存在或已过期/)
})

test('总内存预算：超过 totalBytes 时淘汰最旧的', async () => {
  const svc = new MemoryAttachments(new Context(), { totalBytes: 150, maxEntries: 10 })
  const a = await svc.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
  const rgb = Buffer.from(PNG_1X1)
  // 改一个字节造出不同的图（内容寻址不同、尺寸仍可嗅探）
  rgb[rgb.length - 1] ^= 0xff
  const b = await svc.saveImage({ data: rgb, mediaType: 'image/png' })
  const c = await svc.saveImage({
    data: Buffer.concat([rgb, Buffer.from([0])]),
    mediaType: 'image/png',
  })
  assert.ok(svc.totalBytes <= 150)
  assert.ok(!svc.store.has(a.attachmentId))
  assert.ok(svc.store.has(b.attachmentId) || svc.store.has(c.attachmentId))
})

test('单张超过 maxImageBytes 直接拒绝', async () => {
  const svc = new MemoryAttachments(new Context(), { maxImageBytes: 10 })
  await assert.rejects(() => svc.saveImage({ data: PNG_1X1, mediaType: 'image/png' }), /图片超过/)
})
