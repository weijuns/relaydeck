/**
 * 文件型凭据库：实现 @deepseek-ai/dsh-credentials 的 CredentialProvider。
 *
 * 存储形态：HUB_HOME/credentials.json
 *   { "<REF_NAME>": "<provider 自己写的 JSON 字符串>" }
 *
 * 权限 0600；写入使用 tmp+rename 原子替换。
 */
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './config.mjs'

export class FileCredentialProvider extends CredentialProvider {
  constructor(ctx, home) {
    super(ctx)
    this.file = join(home, 'credentials.json')
    this.data = {}
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
          this.data = parsed
      } catch (error) {
        throw new Error(
          `无法解析凭据文件 ${this.file}：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  save() {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2))
  }

  async resolve(ref) {
    const value = this.data[String(ref)]
    return value === undefined ? undefined : { value, source: 'file' }
  }

  async describe(ref) {
    const configured = this.data[String(ref)] !== undefined
    return { configured, writable: true, source: configured ? 'file' : undefined }
  }

  async set(ref, value) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('凭据值不能为空')
    this.data[String(ref)] = value
    this.save()
    this.notifyUpdated?.(ref)
  }

  async unset(ref) {
    if (this.data[String(ref)] === undefined) return
    delete this.data[String(ref)]
    this.save()
    this.notifyUpdated?.(ref)
  }

  // dsh-credentials 的「记录」接口：插件不使用，保留可用形状。
  async readRecord() {
    return undefined
  }
  async describeRecord() {
    return { configured: false, writable: true }
  }
  async listRecords() {
    return []
  }
  async modifyRecord(_key, mutate) {
    return mutate(undefined)
  }
  async deleteRecord() {}

  /** 诊断用：列出所有 ref 名称（不返回值）。 */
  listRefs() {
    return Object.keys(this.data)
  }
}
