"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const fs_1 = __importDefault(require("fs"));
const CONFIG_FILE = './config.json';
async function loadConfig(rl) {
    let existing = null;
    if (fs_1.default.existsSync(CONFIG_FILE)) {
        try {
            existing = JSON.parse(fs_1.default.readFileSync(CONFIG_FILE, 'utf-8'));
        }
        catch {
            console.warn('Could not read existing config. Will create new.');
        }
    }
    function ask(question) {
        return new Promise((resolve) => rl.question(question, resolve));
    }
    let usePrevious = false;
    if (existing) {
        const ans = await ask(`Use previous configuration? (y/n) [y]: `);
        usePrevious = ans.trim().toLowerCase() !== 'n'; // default yes
    }
    let config;
    if (usePrevious && existing) {
        config = existing;
    }
    else {
        const host = (await ask(`Enter server IP [${existing?.client.host ?? '127.0.0.1'}]: `)) || existing?.client.host || '127.0.0.1';
        const port = (await ask(`Enter server port [${existing?.client.port ?? '25565'}]: `)) || existing?.client.port || '25565';
        const username = (await ask(`Enter bot username [${existing?.client.username ?? 'Bot'}]: `)) || existing?.client.username || 'Bot';
        const version = (await ask(`Enter game version [${existing?.client.version ?? '1.20.4'}]: `)) || existing?.client.version || '1.20.4';
        config = {
            client: { host, port, username, version },
            logLevel: existing?.logLevel ?? ['error', 'log', 'debug'],
            action: existing?.action ?? {
                commands: ['forward', 'back', 'left', 'right', 'jump'],
                holdDuration: 5000,
                retryDelay: 5000
            }
        };
        fs_1.default.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('New configuration saved to', CONFIG_FILE);
    }
    // Do NOT close rl here
    return config;
}
