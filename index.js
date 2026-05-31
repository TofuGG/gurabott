#!/usr/bin/env node

/**
 * Gurabott - Customizable Minecraft AI Bot
 * Entry point for direct execution
 * 
 * Usage: node index.js
 * For development with hot reload: npm run dev
 * For normal start: npm start
 */

const { spawn } = require('child_process');
const path = require('path');

const tsxPath = require.resolve('tsx/esm');
const indexPath = path.join(__dirname, 'src', 'index.ts');

console.log('🤖 Starting Gurabott...\n');

const child = spawn('node', ['--loader', 'tsx', indexPath], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: process.platform === 'win32'
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

