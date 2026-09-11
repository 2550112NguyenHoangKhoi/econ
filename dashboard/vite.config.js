import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Pinned, and strict. The port is not a free choice: server/auth.go treats the
    // dashboard origin as :5173 when deciding which API host a page may talk to,
    // auth_test.go asserts on it, and the puppeteer checks in this directory navigate
    // to it directly. Letting Vite fall back to :5174 when the port is busy silently
    // breaks all three, so fail loudly instead.
    port: 5173,
    strictPort: true,
  },
})
