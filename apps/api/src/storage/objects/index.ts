import type { Env } from '../../env'
import { createMemoryObjectStore } from './memory'
import { createS3ObjectStore } from './s3'
import type { ObjectStore } from './ports'

export * from './ports'
export { createMemoryObjectStore, type MemoryObjectStore } from './memory'
export { createS3ObjectStore } from './s3'

export function createObjectStore(env: Env): ObjectStore {
  if (env.OBJECT_STORE_DRIVER === 'memory') {
    if (env.NODE_ENV === 'production') {
      throw new Error('OBJECT_STORE_DRIVER=memory is not usable in production.')
    }
    return createMemoryObjectStore()
  }

  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required.')
  }

  return createS3ObjectStore({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  })
}
