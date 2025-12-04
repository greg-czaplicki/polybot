import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const useRemoteBindings = Boolean(process.env.CLOUDFLARE_ENV)
// Pass environment to wrangler via environment variable
if (process.env.CLOUDFLARE_ENV) {
  process.env.WRANGLER_ENV = process.env.CLOUDFLARE_ENV
}

const config = defineConfig({
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
})

export default config
