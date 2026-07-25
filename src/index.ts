/**
 * index.ts - Gurabott entry point
 */

import { loadConfig } from './config.ts';
import initWeb from './web.ts';
import readline from 'readline';
import { initTUI, addLog, interceptConsole, destroyTUI } from './modules/tui.ts';
import { handleCommand } from './modules/commands.ts';

async function main() {
    let mineflayerViewer: any = null;
    try {
        const viewer = await import('prismarine-viewer');
        mineflayerViewer = viewer.default?.mineflayer || (viewer as any).mineflayer || viewer.default;
    } catch {}

    // Use readline ONLY for the config prompts before the TUI starts.
    // We MUST close it before initTUI so blessed gets exclusive stdin ownership.
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });

    const config = await loadConfig(rl);

    // Hand stdin back — blessed will take it from here.
    rl.close();

    // BUG FIX: node's readline (used above for the config prompts) installs
    // its own raw-byte -> 'keypress' decoder on process.stdin. rl.close()
    // does NOT remove that decoder — it only stops readline from reacting to
    // 'keypress' events, it leaves the underlying 'data' listener attached.
    // blessed installs its own, separate 'data' -> 'keypress' decoder when
    // the TUI starts (its guard flag has a different name, so it doesn't
    // know readline's decoder is already there). With both decoders alive,
    // every physical keystroke gets decoded twice, so typing "hello" was
    // rendered as "hheelllloo". Stripping readline's listeners here gives
    // blessed a clean stdin to attach to.
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('data');

    // bot.ts does `import CONFIG from '../config.json'` at its top level,
    // which Node resolves the moment the module loads. Loading it dynamically
    // here — after loadConfig() has guaranteed config.json exists on disk —
    // instead of statically at the top of this file means a first-time run
    // on a fresh clone (no config.json yet) reaches the interactive setup
    // instead of crashing with ERR_MODULE_NOT_FOUND before it ever starts.
    const { AI_ENABLED, createBot, getBotCommandCtx } = await import('./bot.ts');

    const serverInfo = `${config.client.host}:${config.client.port}  ·  ${config.client.username}`;

    initTUI({
        onCommand: async (cmd: string, args: string[]) => {
            if (cmd === 'quit' || cmd === 'exit') {
                addLog('system', 'Shutting down...');
                destroyTUI();
                process.exit(0);
            }
            if (cmd === 'status') {
                addLog('system', `AI: ${AI_ENABLED ? 'ON' : 'OFF'} | Server: ${config.client.host}:${config.client.port}`);
                return;
            }

            const ctx = getBotCommandCtx();
            if (!ctx) { addLog('warn', 'Bot not connected yet'); return; }
            const fullCmd = [cmd, ...args].join(' ');
            await handleCommand(ctx, 'Shell', fullCmd);
        },
        aiEnabled: AI_ENABLED,
        serverInfo,
    });

    interceptConsole();

    addLog('system', '🤖 Gurabott starting...');
    addLog('system', `Connecting to ${config.client.host}:${config.client.port} as ${config.client.username}`);
    if (!AI_ENABLED) {
        addLog('warn', 'AI disabled — set ai.enabled=true and provide a Groq API key in config.json');
    }

    initWeb();

    // createBot no longer receives rl — TUI owns input now.
    createBot(
        { ip: config.client.host, port: parseInt(config.client.port, 10), username: config.client.username },
        mineflayerViewer,
    );

    process.on('SIGINT', () => {
        addLog('system', 'SIGINT received, shutting down...');
        destroyTUI();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        addLog('system', 'SIGTERM received, shutting down...');
        destroyTUI();
        process.exit(0);
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