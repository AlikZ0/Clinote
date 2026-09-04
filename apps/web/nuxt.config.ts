import { applyScriptHashesToDirectory } from './build/csp'

/**
 * Where the app is allowed to talk to (docs/security.md §13).
 *
 * Same origin by default. Two other places have to be named when they are
 * elsewhere, or the browser blocks the very requests the app exists to make:
 *
 *   - the API, taken from the configured base URL so the two cannot drift;
 *   - **object storage**, which the device uploads backups to *directly* and
 *     downloads restores from. Its URL is minted by the API at runtime, so the
 *     build cannot infer it — the deployment has to say (docs/deployment.md §9).
 */
function originOf(value: string | undefined): string {
  if (!value) return ''
  try {
    return new URL(value).origin
  } catch {
    // A relative path, or nonsense: same origin, nothing to add.
    return ''
  }
}

function connectOrigins(): string {
  const origins = [
    originOf(process.env.NUXT_PUBLIC_API_BASE_URL),
    originOf(process.env.NUXT_PUBLIC_STORAGE_ORIGIN),
  ]
  return [...new Set(origins.filter(Boolean))].join(' ')
}

/**
 * Content Security Policy for the app shell.
 *
 * Delivered as a meta tag because Clinote is a static bundle that people are
 * expected to self-host on whatever web server they already run — a policy that
 * only exists in an nginx snippet is a policy most deployments will not have.
 * The response header is still the better carrier where it is available, and
 * `docs/deployment.md` gives it; `frame-ancestors` in particular is ignored in
 * a meta tag, which is why `X-Frame-Options` is set there as well.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Nuxt injects critical CSS inline; scripts are the ones that matter here.
  "style-src 'self' 'unsafe-inline'",
  // `blob:` is how a stored file becomes a thumbnail without ever leaving the
  // device; `data:` is used by inlined icons.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${connectOrigins()}`.trim(),
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // `frame-ancestors` is deliberately absent: it is inert in a meta tag and
  // browsers log a warning for it. `X-Frame-Options: DENY` is the carrier that
  // works, and the deployment guide sets it.
].join('; ')

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',

  modules: ['@vite-pwa/nuxt'],

  /**
   * Local-first means the app is a client-side application: no server is
   * required for the Free experience, and the whole bundle can be served from
   * a CDN or run from the installed PWA with no network at all
   * (docs/architecture.md I1, docs/deployment.md §1).
   */
  ssr: false,

  devtools: { enabled: false },

  typescript: {
    strict: true,
    // Type checking runs as its own script (`pnpm typecheck`) so that dev
    // server start-up is not blocked by it.
    typeCheck: false,
  },

  runtimeConfig: {
    public: {
      // Relative by default: the API is served from the same origin as the app
      // in production, which is what lets the refresh cookie be SameSite=Strict
      // (docs/security.md §3, docs/deployment.md §1). In development the proxy
      // below makes that true locally too.
      apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL ?? '/api/v1',
      appVersion: process.env.NUXT_PUBLIC_APP_VERSION ?? '0.1.0',
    },
  },

  app: {
    head: {
      title: 'Clinote',
      htmlAttrs: { lang: 'en' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        {
          name: 'description',
          content: 'Local-first practice management. Your data. Your device.',
        },
        { name: 'theme-color', content: '#0f172a' },
        // iOS only treats a page as installable-to-standalone with these, and
        // installing is the R1 mitigation (docs/architecture.md §7).
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'apple-mobile-web-app-title', content: 'Clinote' },
        // Left out in development, where Vite's HMR client is injected inline
        // and a strict script-src would break every reload.
        ...(process.env.NODE_ENV === 'production'
          ? [{ 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }]
          : []),
      ],
      link: [
        // Declared here rather than left to the PWA module: without the
        // manifest link no browser offers to install the app, and that is not
        // a failure worth discovering on a user's phone.
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png' },
        { rel: 'icon', type: 'image/svg+xml', href: '/icons/icon.svg' },
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
      ],
    },
  },

  css: ['~/assets/css/main.css'],

  /**
   * Headers for deployments that serve the bundle through Nitro. A static host
   * needs the equivalent in its own configuration — see docs/deployment.md §8.
   *
   * The policy itself is deliberately not among them: it carries per-build
   * script hashes and lives in the page, where it is always correct. A second,
   * stale copy in a header would intersect with it and block the app.
   */
  routeRules: {
    '/**': {
      headers: {
        'x-content-type-options': 'nosniff',
        // What the meta tag cannot express.
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      },
    },
  },

  hooks: {
    /**
     * The inline script Nuxt writes into the page changes with every build, so
     * its hash is added to the policy once the page exists. Without this the
     * app loads and then does nothing, which is a bad way to find out.
     */
    'nitro:build:public-assets': (nitro) => {
      const rewritten = applyScriptHashesToDirectory(nitro.options.output.publicDir)
      // A build that produced pages but hashed none of them has shipped a
      // policy that will block the app, so it is worth saying out loud.
      if (rewritten === 0) console.warn('csp: no inline script hashed — check the policy')
    },
  },

  nitro: {
    devProxy: {
      '/api': {
        target: process.env.NUXT_API_PROXY_TARGET ?? 'http://localhost:3001/api',
        changeOrigin: false,
      },
    },
  },

  pwa: {
    registerType: 'prompt',

    // Clinote owns the service worker body: rendering a push notification from
    // local data is the whole reason the payload can stay content-free
    // (docs/notifications.md §2).
    strategies: 'injectManifest',
    srcDir: 'service-worker',
    filename: 'sw.ts',

    manifest: {
      name: 'Clinote',
      short_name: 'Clinote',
      description: 'Local-first practice management. Your data. Your device.',
      lang: 'en',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#0f172a',
      theme_color: '#0f172a',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        {
          src: '/icons/icon-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },

    injectManifest: {
      // The app shell is precached so a cold start works with no network at
      // all. No API response is ever cached: a stale entitlement or stale
      // backup metadata would be worse than an honest offline state
      // (docs/local-first.md §8).
      globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
    },

    // The module generates sw.js and the manifest; Clinote registers the
    // worker itself (see composables/useServiceWorker.ts) so that the offline
    // guarantee does not depend on module internals.
    injectRegister: false,

    client: {
      installPrompt: false,
      registerPlugin: false,
    },

    devOptions: {
      enabled: false,
    },
  },
})
