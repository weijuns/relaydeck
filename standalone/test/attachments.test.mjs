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
