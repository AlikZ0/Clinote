/**
 * Exercises the real presigned-URL flow against a running S3-compatible
 * service. Skipped when none is configured; CI and `pnpm db:up` provide one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { createS3ObjectStore } from './s3'
import type { ObjectStore } from './ports'

const endpoint = process.env.TEST_S3_ENDPOINT
const runs = Boolean(endpoint)

let store: ObjectStore
const keys: string[] = []

const BODY = Buffer.from('encrypted-archive-bytes')
const DIGEST = createHash('sha256').update(BODY).digest('hex')

beforeAll(() => {
  if (!runs) return
  store = createS3ObjectStore({
    endpoint,
    region: 'us-east-1',
    bucket: process.env.TEST_S3_BUCKET ?? 'clinote-backups',
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'clinote',
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'clinote-secret',
    forcePathStyle: true,
  })
})

afterAll(async () => {
  if (!runs) return
  for (const key of keys) await store.delete(key).catch(() => undefined)
})

function newKey(): string {
  const key = `backups/test/${randomUUID()}.clinote`
  keys.push(key)
  return key
}

describe.skipIf(!runs)('S3-compatible object store', () => {
  it('uploads through a presigned URL and reports what landed', async () => {
    const key = newKey()
    const upload = await store.createUploadUrl(key, { sizeBytes: BODY.length })

    const response = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(BODY),
    })
    expect(response.status).toBe(200)

    expect(await store.head(key)).toMatchObject({ sizeBytes: BODY.length })
    expect(await store.checksum(key)).toBe(DIGEST)
  })

  it('signs a download link that returns the same bytes', async () => {
    const key = newKey()
    const upload = await store.createUploadUrl(key, { sizeBytes: BODY.length })
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(BODY) })

    const download = await store.createDownloadUrl(key)
    const fetched = Buffer.from(await (await fetch(download.url)).arrayBuffer())

    expect(fetched.equals(BODY)).toBe(true)
    expect(Date.parse(download.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses an unsigned request: the bucket is private', async () => {
    const key = newKey()
    const upload = await store.createUploadUrl(key, { sizeBytes: BODY.length })
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(BODY) })

    const unsigned = await fetch(new URL(upload.url).origin + new URL(upload.url).pathname)
    expect(unsigned.status).toBeGreaterThanOrEqual(400)
  })

  it('refuses a request whose signature was tampered with', async () => {
    const key = newKey()
    const upload = await store.createUploadUrl(key, { sizeBytes: BODY.length })

    const url = new URL(upload.url)
    const signature = url.searchParams.get('X-Amz-Signature') ?? ''
    url.searchParams.set(
      'X-Amz-Signature',
      signature.replace(/.$/, (last) => (last === 'a' ? 'b' : 'a')),
    )

    const response = await fetch(url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(BODY),
    })

    expect(response.status).toBe(403)
  })

  it('refuses a signed URL pointed at a different object', async () => {
    const key = newKey()
    const upload = await store.createUploadUrl(key, { sizeBytes: BODY.length })

    // The object path is part of what was signed.
    const url = upload.url.replace(key, `backups/test/${randomUUID()}.clinote`)
    const response = await fetch(url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(BODY),
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('reports a missing object rather than throwing', async () => {
    expect(await store.head('backups/test/does-not-exist.clinote')).toBeNull()
    expect(await store.checksum('backups/test/does-not-exist.clinote')).toBeNull()
  })

  it('deletes an object', async () => {
    const key = newKey()
    const upload = await store.createUploadUrl(key, { sizeBytes: BODY.length })
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(BODY) })

    await store.delete(key)
    expect(await store.head(key)).toBeNull()
  })
})
