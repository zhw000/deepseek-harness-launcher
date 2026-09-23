import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** The renderer alone in a browser, backed by the simulated bridge in src/renderer/src/mock.ts. */
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: { port: 5199, strictPort: true },
})
