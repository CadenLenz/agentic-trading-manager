import { sites } from '@openai/sites-vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const apiTarget = `http://127.0.0.1:${process.env.PORT ?? '4010'}`;
  return {
    plugins: [react(), sites()],
    build: { outDir: 'dist/web', sourcemap: true },
    server: { port: 3000, proxy: { '/api': apiTarget, '/health': apiTarget } },
  };
});
