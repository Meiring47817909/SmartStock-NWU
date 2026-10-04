import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': fromRoot('./src'),
      'server-only': fromRoot('./tests/helpers/empty.ts'),
    },
  },
  test: {
    environment: 'node',
    // Every test file shares one test database, so files must not run at the same time.
    fileParallelism: false,
  },
})
