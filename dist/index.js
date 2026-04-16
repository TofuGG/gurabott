"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_ts_1 = require("./config.ts");
const bot_ts_1 = require("./bot.ts");
const web_ts_1 = __importDefault(require("./web.ts"));
const readline_1 = __importDefault(require("readline"));
// Create a single readline interface
const rl = readline_1.default.createInterface({
    input: process.stdin,
    output: process.stdout
});
async function main() {
    // Load config once, pass the rl
    const config = await (0, config_ts_1.loadConfig)(rl);
    // Initialize web server
    (0, web_ts_1.default)();
    // Create bot
    (0, bot_ts_1.createBot)({
        ip: config.client.host,
        port: parseInt(config.client.port, 10),
        username: config.client.username,
        version: config.client.version
    }, rl); // pass rl so bot commands work
}
// Run the main function
main().catch((err) => {
    console.error('Fatal error:', err);
});
