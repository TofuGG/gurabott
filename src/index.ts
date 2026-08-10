/**
 * index.ts - Gurabott entry point
 */

import { loadConfig } from './config.ts';
import initWeb from './web.ts';
import readline from 'readline';
import { addLog, interceptConsole } from './core/store.ts';
import { initFileLogging } from './core/logFile.ts';
import { handleCommand } from './modules/commands.ts';

let shuttingDown = false;

async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    addLog('system', 'Shutting down...');
    const tui = await import('./ui/index.tsx');
    try { await tui.destroyTUI(); } catch {}
    process.exit(0);
}

async function main() {
    // OpenTUI is the sole terminal UI. The engine never sees the UI — it only
    // exposes the initTUI/destroyTUI/updateAIStatus surface.
    const tui = await import('./ui/index.tsx');

    // Use readline ONLY for the config prompts before the TUI starts.
    // We MUST close it before initTUI so the TUI gets exclusive stdin ownership.
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });

    const config = await loadConfig(rl);

    // Hand stdin back — the TUI will take it from here.
    rl.close();

    // node's readline (used above for the config prompts) installs its own
    // raw-byte -> 'keypress' decoder on process.stdin. rl.close() does NOT
    // remove that decoder — it leaves the underlying 'data' listener attached.
    // Stripping readline's listeners here gives the TUI a clean stdin to own.
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('data');

    // bot.ts does `import CONFIG from '../config.json'` at its top level,
    // which Node resolves the moment the module loads. Loading it dynamically
    // here — after loadConfig() has guaranteed config.json exists on disk —
    // instead of statically at the top of this file means a first-time run
    // on a fresh clone (no config.json yet) reaches the interactive setup
    // instead of crashing with ERR_MODULE_NOT_FOUND before it ever starts.
    // Keep the module namespace (not a destructured copy): AI_ENABLED is a
    // `let` assigned inside createBot(), so a destructure would snapshot the
    // pre-connect `undefined` and status/startup would wrongly read "OFF".
    const botModule = await import('./bot.ts');
    const { createBot, getBotCommandCtx } = botModule;

    const serverInfo = `${config.client.host}:${config.client.port}  ·  ${config.client.username}`;

    await tui.initTUI({
        onCommand: async (cmd: string, args: string[]) => {
            const fullCmd = [cmd, ...args].join(' ');
            addLog('system', `[SHELL] ${fullCmd}`);
            if (cmd === 'quit' || cmd === 'exit') {
                await shutdown();
                return;
            }
            if (cmd === 'status') {
                addLog('system', `AI: ${botModule.AI_ENABLED ? 'ON' : 'OFF'} | Server: ${config.client.host}:${config.client.port}`);
                return;
            }

            const ctx = getBotCommandCtx();
            if (!ctx) { addLog('warn', 'Bot not connected yet'); return; }
            await handleCommand(ctx, 'Shell', fullCmd);
        },
        onExit: shutdown,
        aiEnabled: botModule.AI_ENABLED,
        serverInfo,
    });

    interceptConsole();

    initFileLogging(config.client.username);

    addLog('system', '🤖 Gurabott starting...');
    addLog('system', `Connecting to ${config.client.host}:${config.client.port} as ${config.client.username}`);
    if (!botModule.AI_ENABLED) {
        addLog('warn', 'AI disabled — set ai.enabled=true and provide a Groq API key in config.json');
    }

    initWeb();

    // createBot no longer receives rl — TUI owns input now.
    createBot(
        { ip: config.client.host, port: parseInt(config.client.port, 10), username: config.client.username },
    );

    process.on('SIGINT', () => {
        addLog('system', 'SIGINT received, shutting down...');
        void shutdown();
    });

    process.on('SIGTERM', () => {
        addLog('system', 'SIGTERM received, shutting down...');
        void shutdown();
    });

    process.on('unhandledRejection', (reason: any) => {
        addLog('error', `Unhandled rejection: ${reason?.message ?? reason}`);
    });

    process.on('uncaughtException', (err) => {
        addLog('error', `Uncaught exception: ${err.message}`);
    });
}

main().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});