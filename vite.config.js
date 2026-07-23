import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    // @wordpress/* packages reference process.env.* in their published ESM
    'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production'),
    'process.env.IS_GUTENBERG_PLUGIN': 'false',
    'process.env.IS_WORDPRESS_CORE': 'false',
    'process.env.FORCE_REDUCED_MOTION': 'false',
    'process.env.SCRIPT_DEBUG': 'false',
    'process.env': '{}',
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:4950' },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 3000,
  },
}));
