import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // electron-vite leaves bundles unminified by default; the main process stays readable for stack traces.
    build: { minify: true },
  },
})
