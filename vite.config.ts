import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
        background_color: '#fbfaf7',
        theme_color: '#fbfaf7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
});
