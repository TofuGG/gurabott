#!/usr/bin/env node

/**
 * run.mjs — cross-platform launcher for Gurabott.
 *
 * Picks the Node binary that can run the OpenTUI UI, which needs the
 * experimental `node:ffi` module (Node >= 26.6, --experimental-ffi):
 *
 *   1. If a project-local portable runtime exists (node-runtime/<node-v*>/
 *      from node-runtime/download.ps1 on Windows or download.sh on
 *      Linux/macOS), use it — this is how the bot runs even when the system
 *      Node is older than 26.6.
 *   2. Otherwise fall back to the system `node` (process.execPath).
 *
 * The required flags are passed as CLI arguments (NOT via NODE_OPTIONS, whose
 * allowlist rejects --experimental-ffi on some Node versions), so this works
 * on Windows, Linux and macOS alike.
 *
 * Usage: node scripts/run.mjs [--inspect ...] <entry>
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Resolve the Node binary ────────────────────────────────────────────────

function resolveNodeBin() {
    try {
        const runtimeDir = fs.readdirSync(path.join(root, 'node-runtime'))
            .find((d) => d.startsWith('node-v'));
        if (runtimeDir) {
            const bin = path.join(
                root,
                'node-runtime',
                runtimeDir,
                process.platform === 'win32' ? 'node.exe' : 'bin/node',
            );
            const major = Number(/node-v(\d+)/.exec(runtimeDir)?.[1] ?? 0);
            return { bin, major };
        }
    } catch {
        // No node-runtime/ present — fall through to the system node.
    }
    return { bin: process.execPath, major: Number(process.versions.node.split('.')[0]) };
}

const { bin, major } = resolveNodeBin();
if (major < 26) {
    console.error(
        `\n❌ OpenTUI needs Node >= 26.6 (node:ffi / --experimental-ffi), ` +
        `but the resolved node is v${major}.x.\n` +
        `   • Install Node 26.6+ and add it to PATH, or\n` +
        `   • Windows: run node-runtime\\download.ps1\n` +
        `   • Linux/macOS: run ./node-runtime/download.sh\n` +
        `   to fetch the portable Node 26.\n`,
    );
    process.exit(1);
}

// ── Parse args: leading "-" flags -> node flags, first non-flag -> entry ───

const argv = process.argv.slice(2);
const nodeFlags = argv.filter((a) => a.startsWith('-'));
const entry = argv.find((a) => !a.startsWith('-')) ?? './src/index.ts';

// The OpenTUI needs these; --max-old-space-size is a safety cap for the bot.
if (!nodeFlags.includes('--experimental-ffi')) nodeFlags.push('--experimental-ffi');
if (!nodeFlags.includes('--disable-warning=ExperimentalWarning')) nodeFlags.push('--disable-warning=ExperimentalWarning');
if (entry.includes('index.ts') && !nodeFlags.includes('--max-old-space-size=400')) {
    nodeFlags.push('--max-old-space-size=400');
}

// Load the entry with tsx as a Node --import loader. This runs the file in the
// SAME process as the flags above (tsx's own CLI wrapper spawns a child process
// that would NOT inherit --experimental-ffi, breaking OpenTUI's node:ffi).
const tsxLoader = 'tsx';

console.log('🤖 Starting Gurabott...\n');

const child = spawn(bin, [...nodeFlags, '--import', tsxLoader, entry], {
    cwd: root,
    stdio: 'inherit',
});

child.on('error', (err) => {
    console.error('❌ Failed to start:', err.message);
    process.exit(1);
});

process.on('SIGINT', () => {
    child.kill('SIGINT');
});

child.on('exit', (code) => {
    process.exit(code ?? 0);
});
