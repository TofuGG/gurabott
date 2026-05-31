/**
 * bot.ts - Main bot orchestrator
 * Thin coordinator: creates bot, wires modules, dispatches events.
 */

import Mineflayer from 'mineflayer';
import pathfinderLib from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import * as readline from 'readline';
import Groq from 'groq-sdk';

import { sleep, getRandom } from './utils.js';
import CONFIG from '../config.json' with { type: 'json' };
import PERSONALITY from '../personality.json' with { type: 'json' };

import { BotState, attachBot, getState, setState, clearAllControls } from './modules/state.js';
import { addLog, attachBotToTUI, setConnected } from './modules/tui.js';
import { getAIResponse, clearHistory, type AIContext } from './modules/ai.js';
import { handleCommand, type CommandContext } from './modules/commands.js';
import { initReconnect, resetReconnectAttempts, triggerReconnect, setDisconnecting } from './modules/connection.js';
import { startStuckDetector } from './stuckDetector.js';
import { startMovementAI } from './movementAI.js';

const { pathfinder, Movements } = pathfinderLib;
const { goals } = pathfinderLib;

// ── AI Setup ──────────────────────────────────────────────────────────────────

const AI_ENABLED = CONFIG.ai.enabled && CONFIG.ai.apiKey && CONFIG.ai.apiKey !== 'YOUR_GROQ_API';
const groq = AI_ENABLED ? new Groq({ apiKey: CONFIG.ai.apiKey }) : null;

const aiCtx: AIContext | null = AI_ENABLED && groq ? {
    groq,
    model: 'llama-3.1-8b-instant',
    maxTokens: CONFIG.ai.maxTokens,
    systemPrompt: (PERSONALITY as any).systemPrompt,
    aiCommands: (PERSONALITY as any).aiCommands?.available ?? [],
    responseFormat: (PERSONALITY as any).aiSettings?.responseFormat ?? '',
    chimeDuration: (PERSONALITY as any).aiSettings?.chimeDuration ?? '',
    glitchMessage: (PERSONALITY as any).messages?.glitchVoice ?? 'Glitch!',
    maxHistoryPerPlayer: (PERSONALITY as any).aiSettings?.conversionHistoryPerPlayer ?? 20,
} : null;

// ── Bot State ─────────────────────────────────────────────────────────────────

let bot: Mineflayer.Bot;
let lastPlayerJoined: string | null = null;
let currentConfig: { ip: string; port: number; username: string } | null = null;
let rlInstance: readline.Interface | null = null;
const intervals: NodeJS.Timeout[] = [];
let lastFleeTime = 0;
let isEscapingStuck = false;
let lastChimeTime = 0;
let lastHurtMessageTime = 0;

const collecting = { active: false, summary: {} as Record<string, number> };

const HOSTILE_MOBS = new Set([
    'zombie', 'creeper', 'skeleton', 'spider', 'enderman', 'witch', 'slime', 'drowned', 'husk', 'stray',
    'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'blaze', 'magma_cube', 'ghast',
    'wither_skeleton', 'piglin', 'piglin_brute', 'zombified_piglin', 'hoglin', 'zoglin', 'warden', 'shulker',
    'silverfish', 'endermite', 'guardian', 'elder_guardian', 'vex',
]);

// ── Movements ─────────────────────────────────────────────────────────────────

function getSafeMovements(): any {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.canOpenDoors = true;
    (movements as any).interactWithBlocks = true;
    (movements as any).liquidCost = 100;
    return movements;
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildCommandCtx(): CommandContext {
    return {
        bot,
        personality: PERSONALITY,
        getSafeMovements,
        intervals,
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

    const parsed = await getAIResponse(aiCtx, username, message, trigger, buildAIStateContext());
    if (!parsed) {
        if (trigger !== 'chime') bot.chat(aiCtx.glitchMessage);
        return;
    }

    if (parsed.chatText) bot.chat(parsed.chatText);

    const ctx = buildCommandCtx();
    for (const action of parsed.actions) {
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
}

// ── Disconnect ────────────────────────────────────────────────────────────────

const disconnect = (): void => {
    setDisconnecting(true);
    for (const i of intervals) clearInterval(i);
    intervals.length = 0;
    try { bot?.removeAllListeners(); } catch {}
    try { bot?.quit(); } catch {}
    setDisconnecting(false);
};

// ── Bot Creator ───────────────────────────────────────────────────────────────

export function createBot(
    config: { ip: string; port: number; username: string },
    rl: readline.Interface,
    mineflayerViewer?: any,
): void {
    currentConfig = config;
    rlInstance = rl;

    initReconnect({
        maxAttempts: 5,
        delayMs: CONFIG.action.retryDelay,
        onReconnect: () => {
            disconnect();
            if (currentConfig && rlInstance) createBot(currentConfig, rlInstance, mineflayerViewer);
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

    bot.loadPlugin(pathfinder);
    attachBot(bot);
    attachBotToTUI(bot);

    // Wire readline to gsay
    rl.removeAllListeners('line');
    rl.on('line', (line) => {
        const [cmd, ...args] = line.trim().split(/\s+/);
        if (cmd === 'gsay') {
            try { bot.chat(args.join(' ')); } catch {}
        }
    });

    // ── Events ──────────────────────────────────────────────────────────────

    bot.on('error', (err) => {
        addLog('error', `Network error: ${err.message}`);
    });

    bot.on('end', (reason) => {
        addLog('warn', `Connection ended: ${reason}`);
        setConnected(false);
        triggerReconnect();
    });

    bot.on('kicked', (reason, loggedIn) => {
        addLog('error', `Kicked: ${reason} (loggedIn=${loggedIn})`);
    });

    bot.once('login', () => {
        bot.setMaxListeners(40);
        addLog('system', `Connected to ${config.ip}:${config.port} as ${config.username}`);
        if (AI_ENABLED) {
            setTimeout(() => {
                try { bot.chat((PERSONALITY as any).messages.login); } catch {}
            }, 500);
        }
    });

    bot.on('entityHurt', (entity) => {
        if (!bot?.entity || entity !== bot.entity) return;
        if ((bot.health ?? 20) <= 0) return;

        const now = Date.now();
        if (now - lastHurtMessageTime < 3000) return;
        lastHurtMessageTime = now;

        const nearby = Object.values(bot.entities ?? {}).find(e =>
            e.position?.distanceTo(bot.entity.position) < 4 && e.type === 'mob'
        );

        const messages = (PERSONALITY as any).messages?.hurt ?? [];
        if (nearby?.name && messages.length > 0) {
            bot.chat(messages[0].replace('{mob}', nearby.name));
        } else {
            bot.chat(getRandom(messages));
        }
    });

    bot.on('chat', async (username, message) => {
        if (!bot || username === bot.username) return;

        // Always try commands first
        const ctx = buildCommandCtx();
        const handled = await handleCommand(ctx, username, message).catch(() => false);

        const botName = bot.username.toLowerCase();
        const msgLower = message.toLowerCase();
        const state = getState();

        // Solo mode: bot is alone with one player
        if (getOtherPlayerCount() === 1 && !msgLower.includes(botName)) {
            if (state === BotState.IDLE || state === BotState.FOLLOWING) {
                await handleAIResponse(username, message, 'solo');
            }
            return;
        }

        // Direct mention
        if (msgLower.includes(botName)) {
            await handleAIResponse(username, message, 'mentioned');
            return;
        }

        // Chime on interesting keywords (only when idle, with cooldown)
        if (state !== BotState.IDLE) return;
        const keywords = (PERSONALITY as any).interestingKeywords ?? [];
        const isInteresting = keywords.some((kw: string) => msgLower.includes(kw));
        if (!isInteresting) return;

        const now = Date.now();
        if (now - lastChimeTime < 2 * 60 * 1000) return;
        lastChimeTime = now;
        await handleAIResponse(username, message, 'chime');
    });

    // ── Spawn ────────────────────────────────────────────────────────────────

    const onlineBeforeSpawn = new Set<string>();

    bot.once('spawn', async () => {
        resetReconnectAttempts();
        if (!bot?.entity) return;

        addLog('system', `Bot spawned. Version: ${bot.version}. AI: ${AI_ENABLED ? 'ON' : 'OFF'}`);

        if (mineflayerViewer) {
            try {
                mineflayerViewer(bot, { port: 3007, firstPerson: false });
                addLog('system', 'Viewer running on http://localhost:3007');
            } catch (err: any) {
                addLog('warn', `Could not start viewer: ${err?.message}`);
            }
        }

        bot.pathfinder.setMovements(getSafeMovements());
        startStuckDetector(bot, (v) => { isEscapingStuck = v; });

        for (const name of Object.keys(bot.players)) onlineBeforeSpawn.add(name);
        await sleep(1000);
        for (const name of Object.keys(bot.players)) onlineBeforeSpawn.add(name);

        // ── Water survival intervals ─────────────────────────────────────────

        intervals.push(setInterval(() => {
            if (!bot?.entity) return;
            const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (headBlock?.name?.includes('water')) {
                const msgs = (PERSONALITY as any).messages?.waterHelp ?? [];
                if (msgs.length > 0) bot.chat(getRandom(msgs));
            }
        }, 3000));

        let waterEscaping = false;
        intervals.push(setInterval(async () => {
            if (!bot?.entity?.position || getState() !== BotState.IDLE || waterEscaping) return;
            const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            const feetBlock = bot.blockAt(bot.entity.position.offset(0, 0, 0));
            const isInWater = headBlock?.name?.includes('water') || feetBlock?.name?.includes('water');
            if (!isInWater) {
                bot.setControlState('jump', false);
                bot.setControlState('forward', false);
                return;
            }

            const botY = Math.floor(bot.entity.position.y);
            const shore = bot.findBlock({
                matching: (block) => !!(
                    block?.name &&
                    !block.name.includes('water') &&
                    block.boundingBox === 'block' &&
                    block.position?.y >= botY
                ),
                maxDistance: 20,
            });

            if (shore) {
                await bot.lookAt(shore.position.offset(0.5, 1, 0.5));
                bot.setControlState('jump', true);
                bot.setControlState('forward', true);
            } else {
                waterEscaping = true;
                bot.setControlState('jump', false);
                bot.setControlState('forward', false);
                try {
                    const dryLand = bot.findBlock({
                        matching: (block) => !!(block?.name && !block.name.includes('water') && block.boundingBox === 'block'),
                        maxDistance: 32,
                    });
                    if (dryLand) {
                        await bot.pathfinder.goto(new goals.GoalBlock(dryLand.position.x, dryLand.position.y + 1, dryLand.position.z));
                    }
                } catch {
                    bot.setControlState('jump', true);
                } finally {
                    waterEscaping = false;
                }
            }
        }, 1000));

        startMovementAI(bot, () => getState(), getSafeMovements, HOSTILE_MOBS, intervals, () => isEscapingStuck);
    });

    // ── Player events ────────────────────────────────────────────────────────

    bot.on('playerJoined', (player) => {
        if (!player?.username || player.username === bot.username) return;
        if (onlineBeforeSpawn.has(player.username)) {
            onlineBeforeSpawn.delete(player.username);
            return;
        }
        lastPlayerJoined = player.username;
        addLog('system', `${player.username} joined the server`);

        const templates = (PERSONALITY as any).messages?.playerJoined ?? [];
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

    // ── Flee behavior ────────────────────────────────────────────────────────

    bot.on('entityMoved', (entity) => {
        if (!bot?.entity) return;
        if (!entity || entity.type !== 'mob' || !entity.position) return;
        if (getState() === BotState.FLEEING) return;
        if ((bot.health ?? 20) <= 0) return;

        const now = Date.now();
        if (now - lastFleeTime < 3000) return;

        const mobName = entity.name?.toLowerCase();
        if (!mobName || !HOSTILE_MOBS.has(mobName)) return;

        const distance = bot.entity.position.distanceTo(entity.position);
        if (distance >= 6) return;

        lastFleeTime = now;
        setState(BotState.FLEEING);

        const botPos = bot.entity.position;
        const dx = botPos.x - entity.position.x;
        const dz = botPos.z - entity.position.z;
        const length = Math.sqrt(dx * dx + dz * dz) || 1;
        const runX = botPos.x + (dx / length) * 8;
        const runZ = botPos.z + (dz / length) * 8;
        let runY = botPos.y;

        for (let y = Math.floor(botPos.y); y > 0; y--) {
            const block = bot.blockAt(new Vec3(runX, y, runZ));
            if (block && block.boundingBox === 'block') { runY = y + 1; break; }
        }

        try {
            const msg = ((PERSONALITY as any).messages?.mobThreat ?? '{mob}!').replace('{mob}', mobName);
            bot.chat(msg);
            bot.pathfinder.setMovements(getSafeMovements());
            bot.pathfinder.setGoal(new goals.GoalBlock(Math.round(runX), Math.round(runY), Math.round(runZ)));
        } catch (e: any) {
            addLog('error', `Flee error: ${e?.message}`);
        }

        setTimeout(() => {
            if (getState() === BotState.FLEEING) setState(BotState.IDLE);
        }, 5000);
    });
}

/** Returns the current command context (or null if bot not yet created) */
export function getBotCommandCtx(): CommandContext | null {
    if (!bot) return null;
    return buildCommandCtx();
}

export { AI_ENABLED };
