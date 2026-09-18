// @ts-check
import { defineConfig } from 'astro/config';

// Static site. `astro build` outputs to `dist/`, served by Cloudflare as static
// assets (see wrangler.jsonc). Everything dynamic — the request form, tracking,
// the admin API, printer progress — lives in worker/index.js, so no SSR adapter.
export default defineConfig({
  site: 'https://creates.harborpointedesigns.com',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
});
