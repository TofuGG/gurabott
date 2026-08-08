#!/usr/bin/env node

/**
 * Gurabott - Customizable Minecraft AI Bot
 * Entry point for direct execution
 *
 * Usage: node index.js
 * For development with hot reload: npm run dev
 * For normal start: npm start
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The OpenTUI requires node:ffi (--experimental-ffi), which only the bundled
// node-runtime binary provides — so we resolve it here instead of system node.
const runtimeDir = fs.readdirSync(path.join(__dirname, 'node-runtime'))
  .find((d) => d.startsWith('node-v'));
const nodeBin = path.join(
  __dirname,
  'node-runtime',
  runtimeDir,
  process.platform === 'win32' ? 'node.exe' : 'bin/node',
);
const tsxCli = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const indexPath = path.join(__dirname, 'src', 'index.ts');

console.log('🤖 Starting Gurabott...\n');

const child = spawn(nodeBin, [tsxCli, indexPath], {
  cwd: __dirname,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: '--experimental-ffi --max-old-space-size=400',
  },
});

child.on('error', (err) => {
  console.error('❌ Failed to start bot:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  child.kill('SIGTERM');
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
