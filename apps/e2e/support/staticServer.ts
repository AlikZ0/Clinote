/**
 * Serves the generated bundle the way a static host would (docs/deployment.md §9).
 *
 * Small enough to read in one sitting, and deliberately not a dependency: what
 * it does — correct content types, an SPA fallback, and the headers the
 * deployment guide tells people to set — is exactly what the tests need to be
 * running against. A general-purpose static server would do more and promise
 * less.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** The headers docs/deployment.md §9 asks a web server to add. */
const HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}

export function startStaticServer(root: string, port: number) {
  const base = resolve(root)

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    // `normalize` after joining is what stops `../` from escaping the root.
    const candidate = normalize(join(base, decodeURIComponent(path)))
    const file =
      candidate.startsWith(base) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : // Anything else is a route, not a missing file.
          join(base, 'index.html')

    for (const [header, value] of Object.entries(HEADERS)) response.setHeader(header, value)
    response.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
    response.setHeader(
      'cache-control',
      file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    )

    response.writeHead(200)
    createReadStream(file).pipe(response)
  })

  server.listen(port, '127.0.0.1')
  return server
}

if (process.argv[1]?.endsWith('staticServer.ts')) {
  const root = process.argv[2] ?? '.'
  const port = Number(process.argv[3] ?? 3142)
  startStaticServer(root, port)
  process.stdout.write(`static server on ${port} serving ${resolve(root)}\n`)
}
