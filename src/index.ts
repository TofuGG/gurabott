import { loadConfig } from './config.ts';
import { createBot } from './bot.ts';
import initWeb from './web.ts';
import readline from 'readline';

// Create a single readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function main() {
    // Load prismarine-viewer first (before config prompt)
    let mineflayerViewer: any = null;
    try {
        const viewer = await import('prismarine-viewer');
        mineflayerViewer = viewer.default?.mineflayer || viewer.mineflayer || viewer.default;
        if (mineflayerViewer) {
            console.log('✓ prismarine-viewer loaded');
        }
    } catch (err) {
        console.warn('⚠️  prismarine-viewer not available:', (err as any).message);
    }
    
    console.log(''); // blank line for spacing
    
    // Load config once, pass the rl
    const config = await loadConfig(rl);

    // Initialize web server
    initWeb();

    // Create bot
    const botConfig = {
        ip: config.client.host,
        port: parseInt(config.client.port, 10),
        username: config.client.username
    };
    console.log(`\n🔄 Connecting to ${botConfig.ip}:${botConfig.port} as ${botConfig.username}...`);
    createBot(botConfig, rl, mineflayerViewer);
}

// Run the main function
main().catch((err) => {
    console.error('Fatal error:', err);
});
