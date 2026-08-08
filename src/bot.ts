/**
 * bot.ts - Main bot orchestrator
 * Thin coordinator: creates bot, wires modules, dispatches events.
 */

import Mineflayer from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import Groq from 'groq-sdk';

import { getRandom, parseChatMessage } from './utils.ts';

import { BotState, attachBot, getState, setState } from './modules/state.ts';
import { addLog, pushTelemetry } from './core/store.ts';
import { getAIResponse, clearHistory, type AIContext } from './modules/ai.ts';
import { handleCommand, type CommandContext } from './modules/commands.ts';
import { initReconnect, resetReconnectAttempts, triggerReconnect, setDisconnecting } from './modules/connection.ts';
import { initAuth } from './modules/auth.ts';
import { startStuckDetector } from './stuckDetector.ts';
import { startMovementAI, resetMovementSuppression } from './movementAI.ts';
import { BotSession } from './session.ts';
import { setBotHealthStatus } from './web.ts';
import { startMcpServer, stopMcpServer } from './modules/mcp.ts';
import { createCombatController, type CombatController } from './modules/combat.ts';
import { startWaterSurvival } from './modules/water.ts';
import { HOSTILE_MOBS } from './constants.ts';
import { loadJson } from './config.ts';

// BUG-1 FIX: Lazy-load JSON config files so they are read at createBot()
// time (after the interactive setup has guaranteed they exist on disk)
// rather than at module-graph resolution time (which crashes with
// ERR_MODULE_NOT_FOUND on a fresh clone).

let CONFIG: any;
let PERSONALITY: any;
let AI_ENABLED: boolean;
let groq: any;
let aiCtx: AIContext | null;

// ── Bot State ─────────────────────────────────────────────────────────────────

let bot: Mineflayer.Bot;
let lastPlayerJoined: string | null = null;
let currentConfig: { ip: string; port: number; username: string } | null = null;
const intervals: NodeJS.Timeout[] = [];
let session: BotSession | null = null;
let deathRespawnAttempts = 0;
let isEscapingStuck = false;
let lastChimeTime = 0;
let lastHurtMessageTime = 0;
let aiDispatchLock = false;
let spawned = false;
let isConnected = false;

// ── Telemetry ─────────────────────────────────────────────────────────────────
// Push a typed snapshot into the core store so any UI layer renders live
// status without touching the bot object. Emitted on connection events and on
// a 1s cadence while a session is alive.

function pushBotTelemetry(): void {
    const b = bot;
    pushTelemetry({
        connected: isConnected && !!b?.entity,
        server: currentConfig ? `${currentConfig.ip}:${currentConfig.port}` : '',
        username: b?.username ?? '',
        ping: b?.player?.ping ?? -1,
        players: b ? Object.keys(b.players ?? {}).length : 0,
        hp: b?.health ?? 0,
        food: b?.food ?? 0,
        pos: b?.entity?.position
            ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z }
            : null,
        state: getState(),
        invCount: b?.inventory?.items?.()?.length ?? 0,
        aiEnabled: AI_ENABLED,
        uptime: process.uptime(),
    });
}

const collecting = { active: false, summary: {} as Record<string, number> };

// ── Pathfinder Config ─────────────────────────────────────────────────────────

function configureBaritone(overrides?: Record<string, any>) {
    if (!bot?.ashfinder) {
        addLog('warn', '[BOT] configureBaritone called but ashfinder not ready');
        return;
    }
    const cfg = bot.ashfinder.config;
    cfg.breakBlocks = false;
    cfg.placeBlocks = false;
    cfg.parkour = true;
    cfg.allowSprinting = true;
    cfg.swimming = true;
    cfg.maxFallDist = 3;
    if (overrides) {
        for (const [k, v] of Object.entries(overrides)) {
            (cfg as any)[k] = v;
        }
        addLog('movement', `[MOV] configureBaritone overrides: ${Object.keys(overrides).join(', ')}`);
    }
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildCommandCtx(): CommandContext {
    return {
        bot,
        personality: PERSONALITY,
        configureBaritone,
        intervals,
        session: session as BotSession,
        collecting,
        lastPlayerJoined: () => lastPlayerJoined,
        HOSTILE_MOBS,
    };
}

function buildAIStateContext(): string {
    const pos = bot?.entity?.position;
    const nearby = getNearbyBlocks();
    const inv = getInventorySummary();
    return `State: ${getState()}. HP: ${bot?.health ?? '?'}/20. Food: ${bot?.food ?? '?'}/20. Pos: ${pos ? `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}` : 'unknown'}. Nearby: ${nearby}. Inv: ${inv}.`;
}

function getNearbyBlocks(): string {
    if (!bot?.entity) return 'unknown';
    const pos = bot.entity.position;
    const seen = new Set<string>();
    for (let x = -4; x <= 4; x++)
        for (let y = -2; y <= 2; y++)
            for (let z = -4; z <= 4; z++) {
                const block = bot.blockAt(pos.offset(x, y, z));
                if (block && block.name !== 'air') seen.add(block.name);
            }
    return [...seen].slice(0, 12).join(', ') || 'nothing';
}

function getInventorySummary(): string {
    const items = bot?.inventory?.items?.() ?? [];
    if (items.length === 0) return 'empty';
    return items.map(i => `${i.name} x${i.count}`).join(', ');
}

function getOtherPlayerCount(): number {
    return Object.keys(bot?.players ?? {}).filter(n => n !== bot.username).length;
}

// ── AI handler ────────────────────────────────────────────────────────────────

async function handleAIResponse(
    username: string,
    message: string,
    trigger: 'mentioned' | 'chime' | 'solo',
): Promise<void> {
    if (!AI_ENABLED || !aiCtx) {
        bot.chat('Sorry, AI is not available. Use basic commands!');
        return;
    }
    if (aiDispatchLock) {
        addLog('warn', '[BOT] AI dispatch already in progress — skipping');
        return;
    }
    aiDispatchLock = true;
    try {
        const parsed = await getAIResponse(aiCtx, username, message, trigger, buildAIStateContext());
        if (!parsed) {
            if (trigger !== 'chime') bot.chat(aiCtx.glitchMessage);
            return;
        }

        // H2: After await, check bot is still alive
        if (!bot?.entity || (bot.health ?? 0) <= 0) {
            addLog('warn', '[BOT] Bot died/disconnected during AI response — aborting actions');
            return;
        }

        if (parsed.chatText) bot.chat(parsed.chatText);

        const ctx = buildCommandCtx();
        for (const action of parsed.actions) {
            if (!bot?.entity || (bot.health ?? 0) <= 0) break;
            switch (action.type) {
                case 'FOLLOW':    await handleCommand(ctx, username, `gfollow ${action.target}`); break;
                case 'COLLECT':   await handleCommand(ctx, username, `gcollect ${action.args}`); break;
                case 'SLEEP':     await handleCommand(ctx, username, 'gsleep'); break;
                case 'STOP':      await handleCommand(ctx, username, 'gsfollow'); break;
                case 'OPEN_DOOR': await handleCommand(ctx, username, 'gopendoor'); break;
                case 'DROP_ALL':  await handleCommand(ctx, username, 'gdump'); break;
                case 'WALK':      await handleCommand(ctx, username, 'gwalk'); break;
                case 'DROP': {
                    const items = bot.inventory.items();
                    const idx = items.findIndex(i => i.name === action.item);
                    if (idx !== -1) await handleCommand(ctx, username, `gdrop ${idx + 1} ${action.amount}`);
                    break;
                }
                case 'EAT': {
                    const items = bot.inventory.items();
                    const idx = items.findIndex(i => i.name === action.item);
                    if (idx !== -1) await handleCommand(ctx, username, `geat ${idx + 1} 1`);
                    break;
                }
                case 'JUMP':   await handleCommand(ctx, username, `gjump ${action.amount}`); break;
                case 'CROUCH': await handleCommand(ctx, username, `gcr ${action.seconds}`); break;
            }
        }
    } finally {
        aiDispatchLock = false;
    }
}

// ── Disconnect ────────────────────────────────────────────────────────────────

const disconnect = (): void => {
    addLog('system', '[BOT] Disconnecting — cleaning up intervals and listeners');
    setDisconnecting(true);
    // Kill the session first: this clears every session-tracked timer
    // (movementAI schedule, survival restart) and flips session.alive so any
    // in-flight async loop sees the connection is gone and stops itself.
    session?.end();
    // MCP server must not outlive the bot it exposes — stop it so the port is
    // freed and a fresh server starts on reconnect (mirrors session cleanup).
    void stopMcpServer();
    // Snapshot intervals before clearing — iterate the copy so concurrent
    // pushes to the original array don't cause missed cleanup.
    const snapshot = [...intervals];
    intervals.length = 0;
    for (const t of snapshot) { clearTimeout(t); clearInterval(t); }
    try { bot?.removeAllListeners(); } catch {}
    try { bot?.ashfinder?.removeAllListeners?.(); } catch {}
    try { bot?.quit(); } catch {}
    // Release the module-level bot/session refs so getBotCommandCtx() returns
    // null until the replacement bot exists. Commands issued during the
    // reconnect delay must not act on the corpse of the old connection.
    session = null;
    bot = null as any;
    setDisconnecting(false);
    addLog('system', '[BOT] Disconnect cleanup complete');
};

// ── Bot Creator ───────────────────────────────────────────────────────────────

export function createBot(
    config: { ip: string; port: number; username: string },
): void {
    // BUG-1 FIX: Load config files lazily (after interactive setup guarantees they exist)
    CONFIG = loadJson('config.json');
    PERSONALITY = loadJson('personality.json');
    AI_ENABLED = CONFIG.ai.enabled && CONFIG.ai.apiKey && CONFIG.ai.apiKey !== 'YOUR_GROQ_API';
    groq = AI_ENABLED ? new Groq({ apiKey: CONFIG.ai.apiKey }) : null;
    aiCtx = AI_ENABLED && groq ? {
        groq,
        model: 'llama-3.1-8b-instant',
        maxTokens: CONFIG.ai.maxTokens,
        systemPrompt: PERSONALITY.systemPrompt,
        aiCommands: PERSONALITY.aiCommands?.available ?? [],
        responseFormat: PERSONALITY.aiSettings?.responseFormat ?? '',
        chimeDuration: PERSONALITY.aiSettings?.chimeDuration ?? '',
        glitchMessage: PERSONALITY.messages?.glitchVoice ?? 'Glitch!',
        maxHistoryPerPlayer: PERSONALITY.aiSettings?.conversionHistoryPerPlayer ?? 20,
    } : null;

    // MCP server — hosts an MCP endpoint so ANY AI (opencode, Claude, Cursor,
    // ...) can observe and control the bot, independent of the Groq AI mode.
    const mcpConfig = (CONFIG as any).mcp ?? {};
    if (mcpConfig.enabled !== false) {
        void startMcpServer({
            getCtx: () => getBotCommandCtx(),
            host: process.env.MCP_HOST || mcpConfig.host || '127.0.0.1',
            port: parseInt(process.env.MCP_PORT || mcpConfig.port || '5400', 10),
        });
    }

    // Reset module-level state for clean reconnect
    isEscapingStuck = false;
    lastChimeTime = 0;
    lastHurtMessageTime = 0;
    aiDispatchLock = false;
    spawned = false;
    collecting.active = false;
    collecting.summary = {};

    // Fresh session for this connection — the previous session's timers were
    // cleared by disconnect(). resetMovementSuppression() also clears any
    // suppression flag left over from a command that was interrupted by the
    // previous disconnect (otherwise the new bot would never move again).
    session = new BotSession();
    resetMovementSuppression();

    addLog('system', `[BOT] createBot — AI: ${AI_ENABLED ? 'ON' : 'OFF'}, Host: ${config.ip}:${config.port}`);

    currentConfig = config;

    initReconnect({
        maxAttempts: 5,
        delayMs: CONFIG.action.retryDelay,
        onReconnect: () => {
            disconnect();
            if (currentConfig) createBot(currentConfig);
        },
        onGiveUp: () => {
            addLog('error', 'Reconnect failed. Please restart the bot.');
        },
    });

    bot = Mineflayer.createBot({
        host: config.ip,
        port: config.port,
        username: config.username,
        version: (config as any).version || false,
    } as any);

    bot.loadPlugin(baritonePlugin.loader);
    attachBot(bot);
    // Telemetry producer — live status for any connected UI. Runs for the
    // whole connection lifetime; disconnect() clears it with the other
    // intervals.
    intervals.push(setInterval(pushBotTelemetry, 1000));
    // Input is now handled exclusively by the TUI. No readline here.

    const authConfig = (CONFIG as any).auth ?? {
        enabled: false,
        password: '',
        mode: 'command',
        debugWindows: false,
        gui: { titleMatch: ['login', 'register', 'authme'], slotMap: {}, clickDelayMs: 500 },
    };
    initAuth(bot, authConfig);

    // ── Events ──────────────────────────────────────────────────────────────

    bot.on('error', (err) => {
        addLog('error', `Network error: ${err.message}`);
    });

    bot.on('end', (reason) => {
        addLog('warn', `[BOT] Connection ended: ${reason}`);
        isConnected = false;
        // Kill the session IMMEDIATELY, not at reconnect time: the connection
        // is gone, so movementAI/survival must not keep scheduling against the
        // dead bot during the reconnect delay (would be a zombie loop).
        // disconnect() calls session.end() again — it's idempotent.
        session?.end();
        pushBotTelemetry();
        setBotHealthStatus(false, 'disconnected');
        triggerReconnect();
    });

    bot.on('kicked', (reason, loggedIn) => {
        addLog('error', `Kicked: ${reason} (loggedIn=${loggedIn})`);
        isConnected = false;
        pushBotTelemetry();

        // Kicks caused by bans, rate-limits or failed auth should NOT trigger
        // the reconnect loop — reconnecting would just hammer the server and
        // risk an IP ban. 'end' always follows 'kicked', so gate the loop now.
        const reasonStr = String(reason ?? '').toLowerCase();
        const permanentKick = ['ban', 'banned', 'rate limit', 'too fast', 'auth', 'login', 'register', 'password', 'invalid'].some(k => reasonStr.includes(k));

        // config.autoReconnect (default true) is the master switch for the
        // whole reconnect loop.
        const autoReconnect = (CONFIG as any).autoReconnect !== false;

        if (permanentKick) {
            addLog('error', '[BOT] Permanent kick (ban/rate-limit/auth) — stopping reconnect loop');
            setDisconnecting(true);
        } else if (!autoReconnect) {
            addLog('warn', '[BOT] autoReconnect disabled — stopping reconnect loop');
            setDisconnecting(true);
        } else {
            addLog('warn', '[BOT] Transient kick — reconnect will be attempted via end handler');
        }
    });

    bot.once('login', () => {
        bot.setMaxListeners(40);
        isConnected = true;
        pushBotTelemetry();
        addLog('system', `[BOT] Connected to ${config.ip}:${config.port} as ${config.username}`);
        if (AI_ENABLED) {
            const loginMsg = (PERSONALITY as any).messages?.login;
            if (loginMsg) {
                setTimeout(() => {
                    try { bot.chat(loginMsg); } catch {}
                }, 500);
            }
        }
    });

    bot.on('entityHurt', (entity) => {
        if (!bot?.entity || entity !== bot.entity) return;
        if ((bot.health ?? 20) <= 0) return;

        const now = Date.now();
        if (now - lastHurtMessageTime < 3000) return;
        lastHurtMessageTime = now;

        const nearby = Object.values(bot.entities ?? {}).find((e: any) =>
            e.position?.distanceTo(bot.entity.position) < 4 && e.type === 'mob'
        ) as any;

        const messages: string[] = (PERSONALITY as any).messages?.hurt ?? [];
        if (nearby?.name && messages.length > 0) {
            bot.chat(getRandom(messages).replace('{mob}', nearby.name));
        } else if (messages.length > 0) {
            bot.chat(getRandom(messages));
        }
    });

    // ── Death & respawn ────────────────────────────────────────────────────
    // mineflayer only fires 'death'; we must call bot.respawn() ourselves or
    // the bot sits on the death screen forever. Retry with backoff in case the
    // death-screen packet arrives slightly after the event.
    bot.on('death', () => {
        if (!session?.alive) return;
        addLog('error', `[BOT] ☠ Died (health ${bot.health ?? 0}) — respawning...`);
        setBotHealthStatus(true, 'dead');
        isConnected = true;
        pushBotTelemetry();
        // Abort anything that was fighting: tasks must not keep issuing
        // movement/dig on the corpse, and wander must not run while dead.
        if (session) session.moveActive = false;
        setState(BotState.IDLE);
        try { combat?.stopCombat(); } catch {}
        try { bot.ashfinder.stop(); } catch {}
        respawnBot();
    });

    // Reset the respawn retry counter whenever we (re)enter the world. Also
    // a safe place to re-assert state if it was left non-IDLE by a death.
    bot.on('spawn', () => {
        deathRespawnAttempts = 0;
    });

    async function respawnBot(): Promise<void> {
        if (!session?.alive) return;
        if (deathRespawnAttempts >= 10) {
            addLog('error', '[BOT] Respawn failed 10× — giving up');
            return;
        }
        deathRespawnAttempts++;
        try {
            await bot.respawn();
            deathRespawnAttempts = 0;
            addLog('system', '[BOT] Respawned');
        } catch (err: any) {
            addLog('warn', `[BOT] Respawn attempt ${deathRespawnAttempts}/10 failed — retrying in 3s`);
            setTimeout(() => { respawnBot().catch(() => {}); }, 3000);
        }
    }

    bot.on('message', async (jsonMsg: any) => {
        const parsed = parseChatMessage(jsonMsg, bot.username);
        if (!parsed) return;
        const { username, message } = parsed;
        addLog('chat', `[CHAT] <${username}> ${message}`);

        if (!bot || !bot.entity || (bot.health ?? 0) <= 0) return;

        // Always try commands first
        const ctx = buildCommandCtx();
        const handled = await handleCommand(ctx, username, message).catch(() => false);

        // If it was a command (handled by the command dispatcher), never pass to AI
        if (handled) return;

        // H3: Re-check bot alive after command await
        if (!bot?.entity || (bot.health ?? 0) <= 0) return;

        const botName = bot.username.toLowerCase();
        const msgLower = message.toLowerCase();
        const state = getState();

        // Solo mode: bot is alone with one player — respond conversationally
        if (getOtherPlayerCount() === 1 && !msgLower.includes(botName)) {
            if (state === BotState.IDLE || state === BotState.FOLLOWING) {
                await handleAIResponse(username, message, 'solo').catch(err => {
                    addLog('error', `[BOT] AI solo response failed: ${err?.message ?? err}`);
                });
            }
            return;
        }

        // H3: Re-check bot alive after AI await
        if (!bot?.entity || (bot.health ?? 0) <= 0) return;

        // Direct mention
        if (msgLower.includes(botName)) {
            await handleAIResponse(username, message, 'mentioned').catch(err => {
                addLog('error', `[BOT] AI mention response failed: ${err?.message ?? err}`);
            });
            return;
        }

        // H3: Re-check bot alive after AI await
        if (!bot?.entity || (bot.health ?? 0) <= 0) return;

        // Chime on interesting keywords (only when idle, with cooldown)
        if (state !== BotState.IDLE) return;
        const keywords = (PERSONALITY as any).interestingKeywords ?? [];
        const isInteresting = keywords.some((kw: string) => msgLower.includes(kw));
        if (!isInteresting) return;

        const now = Date.now();
        if (now - lastChimeTime < 2 * 60 * 1000) return;
        lastChimeTime = now;
        await handleAIResponse(username, message, 'chime').catch(err => {
            addLog('error', `[BOT] AI chime response failed: ${err?.message ?? err}`);
        });
    });

    // ── Spawn ────────────────────────────────────────────────────────────────

    bot.once('spawn', async () => {
        resetReconnectAttempts();
        if (!bot?.entity) return;

        isConnected = true;
        pushBotTelemetry();
        addLog('system', `[BOT] Spawned — version: ${bot.version}, AI: ${AI_ENABLED ? 'ON' : 'OFF'}`);
        addLog('system', `[BOT] Initializing modules...`);
        setBotHealthStatus(true, 'spawning');

        configureBaritone();
        addLog('system', '[BOT] Baritone configured');
        startStuckDetector(bot, (v) => { isEscapingStuck = v; }, session!);
        addLog('system', '[BOT] Stuck detector started');

        // ── Water survival intervals ─────────────────────────────────────────
        startWaterSurvival({
            bot,
            intervals,
            waterHelpMessages: (PERSONALITY as any).messages?.waterHelp ?? [],
        });

        startMovementAI(bot, () => getState(), configureBaritone, HOSTILE_MOBS, session!, () => isEscapingStuck);
        addLog('system', '[BOT] Movement AI started');
        addLog('system', '[BOT] All modules initialized');
        setBotHealthStatus(true, 'idle');

        spawned = true;
    });

    // ── Player events ────────────────────────────────────────────────────────

    bot.on('playerJoined', (player) => {
        if (!player?.username || player.username === bot.username) return;
        if (!spawned) return;
        lastPlayerJoined = player.username;
        addLog('system', `${player.username} joined the server`);

        if (CONFIG.greeting === false) return;
        const templates: string[] = (PERSONALITY as any).messages?.playerJoined ?? [];
        if (templates.length > 0) {
            const msg = getRandom(templates).replace('{player}', player.username);
            setTimeout(() => { try { bot.chat(msg); } catch {} }, 1000);
        }
    });

    bot.on('playerLeft', (player) => {
        if (player?.username) {
            clearHistory(player.username);
            addLog('system', `${player.username} left`);
        }
    });

    // ── Combat / flee behavior ────────────────────────────────────────────────
    // Fight if ≤3 hostile mobs nearby; flee if overwhelmed or low HP. The
    // controller owns the fight/flee state machine and the hostile scanners.
    let combat: CombatController | null = null;

    function startCombatMonitoring(): void {
        combat = createCombatController({ bot, session: session as BotSession, intervals, configureBaritone });
        combat.startHostileMonitoring();
    }

    startCombatMonitoring();
}

/** Returns the current command context (or null if bot not yet created) */
export function getBotCommandCtx(): CommandContext | null {
    if (!bot) return null;
    return buildCommandCtx();
}

export { AI_ENABLED };