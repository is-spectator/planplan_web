import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // This value is consumed by the dev server only, never exposed via VITE_*.
  const env = loadEnv(mode, process.cwd(), 'PLANPLAN_')
  const target = process.env.PLANPLAN_API_TARGET ?? env.PLANPLAN_API_TARGET ?? 'http://127.0.0.1:8788'

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      proxy: Object.fromEntries(
        ['/v1', '/legal', '/healthz', '/readyz'].map((path) => [path, { target }]),
      ),
    },
  }
})
