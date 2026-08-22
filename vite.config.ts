import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  test: {
    // Agent worktrees live at .claude/worktrees/<name>, INSIDE the repo, so
    // each one carries a full copy of the suite. On the default globs vitest
    // found all of them and reported 465 tests across 34 files where this
    // tree has 165 across 12 - the same suites counted three times.
    //
    // Nothing failed, which is exactly what makes it worth excluding: an
    // inflated green number is the shape a false "verified" arrives in.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Clapper',
        short_name: 'Clapper',
        description: 'On-set shot logger',
        display: 'standalone',
        orientation: 'portrait',
        // The PWA splash, which cannot follow a runtime toggle: it takes the
        // default theme. --paper from src/styles.css.
        background_color: '#e2f0cc',
        theme_color: '#e2f0cc',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
});
