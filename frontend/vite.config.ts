import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api/geocode': { target: process.env.LOCATION_API_TARGET || 'http://127.0.0.1:8002', changeOrigin: true } } },
})
