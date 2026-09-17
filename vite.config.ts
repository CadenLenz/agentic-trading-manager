import { sites } from '@openai/sites-vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({mode}) => {
  // Use the same .env + inherited-environment precedence as the API process.
  // This prevents a stale/default Vite proxy port from diverging from Fastify.
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.PORT ?? '4010');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('PORT must be a valid TCP port');
  const apiTarget = `http://127.0.0.1:${apiPort}`;
  return {
    plugins: [react(), sites()],
    build: { outDir: 'dist/web', sourcemap: true },
    server: { port: 3000, proxy: { '/api': apiTarget, '/health': apiTarget } },
  };
});
