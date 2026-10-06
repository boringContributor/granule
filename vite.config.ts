import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    allowedHosts: ['eed0-2003-e9-af4b-ec00-17a-ccb8-dd61-bb66.ngrok-free.app'],
  },
  build: { chunkSizeWarningLimit: 1200 },
})
