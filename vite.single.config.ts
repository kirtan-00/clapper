import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Single-file offline build. Produces ONE self-contained dist-single/clapper.html
// with every script, style, and asset inlined — no network requests, ever — so
// the owner can save it to his phone (Files / WhatsApp / AirDrop) and open it
// directly, including from file:// or a sandboxed webview.
//
// Deliberately NO PWA plugin here: a service worker or manifest fetch is useless
// (and noisy) from file://, so this build omits both. The normal PWA build in
// vite.config.ts is left completely untouched.

const OUT_DIR = 'dist-single';

/** Rename the emitted index.html to clapper.html so the file is send-ready. */
function renameToClapper(): Plugin {
  return {
    name: 'rename-to-clapper',
    enforce: 'post',
    writeBundle() {
      const dir = resolve(__dirname, OUT_DIR);
      const from = resolve(dir, 'index.html');
      const to = resolve(dir, 'clapper.html');
      if (existsSync(from)) renameSync(from, to);
    },
  };
}

export default defineConfig({
  base: './', // relative asset resolution so it works from file://
  publicDir: false, // don't copy PWA icons; nothing outside the HTML is referenced
  plugins: [react(), viteSingleFile(), renameToClapper()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000, // inline every asset regardless of size
    // Single chunk keeps everything inlinable in one <script>.
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
