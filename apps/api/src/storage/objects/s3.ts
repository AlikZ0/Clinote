/**
 * S3-compatible adapter (MinIO in development, any S3 API in production).
 *
 * Buckets are private; every access is a presigned URL scoped to one object,
 * one method and a few minutes (docs/security.md §5).
 */
import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ObjectMetadata, ObjectStore, SignedUpload } from './ports'

export interface S3ObjectStoreOptions {
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** MinIO and most self-hosted gateways need path-style addressing. */
  forcePathStyle?: boolean
  uploadTtlSeconds?: number
  downloadTtlSeconds?: number
}

export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore & {
  client: S3Client
} {
  const client = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  })

  const uploadTtl = options.uploadTtlSeconds ?? 900
  const downloadTtl = options.downloadTtlSeconds ?? 300

  return {
    client,

    async createUploadUrl(key, { sizeBytes }): Promise<SignedUpload> {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          ContentLength: sizeBytes,
          ContentType: 'application/octet-stream',
        }),
        { expiresIn: uploadTtl },
      )

      return {
        url,
        // Signed into the URL: a different length or type invalidates it.
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(sizeBytes),
        },
        expiresAt: new Date(Date.now() + uploadTtl * 1000).toISOString(),
      }
    },

    async createDownloadUrl(key) {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        { expiresIn: downloadTtl },
      )
      return { url, expiresAt: new Date(Date.now() + downloadTtl * 1000).toISOString() }
    },

    async head(key): Promise<ObjectMetadata | null> {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: key }),
        )
        return { sizeBytes: Number(result.ContentLength ?? 0), checksum: null }
      } catch {
        return null
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }))
    },

    async checksum(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))
        const body = result.Body as AsyncIterable<Uint8Array> | undefined
        if (!body) return null

        // Streamed, never buffered: an archive can be larger than this process
        // should ever hold in memory.
        const digest = createHash('sha256')
        for await (const chunk of body) digest.update(chunk)
        return digest.digest('hex')
      } catch {
        return null
      }
    },
  }
}
