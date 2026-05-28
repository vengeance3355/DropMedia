import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { config as dotenv } from 'dotenv'

dotenv()

const SUPABASE_URL      = process.env.SUPABASE_URL      ?? ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ''

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    },
    define: {
      'process.env.SUPABASE_URL':      JSON.stringify(SUPABASE_URL),
      'process.env.SUPABASE_ANON_KEY': JSON.stringify(SUPABASE_ANON_KEY)
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    css: {
      postcss: './postcss.config.cjs'
    }
  }
})
