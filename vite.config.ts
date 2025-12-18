import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// Pass environment to wrangler via environment variable
if (process.env.CLOUDFLARE_ENV) {
  process.env.WRANGLER_ENV = process.env.CLOUDFLARE_ENV
}

export default defineConfig(({ mode }) => {
  // Read environment variable at config evaluation time
  const useRemoteBindings = Boolean(process.env.CLOUDFLARE_ENV)
  
  console.log(`🔧 Vite config: CLOUDFLARE_ENV=${process.env.CLOUDFLARE_ENV || 'not set'}, remoteBindings=${useRemoteBindings}`)

  return {
    plugins: [
      devtools(),
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        remoteBindings: useRemoteBindings,
        configPath: './wrangler.jsonc',
        persist: useRemoteBindings ? false : undefined, // Disable local persistence when using remote
      }),
      // this is the plugin that enables path aliases
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
  }
})
