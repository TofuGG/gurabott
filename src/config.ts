import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

export interface BotConfig {
    client: {
        host: string;
        port: string;
        username: string;
    };
    ai: {
        enabled: boolean;
        apiKey: string;
        maxTokens: number;
    };
    auth: {
        enabled: boolean;
        password: string;
        mode: 'command' | 'gui' | 'anvil' | 'both';
        debugWindows: boolean;
        gui: {
            titleMatch: string[];
            slotMap: Record<string, number>;
            clickDelayMs: number;
        };
    };
    logLevel: string[];
    action: {
        commands: string[];
        holdDuration: number;
        retryDelay: number;
    };
}

// Resolved relative to this file's own location (repo root, one level up
// from src/), not process.cwd() — so it works no matter what directory the
// process is launched from.
const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

export async function loadConfig(rl: readline.Interface): Promise<BotConfig> {
    let existing: BotConfig | null = null;

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        } catch {
            console.warn('Could not read existing config. Will create new.');
        }
    }

    function ask(question: string): Promise<string> {
        return new Promise((resolve) => rl.question(question, resolve));
    }

    let usePrevious = false;
    if (existing) {
        const ans = await ask(`Use previous configuration? (y/n) [y]: `);
        usePrevious = ans.trim().toLowerCase() !== 'n'; // default yes
    }

    let config: BotConfig;
    if (usePrevious && existing) {
        config = existing;
        // Config files saved before the auth feature existed won't have this
        // block — backfill it so initAuth() always gets a well-formed object.
        if (!config.auth) {
            config.auth = {
                enabled: false,
                password: '',
                mode: 'command',
                debugWindows: false,
                gui: { titleMatch: ['login', 'register', 'authme'], slotMap: {}, clickDelayMs: 500 },
            };
        }
    } else {
        const host = (await ask(`Enter server IP [${existing?.client.host ?? '127.0.0.1'}]: `)) || existing?.client.host || '127.0.0.1';
        const port = (await ask(`Enter server port [${existing?.client.port ?? '25565'}]: `)) || existing?.client.port || '25565';
        const username = (await ask(`Enter bot username [${existing?.client.username ?? 'Bot'}]: `)) || existing?.client.username || 'Bot';
        const enableAI = (await ask(`Enable AI features? (y/n) [${existing?.ai?.enabled ? 'y' : 'n'}]: `)).trim().toLowerCase() === 'y';
        const apiKey = enableAI 
            ? (await ask(`Enter Groq API key [${existing?.ai?.apiKey ? '***' : 'YOUR_GROQ_API'}]: `)) || existing?.ai?.apiKey || 'YOUR_GROQ_API'
            : 'YOUR_GROQ_API';

        const enableAuth = (await ask(`Does this server require a /login password? (y/n) [${existing?.auth?.enabled ? 'y' : 'n'}]: `)).trim().toLowerCase() === 'y';
        const authPassword = enableAuth
            ? (await ask(`Enter login password [${existing?.auth?.password ? '***' : ''}]: `)) || existing?.auth?.password || ''
            : (existing?.auth?.password ?? '');
        let authMode: BotConfig['auth']['mode'] = existing?.auth?.mode ?? 'command';
        if (enableAuth) {
            const modeAns = (await ask(`Login method — command / gui / anvil / both [${authMode}]: `)).trim().toLowerCase();
            if (modeAns === 'command' || modeAns === 'gui' || modeAns === 'anvil' || modeAns === 'both') {
                authMode = modeAns;
            }
        }

        config = {
            client: { host, port, username },
            ai: {
                enabled: enableAI,
                apiKey,
                maxTokens: existing?.ai?.maxTokens ?? 150
            },
            auth: {
                enabled: enableAuth,
                password: authPassword,
                mode: authMode,
                debugWindows: existing?.auth?.debugWindows ?? false,
                gui: existing?.auth?.gui ?? {
                    titleMatch: ['login', 'register', 'authme'],
                    slotMap: {},
                    clickDelayMs: 500,
                },
            },
            logLevel: existing?.logLevel ?? ['error', 'log', 'debug'],
            action: existing?.action ?? {
                commands: ['forward', 'back', 'left', 'right', 'jump'],
                holdDuration: 5000,
                retryDelay: 5000
            }
        };

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('New configuration saved to', CONFIG_FILE);
    }

    // Do NOT close rl here
    return config;
}