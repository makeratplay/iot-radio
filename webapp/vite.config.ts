import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const secretsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../secrets');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, secretsDir, '');
  if (!process.env.VITE_GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_ID) process.env.VITE_GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
  return { plugins: [react()], envDir: secretsDir };
});
