/**
 * 附件服务（attachments）：让独立版也能接收图片。
 *
 * 网关把 OpenAI 的 `image_url`（base64 data URL）通过 `saveImage()` 落成一个
 * 内容寻址的引用；各 provider 适配器随后用 `readImage(ref)` 取回原始字节，
 * 内联进上游请求。
 *
 * 存储是**进程内内存 + TTL**：图片只在「网关解析请求 → 适配器发上游」这一小段
 * 时间内需要，不需要持久化；重启丢失无害（客户端会重发）。
 */
import { Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'

/**
 * 内存预算。图片只在一次请求内需要，默认值刻意保守：
 * - 单张 20 MB（与网关上报的 imageLimits 对齐）
 * - 总量 128 MB（所有在途图片之和的硬上限）
 * - 最多 128 张、10 分钟过期
 *
 * ⚠️ 为什么必须有**总量**上限：只限制张数时 128 × 20MB 仍是 2.5GB，
 * 足够打爆这台 2GB 的机器。这里的 totalBytes 才是真正的护栏。
 */
const DEFAULT_OPTIONS = {
  ttlMs: 10 * 60 * 1000,
  maxEntries: 128,
  totalBytes: 128 * 1024 * 1024,
  maxImageBytes: 20 * 1024 * 1024,
}

function sniff(bytes) {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    return { mediaType: 'image/png', width, height }
  }
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
    const width = bytes.readUInt16LE(6)
    const height = bytes.readUInt16LE(8)
    return { mediaType: 'image/gif', width, height }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      const length = bytes.readUInt16BE(offset + 2)
      // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isSof && offset + 9 < bytes.length) {
        const height = bytes.readUInt16BE(offset + 5)
        const width = bytes.readUInt16BE(offset + 7)
        return { mediaType: 'image/jpeg', width, height }
      }
      if (length < 2) break
      offset += 2 + length
    }
    return { mediaType: 'image/jpeg', width: 0, height: 0 }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mediaType: 'image/webp', width: 0, height: 0 }
  }
  return undefined
}

export class MemoryAttachments extends Service {
  constructor(ctx, options = {}) {
    super(ctx, 'attachments')
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.totalBytes = 0
    /** @type {Map<string, {data: Buffer, mediaType: string, width: number, height: number, bytes: number, at: number}>} */
    this.store = new Map()
  }

  /** 清理过期与超量条目（简单 LRU：按插入顺序淘汰最旧的）。 */
  evict(id) {
    const item = this.store.get(id)
    if (item === undefined) return
    this.store.delete(id)
    this.totalBytes -= item.bytes
  }

  prune() {
    const now = Date.now()
    for (const [id, item] of this.store) {
      if (now - item.at > this.options.ttlMs) this.evict(id)
    }
    while (this.store.size > this.options.maxEntries || this.totalBytes > this.options.totalBytes) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.evict(oldest)
    }
  }

  async saveImage({ data, mediaType }) {
    const bytes = Buffer.from(data)
    if (bytes.length === 0) throw new Error('空图片')
    if (bytes.length > this.options.maxImageBytes) {
      throw new Error(`图片超过 ${Math.round(this.options.maxImageBytes / 1024 / 1024)}MB`)
    }
    const detected = sniff(bytes)
    if (detected === undefined) throw new Error('不支持的图片格式（仅 PNG / JPEG / GIF / WebP）')
    // 声明类型与字节不符时以字节为准，避免把错误 mime 传给上游。
    const finalType = detected.mediaType
    void mediaType
    const hex = createHash('sha256').update(bytes).digest('hex')
    const attachmentId = `sha256:${hex}`
    const previous = this.store.get(attachmentId)
    if (previous !== undefined) this.totalBytes -= previous.bytes
    this.store.set(attachmentId, {
      data: bytes,
      mediaType: finalType,
      width: detected.width,
      height: detected.height,
      bytes: bytes.length,
      at: Date.now(),
    })
    this.totalBytes += bytes.length
    this.prune()
    return {
      attachmentId,
      mediaType: finalType,
      width: detected.width,
      height: detected.height,
      bytes: bytes.length,
    }
  }

  async readImage(ref) {
    const id = typeof ref === 'string' ? ref : ref?.attachmentId
    const item = this.store.get(id)
    if (item === undefined) throw new Error(`图片不存在或已过期：${String(id)}`)
    return {
      data: item.data,
      ref: {
        attachmentId: id,
        mediaType: item.mediaType,
        width: item.width,
        height: item.height,
        bytes: item.bytes,
      },
    }
  }

  /** 不做缩放：返回原图，调用方拿到 undefined 时会自行回退原图。 */
  async readImageRequest(ref) {
    const stored = await this.readImage(ref)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }

  /** 供网关做前置校验（取不到时网关有保守兜底）。 */
  get imageLimits() {
    return {
      maxImageBytes: this.options.maxImageBytes,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 40 * 1024 * 1024,
      maxImageDimension: 8000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    }
  }
}
