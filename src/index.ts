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
    // Load config once, pass the rl
    const config = await loadConfig(rl);

    // Initialize web server
    initWeb();

    // Create bot
    createBot({
        ip: config.client.host,
        port: parseInt(config.client.port, 10),
        username: config.client.username
    }, rl); // pass rl so bot commands work
}

// Run the main function
main().catch((err) => {
    console.error('Fatal error:', err);
});
