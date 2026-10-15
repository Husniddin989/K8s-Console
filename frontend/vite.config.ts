import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Keep the browser's Host header so the API's same-origin check matches the page origin.
const api = 'http://127.0.0.1:3001'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/ws': { target: api.replace('http', 'ws'), ws: true, changeOrigin: false },
    },
  },
})
