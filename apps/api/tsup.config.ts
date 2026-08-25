import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Workspace packages are published as TypeScript source, so they are bundled
  // rather than externalized (docs/architecture.md §5).
  noExternal: [/^@clinote\//],
  clean: true,
  sourcemap: true,
})
