import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Dev only: forward /api/chat and /api/resources to the FoodFit API (chat-api/).
    // The watsonx key lives in that server, never in the browser bundle.
    proxy: {
      '/api': {
        target: process.env.CHAT_API_URL ?? 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
})
