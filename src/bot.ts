/**
 * bot.ts - Main bot orchestrator
 * Thin coordinator: creates bot, wires modules, dispatches events.
 */

import Mineflayer from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import Groq from 'groq-sdk';

import { sleep, getRandom, parseChatMessage } from './utils.ts';

import { BotState, attachBot, getState, setState, clearAllControls } from './modules/state.ts';
import { addLog, attachBotToTUI, setConnected } from './modules/tui.ts';
import { getAIResponse, clearHistory, type AIContext } from './modules/ai.ts';
import { handleCommand, type CommandContext } from './modules/commands.ts';
import { initReconnect, resetReconnectAttempts, triggerReconnect, setDisconnecting } from './modules/connection.ts';
import { initAuth } from './modules/auth.ts';
import { startStuckDetector } from './stuckDetector.ts';
import { startMovementAI } from './movementAI.ts';
import { setBotHealthStatus } from './web.ts';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baritoneGoals = baritonePlugin.goals;

// BUG-1 FIX: Lazy-load JSON config files so they are read at createBot()
// time (after the interactive setup has guaranteed they exist on disk)
// rather than at module-graph resolution time (which crashes with
// ERR_MODULE_NOT_FOUND on a fresh clone).
function loadJson<T>(relativePath: string): T {
    const p = path.join(__dirname, '..', relativePath);
    try {
        const raw = fs.readFileSync(p, 'utf-8');
        addLog('system', `[BOT] Loaded ${relativePath}`);
        return JSON.parse(raw) as T;
    } catch (err: any) {
        addLog('error', `[BOT] Failed to load ${relativePath}: ${err?.message ?? err}`);
        throw new Error(`Cannot load ${relativePath}: ${err?.message ?? err}`);
    }
}

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
let isEscapingStuck = false;
let lastChimeTime = 0;
let lastHurtMessageTime = 0;
let aiDispatchLock = false;
let spawned = false;

const collecting = { active: false, summary: {} as Record<string, number> };

const HOSTILE_MOBS = new Set([
    'zombie', 'creeper', 'skeleton', 'spider', 'enderman', 'witch', 'slime', 'drowned', 'husk', 'stray',
    'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'blaze', 'magma_cube', 'ghast',
    'wither_skeleton', 'piglin', 'piglin_brute', 'zombified_piglin', 'hoglin', 'zoglin', 'warden', 'shulker',
    'silverfish', 'endermite', 'guardian', 'elder_guardian', 'vex',
]);

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
    // Snapshot intervals before clearing — iterate the copy so concurrent
    // pushes to the original array don't cause missed cleanup.
    const snapshot = [...intervals];
    intervals.length = 0;
    for (const t of snapshot) { clearTimeout(t); clearInterval(t); }
    try { bot?.removeAllListeners(); } catch {}
    try { bot?.ashfinder?.removeAllListeners?.(); } catch {}
    try { bot?.quit(); } catch {}
    setDisconnecting(false);
    addLog('system', '[BOT] Disconnect cleanup complete');
};

// ── Bot Creator ───────────────────────────────────────────────────────────────

export function createBot(
    config: { ip: string; port: number; username: string },
    mineflayerViewer?: any,
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

    // Reset module-level state for clean reconnect
    isEscapingStuck = false;
    lastChimeTime = 0;
    lastHurtMessageTime = 0;
    aiDispatchLock = false;
    spawned = false;
    collecting.active = false;
    collecting.summary = {};

    addLog('system', `[BOT] createBot — AI: ${AI_ENABLED ? 'ON' : 'OFF'}, Host: ${config.ip}:${config.port}`);

    currentConfig = config;

    initReconnect({
        maxAttempts: 5,
        delayMs: CONFIG.action.retryDelay,
        onReconnect: () => {
            disconnect();
            if (currentConfig) createBot(currentConfig, mineflayerViewer);
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
    attachBotToTUI(bot);
    // Input is now handled exclusively by the TUI (blessed). No readline here.

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
        setConnected(false);
        setBotHealthStatus(false, 'disconnected');
        triggerReconnect();
    });

    bot.on('kicked', (reason, loggedIn) => {
        addLog('error', `Kicked: ${reason} (loggedIn=${loggedIn})`);
    });

    bot.once('login', () => {
        bot.setMaxListeners(40);
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

    bot.on('message', async (jsonMsg: any) => {
        const parsed = parseChatMessage(jsonMsg, bot.username);
        if (!parsed) return;
        const { username, message } = parsed;

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

    const onlineBeforeSpawn = new Set<string>();

    bot.once('spawn', async () => {
        resetReconnectAttempts();
        if (!bot?.entity) return;

        addLog('system', `[BOT] Spawned — version: ${bot.version}, AI: ${AI_ENABLED ? 'ON' : 'OFF'}`);
        addLog('system', `[BOT] Initializing modules...`);
        setBotHealthStatus(true, 'spawning');

        if (mineflayerViewer) {
            try {
                mineflayerViewer(bot, { port: 3007, firstPerson: false });
                addLog('system', '[BOT] Viewer running on http://localhost:3007');
            } catch (err: any) {
                addLog('warn', `[BOT] Could not start viewer: ${err?.message}`);
            }
        }

        configureBaritone();
        addLog('system', '[BOT] Baritone configured');
        startStuckDetector(bot, (v) => { isEscapingStuck = v; });
        addLog('system', '[BOT] Stuck detector started');

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
            try {
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
                            try { await bot.ashfinder.goto(new baritoneGoals.GoalExact(new Vec3(dryLand.position.x, dryLand.position.y + 1, dryLand.position.z))); } catch {}
                        }
                    } catch {
                        bot.setControlState('jump', true);
                    } finally {
                        waterEscaping = false;
                    }
                }
            } catch (err: any) {
                addLog('error', `[BOT] Water escape interval error: ${err?.message ?? err}`);
            }
        }, 1000));

        startMovementAI(bot, () => getState(), configureBaritone, HOSTILE_MOBS, intervals, () => isEscapingStuck);
        addLog('system', '[BOT] Movement AI started');
        addLog('system', '[BOT] All modules initialized');
        setBotHealthStatus(true, 'idle');

        // BUG-4 FIX: Clean up the temporary set — no longer needed after spawn
        onlineBeforeSpawn.clear();
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
    // Fight if ≤3 hostile mobs nearby; flee if overwhelmed or low HP.

    let combatActive    = false;
    let combatTimer: NodeJS.Timeout | null = null;

    function isHostileEntity(e: any): boolean {
        if (!e?.position || !e.name) return false;
        // mineflayer reports baby zombies and chicken jockeys as type 'mob' with name 'zombie'
        // Some versions report jockey riders with type 'mob' or no type — check both
        const name = e.name.toLowerCase();
        const validType = e.type === 'mob' || e.type === 'hostile' || !e.type;
        return validType && HOSTILE_MOBS.has(name);
    }

    function countNearbyHostiles(): number {
        return Object.values(bot.entities as Record<string, any>).filter(e =>
            isHostileEntity(e) &&
            e.position?.distanceTo(bot.entity.position) < 10
        ).length;
    }

    function getNearestHostile(): any {
        let nearest: any = null;
        let minDist = Infinity;
        for (const e of Object.values(bot.entities as Record<string, any>)) {
            if (!isHostileEntity(e)) continue;
            const d = e.position?.distanceTo(bot.entity.position) ?? Infinity;
            if (d < minDist) { minDist = d; nearest = e; }
        }
        return nearest;
    }

    function stopCombat() {
        if (combatTimer) {
            clearInterval(combatTimer);
            const idx = intervals.indexOf(combatTimer);
            if (idx !== -1) intervals.splice(idx, 1);
            combatTimer = null;
        }
        combatActive = false;
        if (getState() === BotState.ATTACKING || getState() === BotState.FLEEING) {
            setState(BotState.IDLE);
        }
    }

    function startCombat(target: any) {
        if (combatActive) return;
        combatActive = true;
        setState(BotState.ATTACKING);
        addLog('system', `[BOT] ⚔ Fighting ${target.name} at distance ${Math.round(target.position?.distanceTo(bot.entity.position) ?? 0)}`);

        // Equip best weapon
        const weaponPriority = [
            'netherite_sword','diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword',
            'netherite_axe',  'diamond_axe',  'iron_axe',  'stone_axe',  'golden_axe',  'wooden_axe',
        ];
        for (const w of weaponPriority) {
            const item = bot.inventory.items().find(i => i.name === w);
            if (item) { bot.equip(item, 'hand').catch(() => {}); break; }
        }

        configureBaritone();
        bot.ashfinder.followEntity(target, { distance: 1 }).catch(() => {});

        combatTimer = setInterval(() => {
            const hp = bot.health ?? 20;

            // Flee if HP critical or mob count overwhelming
            if (hp <= 5 || countNearbyHostiles() > 5) {
                stopCombat();
                doFlee(target);
                return;
            }

            // Target dead or gone
            const still = bot.entities[target.id];
            if (!still || still.position?.distanceTo(bot.entity.position) > 20) {
                // Check for other nearby mobs to chain-fight
                const next = getNearestHostile();
                if (next && next.position?.distanceTo(bot.entity.position) < 10) {
                    stopCombat();
                    startCombat(next);
                } else {
                    stopCombat();
                }
                return;
            }

            // Attack if in range
            if (still.position?.distanceTo(bot.entity.position) < 4) {
                try { bot.attack(still); } catch {}
            }
        }, 500);

        intervals.push(combatTimer);
    }

    function doFlee(threat: any) {
        if (getState() === BotState.FLEEING) return;
        setState(BotState.FLEEING);
        addLog('system', `[BOT] 🏃 Fleeing from ${threat.name} (HP: ${Math.round(bot.health ?? 20)})`);

        configureBaritone({ allowSprinting: true });

        // Keep recalculating flee destination every 800ms so bot never stops
        function updateFleeGoal() {
            if (getState() !== BotState.FLEEING || !bot?.entity) return;
            const botPos    = bot.entity.position;
            const threatPos = threat.position ?? botPos;
            const dx  = botPos.x - threatPos.x;
            const dz  = botPos.z - threatPos.z;
            const len = Math.sqrt(dx*dx + dz*dz) || 1;
            const runX = botPos.x + (dx/len) * 16;
            const runZ = botPos.z + (dz/len) * 16;
            try {
                if (!bot.ashfinder.isPathing) {
                    bot.ashfinder.goto(new baritoneGoals.GoalExact(new Vec3(Math.round(runX), Math.round(botPos.y), Math.round(runZ)))).catch(() => {});
                }
            } catch {}
        }

        updateFleeGoal();
        const fleeInterval = setInterval(updateFleeGoal, 800);
        intervals.push(fleeInterval as any);

        // Stop fleeing after 6s or when threat is gone
        const fleeStopTimer = setTimeout(() => {
            clearInterval(fleeInterval);
            if (getState() === BotState.FLEEING) {
                bot.ashfinder.stop();
                setState(BotState.IDLE);
            }
        }, 6000);
        intervals.push(fleeStopTimer as any);
    }

    // Trigger combat/flee whenever a mob moves into range
    bot.on('entityMoved', (entity: any) => {
        if (!bot?.entity) return;
        if (!isHostileEntity(entity)) return;
        if (combatActive) return;
        if (getState() === BotState.FLEEING || getState() === BotState.SLEEPING || getState() === BotState.COLLECTING) return;
        if ((bot.health ?? 20) <= 0) return;

        const dist = bot.entity.position.distanceTo(entity.position);
        if (dist >= 8) return;

        const mobCount = countNearbyHostiles();
        if (mobCount <= 3) {
            startCombat(entity);
        } else if (mobCount > 3) {
            doFlee(entity);
        }
    });

    // Also scan for mobs every 2s even if they haven't moved (handles spawns)
    const hostileScanInterval = setInterval(() => {
        if (!bot?.entity || combatActive) return;
        if (getState() === BotState.FLEEING || getState() === BotState.SLEEPING || getState() === BotState.COLLECTING) return;
        const nearest = getNearestHostile();
        if (!nearest) return;
        const dist = nearest.position?.distanceTo(bot.entity.position) ?? Infinity;
        if (dist < 8) {
            const mobCount = countNearbyHostiles();
            if (mobCount <= 3) startCombat(nearest);
            else doFlee(nearest);
        }
    }, 2000);
    intervals.push(hostileScanInterval as any);
}

/** Returns the current command context (or null if bot not yet created) */
export function getBotCommandCtx(): CommandContext | null {
    if (!bot) return null;
    return buildCommandCtx();
}

export { AI_ENABLED };