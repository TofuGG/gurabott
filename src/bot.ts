import Mineflayer from 'mineflayer';
import pathfinderLib from 'mineflayer-pathfinder';
import { sleep, getRandom } from "./utils.ts";
import CONFIG from "../config.json" with { type: 'json' };
import PERSONALITY from "../personality.json" with { type: 'json' };
import readline from 'readline';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
const { pathfinder, Movements, goals } = pathfinderLib;
const { GoalFollow } = goals;
import Groq from 'groq-sdk';

// Check if AI is enabled and API key is provided
const AI_ENABLED = CONFIG.ai.enabled && CONFIG.ai.apiKey && CONFIG.ai.apiKey !== 'YOUR_GROQ_API';
const groq = AI_ENABLED ? new Groq({ apiKey: CONFIG.ai.apiKey }) : null;
const conversationHistory: { [player: string]: { role: 'user' | 'assistant', content: string }[] } = {};

let bot: Mineflayer.Bot;
let lastPlayerJoined: string | null = null;
let currentConfig: { ip: string; port: number; username: string } | null = null;
let rlInstance: readline.Interface | null = null;
let collecting = false;
let collectedSummary: { [key: string]: number } = {};
let intervals: NodeJS.Timeout[] = [];
let lastFleeTime = 0;
let lastChimeTime = 0;
let lastHurtMessageTime = 0;

const HOSTILE_MOBS = new Set([
    "zombie", "creeper", "skeleton", "spider", "enderman", "witch", "slime", "drowned", "husk", "stray",
    "phantom", "pillager", "vindicator", "evoker", "ravager", "illusioner", "blaze", "magma_cube", "ghast",
    "wither_skeleton", "piglin", "piglin_brute", "zombified_piglin", "hoglin", "zoglin", "warden", "shulker",
    "silverfish", "endermite", "guardian", "elder_guardian", "vex"
]);

enum BotState {
    IDLE = 'idle',
    FOLLOWING = 'following',
    COLLECTING = 'collecting',
    FLEEING = 'fleeing',
    EATING = 'eating',
    SLEEPING = 'sleeping'
}

let currentState: BotState = BotState.IDLE;

function setState(newState: BotState) {
    if (currentState === newState) return;
    console.log(`[STATE] ${currentState} → ${newState}`);
    currentState = newState;
    try {
        bot.pathfinder?.setGoal(null);
        clearAllControls(bot);
    } catch {}
}

const disconnect = (): void => {
    for (const i of intervals) clearInterval(i);
    intervals = [];
    bot?.removeAllListeners();
    bot?.quit();
};

let reconnectAttempts = 0;
let reconnecting = false;

async function reconnect() {
    if (reconnecting) return;
    reconnecting = true;

    if (reconnectAttempts >= 5) {
        console.log("Too many reconnect attempts. Stopping.");
        return;
    }

    reconnectAttempts++;
    console.log(`Reconnecting (${reconnectAttempts}/5) in ${CONFIG.action.retryDelay / 1000}s...`);
    disconnect();
    await sleep(CONFIG.action.retryDelay);

    if (currentConfig && rlInstance) {
        createBot(currentConfig, rlInstance);
    }
    reconnecting = false;
}

function startCommandLine(bot: any, rl: readline.Interface) {
    rl.on('line', (line) => {
        const [cmd, ...args] = line.trim().split(/\s+/);
        if (cmd === 'gsay') {
            bot.chat(args.join(' '));
        }
    });
}

function clearAllControls(bot: Mineflayer.Bot) {
    const controls: Mineflayer.ControlState[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    for (const c of controls) bot.setControlState(c, false);
}

function getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

type AITrigger = 'mentioned' | 'chime' | 'solo';

function getNearbyBlocks(): string {
    if (!bot.entity) return 'unknown';
    const pos = bot.entity.position;
    const seen = new Set<string>();
    for (let x = -4; x <= 4; x++) {
        for (let y = -2; y <= 2; y++) {
            for (let z = -4; z <= 4; z++) {
                const block = bot.blockAt(pos.offset(x, y, z));
                if (block && block.name !== 'air') seen.add(block.name);
            }
        }
    }
    return [...seen].slice(0, 12).join(', ') || 'nothing';
}

function getInventorySummary(): string {
    const items = bot.inventory.items();
    if (items.length === 0) return 'empty';
    return items.map(i => `${i.name} x${i.count}`).join(', ');
}

function getSafeMovements() {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.canOpenDoors = true;
    // Tells pathfinder to actually interact with blocks (doors, trapdoors, etc.)
    (movements as any).interactWithBlocks = true;
    
    return movements;
}

// Returns number of non-bot players currently online
function getOtherPlayerCount(): number {
    return Object.keys(bot.players).filter(name => name !== bot.username).length;
}

async function handleAIResponse(username: string, message: string, trigger: AITrigger) {
    if (!AI_ENABLED || !groq) {
        bot.chat("Sorry, AI features are not available right now. Use basic commands instead!");
        return;
    }

    if (!conversationHistory[username]) {
        conversationHistory[username] = [];
    }

    await sleep(trigger === 'chime' ? 3000 : 800);

    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            max_tokens: CONFIG.ai.maxTokens,
            messages: [
                {
                    role: 'system',
                    content: `${PERSONALITY.systemPrompt}
State: ${currentState}. HP: ${bot.health}/20. Food: ${bot.food}/20. Pos: ${bot.entity.position}. Nearby: ${getNearbyBlocks()}. Inv: ${getInventorySummary()}.

Commands (use ONLY these, exact spelling):
${PERSONALITY.aiCommands.available.join('\n')}

${PERSONALITY.aiSettings.responseFormat}
${trigger === 'chime' ? PERSONALITY.aiSettings.chimeDuration : ''}`
                },
                ...conversationHistory[username],
                { role: 'user', content: message }
            ]
        });

        const reply = response.choices[0].message.content?.trim() ?? '';

        conversationHistory[username].push(
            { role: 'user', content: message },
            { role: 'assistant', content: reply }
        );

        // Cap history at configured max per player
        if (conversationHistory[username].length > PERSONALITY.aiSettings.conversionHistoryPerPlayer) {
            conversationHistory[username] = conversationHistory[username].slice(-PERSONALITY.aiSettings.conversionHistoryPerPlayer);
        }

        const lines = reply.split('\n').map(l => l.trim()).filter(Boolean);
        const ACTION_PREFIXES = ['FOLLOW ', 'COLLECT ', 'SLEEP', 'STOP', 'OPEN_DOOR', 'DROP_ALL', 'DROP ', 'EAT ', 'JUMP ', 'WALK', 'CROUCH '];
        const isAction = (line: string) => ACTION_PREFIXES.some(p => line.startsWith(p));

        const actionLines = lines.filter(isAction);
        const chatLine = lines.filter(l => !isAction(l)).join(' ');

        if (chatLine) bot.chat(chatLine);

        for (const line of actionLines) {
            if (line.startsWith('FOLLOW ')) {
                const target = line.replace('FOLLOW ', '').trim();
                await handleChatCommand(username, `gfollow ${target}`);

            } else if (line.startsWith('COLLECT ')) {
                const collectArgs = line.replace('COLLECT ', '').trim();
                await handleChatCommand(username, `gcollect ${collectArgs}`);

            } else if (line === 'SLEEP') {
                await handleChatCommand(username, 'gsleep');

            } else if (line === 'STOP') {
                await handleChatCommand(username, 'gsfollow');

            } else if (line === 'OPEN_DOOR') {
                await handleChatCommand(username, 'gopendoor');

            } else if (line === 'DROP_ALL') {
                await handleChatCommand(username, 'gdump');

            } else if (line.startsWith('DROP ')) {
                const dropArgs = line.replace('DROP ', '').trim().split(' ');
                const dropItemName = dropArgs[0];
                const dropAmount = parseInt(dropArgs[1]) || 1;
                const allItems = bot.inventory.items();
                const idx = allItems.findIndex(i => i.name === dropItemName);
                if (idx !== -1) {
                    await handleChatCommand(username, `gdrop ${idx + 1} ${dropAmount}`);
                }

            } else if (line.startsWith('EAT ')) {
                const itemName = line.replace('EAT ', '').trim();
                const eatItems = bot.inventory.items();
                const idx = eatItems.findIndex(i => i.name === itemName);
                if (idx !== -1) {
                    await handleChatCommand(username, `geat ${idx + 1} 1`);
                }

            } else if (line.startsWith('JUMP ')) {
                const amount = parseInt(line.replace('JUMP ', '').trim()) || 1;
                await handleChatCommand(username, `gjump ${amount}`);

            } else if (line === 'WALK') {
                await handleChatCommand(username, 'gwalk');

            } else if (line.startsWith('CROUCH ')) {
                const raw = parseInt(line.replace('CROUCH ', '').trim()) || 1;
                const amount = Math.max(1, raw);
                await handleChatCommand(username, `gcr ${amount}`);
            }
        }

    } catch (err) {
        console.error('Groq error:', err);
        if (trigger === 'mentioned' || trigger === 'solo') bot.chat(PERSONALITY.messages.glitchVoice);
    }
}


const handleChatCommand = async (username: string, rawMessage: string) => {
    if (!bot || !bot.inventory) return;
    const args = rawMessage?.trim().split(' ') ?? [];
    const command = args.shift()?.toLowerCase();
    if (!command) return;

    const mcData = minecraftData(bot.version);

    switch (command) {
        case 'gping':
            bot.chat(`Pong! ${bot.player.ping}ms`);
            break;

        case 'gsleep': {
            if (currentState !== BotState.IDLE) {
                bot.chat(PERSONALITY.messages.busy);
                break;
            }
            const bed = bot.findBlock({
                matching: (block) => block?.name?.endsWith('_bed') && block.metadata === 0,
                maxDistance: 32
            });

            if (!bed) { bot.chat(PERSONALITY.messages.noBedNearby); break; }
            if (bot.entity.position.distanceTo(bed.position) > 12) { bot.chat(PERSONALITY.messages.bedTooFar); break; }

            setState(BotState.SLEEPING);
            try {
                bot.chat(PERSONALITY.messages.goingToSleep);
                bot.pathfinder.setMovements(getSafeMovements());
                try {
                    await bot.pathfinder.goto(new goals.GoalBlock(bed.position.x, bed.position.y, bed.position.z));
                } catch {
                    bot.chat(PERSONALITY.messages.cantReachBed);
                    setState(BotState.IDLE);
                    break;
                }
                await bot.sleep(bed);
            } catch (err: any) {
                const msg = err?.message?.toLowerCase?.() || "";
                if (msg.includes("day")) bot.chat(PERSONALITY.messages.notNight);
                else if (msg.includes("monster")) bot.chat(PERSONALITY.messages.monstersNearby);
                else if (msg.includes("obstructed")) bot.chat(PERSONALITY.messages.bedBlocked);
                else bot.chat(PERSONALITY.messages.cantSleep);
            } finally {
                bot.pathfinder.setGoal(null);
                setState(BotState.IDLE);
            }
            break;
        }

        case 'ghelp': {
            const helpMessages = [
                `Commands:`,
                `gping, ghelp, gsay, ginv, ginvsee, geat, gjump, gdrop, gwalk, gcr, gcords, gtp`,
                `gfollow <player>, gcraft <item>, gdump, gkill <mob|player>, glast, gsfollow`,
                `gcollect <wood|stone|dirt> <amount>, gsleep, gopendoor, gscollect`
            ];
            for (const line of helpMessages) {
                await sleep(getRandomDelay(500, 900));
                try { bot.chat(line); } catch (err) { console.error("Failed to send chat:", err); }
            }
            break;
        }

        case 'gopendoor': {
            const doorNames = [
                'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door',
                'dark_oak_door', 'mangrove_door', 'cherry_door', 'crimson_door', 'warped_door',
                'iron_door', 'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'jungle_trapdoor',
                'acacia_trapdoor', 'dark_oak_trapdoor', 'mangrove_trapdoor', 'iron_trapdoor'
            ];
            const door = bot.findBlock({
                matching: (block) => doorNames.includes(block.name),
                maxDistance: 16
            });
            if (!door) { bot.chat(PERSONALITY.messages.noDoorNearby); break; }
            try {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(door.position.x, door.position.y, door.position.z));
                const freshDoor = bot.blockAt(door.position);
                if (!freshDoor) break;
                if (freshDoor.getProperties()?.['open'] === 'true') { bot.chat(PERSONALITY.messages.doorAlreadyOpen); break; }
                await bot.activateBlock(freshDoor);
                bot.chat(PERSONALITY.messages.doorOpened);
            } catch { bot.chat(PERSONALITY.messages.cantReachDoor); }
            break;
        }

        case 'gsay':
            if (args.length === 0) bot.chat('Usage: gsay <message>');
            else bot.chat(args.join(' '));
            break;

        case 'ginv': {
            const items = bot.inventory.items();
            bot.chat(items.length === 0 ? PERSONALITY.messages.emptyInventory : `${items.length} items`);
            break;
        }

        case 'ginvsee': {
            const items = bot.inventory.items();
            if (!items || items.length === 0) { bot.chat(PERSONALITY.messages.emptyInventory); break; }
            bot.chat(items.map((item, index) => `${index + 1}. ${item.name ?? 'unknown'} x${item.count ?? 0}`).join(', '));
            break;
        }

        case 'geat': {
            if (currentState !== BotState.IDLE) { bot.chat(PERSONALITY.messages.busy); break; }

            // BUG FIX: use local variable instead of redeclaring outer `items`
            const eatItems = bot.inventory.items();

            if (args.length === 0) {
                if (eatItems.length === 0) { bot.chat(PERSONALITY.messages.noFood); break; }
                bot.chat(eatItems.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join(', '));
                bot.chat('Usage: geat <food_number> <amount>');
                break;
            }

            const foodIdx = parseInt(args[0], 10) - 1;
            const amount = Math.max(1, parseInt(args[1], 10) || 1);

            if (Number.isNaN(foodIdx) || foodIdx < 0 || foodIdx >= eatItems.length) {
                bot.chat(PERSONALITY.messages.invalidFoodNumber);
                break;
            }

            const food = eatItems[foodIdx];
            setState(BotState.EATING);
            let eaten = 0;

            try {
                await bot.equip(food, 'hand');
                for (let i = 0; i < amount && bot.food < 20; i++) {
                    await bot.consume();
                    eaten++;
                    await sleep(500);
                    if (bot.food === 20) { bot.chat(PERSONALITY.messages.fullStomach); break; }
                }
                bot.chat(`Ate ${eaten} ${food.name}`);
            } catch { bot.chat(PERSONALITY.messages.couldntEat); }
            finally { setState(BotState.IDLE); }
            break;
        }

        case 'gjump': {
            const jumpAmount = parseInt(args[0], 10) || 1;
            for (let i = 0; i < jumpAmount; i++) {
                bot.setControlState('jump', true);
                await sleep(500);
                bot.setControlState('jump', false);
                if (i < jumpAmount - 1) await sleep(250);
            }
            break;
        }

        case 'gdrop': {
            const dropItems = bot.inventory.items();
            if (args.length === 0) {
                if (dropItems.length === 0) { bot.chat(PERSONALITY.messages.nothingToDrop); break; }
                bot.chat(dropItems.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join(', '));
                bot.chat('Usage: gdrop <item_number> <amount>');
            } else {
                const itemIdx = parseInt(args[0], 10) - 1;
                const amount = parseInt(args[1], 10) || 1;
                if (isNaN(itemIdx) || itemIdx < 0 || itemIdx >= dropItems.length) {
                    bot.chat(PERSONALITY.messages.invalidItemNumber);
                    break;
                }
                const item = dropItems[itemIdx];
                if (amount > item.count) { 
                    const msg = PERSONALITY.messages.onlyHave.replace('{count}', String(item.count)).replace('{item}', item.name);
                    bot.chat(msg);
                    break;
                }
                const msg = PERSONALITY.messages.droppingItems.replace('{amount}', String(amount)).replace('{item}', item.name);
                bot.chat(msg);
                await bot.toss(item.type, null, Math.min(amount, item.count));
            }
            break;
        }

        case 'gwalk':
            bot.setControlState('forward', true);
            await sleep(500);
            bot.setControlState('forward', false);
            break;

        case 'gcr': {
            // BUG FIX: hold sneak for N seconds instead of toggling N times
            const sneakSeconds = Math.max(1, parseInt(args[0], 10) || 1);
            bot.setControlState('sneak', true);
            await sleep(sneakSeconds * 1000);
            bot.setControlState('sneak', false);
            break;
        }

        case 'gcords':
            bot.chat(`${bot.entity.position}`);
            break;

        case 'gtp': {
            const [x, y, z] = args;
            if (!x || !y || !z) { bot.chat('Usage: gtp <x> <y> <z>'); break; }
            const onMessage = (jsonMsg: any) => {
                const msg = jsonMsg.toString();
                if (
                    msg.includes("Unknown command") || msg.includes("no permission") ||
                    msg.includes("You do not have permission") || msg.includes("not a valid number") ||
                    msg.includes("cannot be found")
                ) {
                    bot.chat("No permission for /tp.");
                    bot.removeListener('message', onMessage);
                }
            };
            bot.once('message', onMessage);
            bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`);
            setTimeout(() => bot.removeListener('message', onMessage), 3000);
            break;
        }

        case 'gfollow': {
            let targetName = args[0];
            if (!targetName) { bot.chat('Usage: gfollow <player>'); break; }
            if (targetName.toLowerCase() === 'me') targetName = username;
            const playerEntity = bot.players[targetName]?.entity;
            if (!playerEntity) { 
                const msg = PERSONALITY.messages.cantSeePlayer.replace('{player}', targetName);
                bot.chat(msg); 
                break; 
            }
            setState(BotState.FOLLOWING);
            const msg = PERSONALITY.messages.followingPlayer.replace('{player}', targetName);
            bot.chat(msg);
            bot.pathfinder.setMovements(getSafeMovements());
            bot.pathfinder.setGoal(new GoalFollow(playerEntity, 1), true);
            break;
        }

        case 'gcraft': {
            const itemName = args[0];
            if (!itemName) { bot.chat('Usage: gcraft <item_name>'); break; }
            const item = mcData.itemsByName[itemName];
            if (!item) { 
                const msg = PERSONALITY.messages.unknownItem.replace('{item}', itemName);
                bot.chat(msg); 
                break; 
            }
            const recipe = bot.recipesFor(item.id, null, 1, null)[0];
            if (!recipe) { 
                const msg = PERSONALITY.messages.unknownItem.replace('{item}', itemName);
                bot.chat(msg); 
                break; 
            }
            let craftingTable = null;
            if (recipe.requiresTable) {
                const tableId = mcData.blocksByName.crafting_table.id;
                craftingTable = bot.findBlock({ matching: tableId, maxDistance: 6 });
                if (!craftingTable) { bot.chat(PERSONALITY.messages.noCraftingTable); break; }
            }
            try {
                await bot.craft(recipe, 1, craftingTable ?? undefined);
                const msg = PERSONALITY.messages.craftedItem.replace('{item}', itemName);
                bot.chat(msg);
            } catch (err: any) { 
                const msg = PERSONALITY.messages.craftFailed.replace('{error}', err.message);
                bot.chat(msg); 
            }
            break;
        }

        case 'gdump': {
            const dumpItems = bot.inventory.items();
            if (dumpItems.length === 0) { bot.chat(PERSONALITY.messages.nothingToDrop); break; }
            bot.chat(PERSONALITY.messages.droppingEverything);
            for (const item of dumpItems) {
                await bot.tossStack(item);
                await sleep(200);
            }
            break;
        }

        case 'gkill': {
            const killTarget = args[0]?.toLowerCase();
            if (!killTarget) { bot.chat('Usage: gkill <mob|player name>'); break; }

            function getBestWeapon() {
                const priorities = [
                    ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'],
                    ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
                ];
                for (const group of priorities) {
                    for (const name of group) {
                        const found = bot.inventory.items().find(i => i.name === name);
                        if (found) return found;
                    }
                }
                return null;
            }

            const playerEntry = Object.values(bot.players).find(p => p.username?.toLowerCase() === killTarget);
            const killPlayerEntity = playerEntry?.entity;

            if (killPlayerEntity) {
                const msg = PERSONALITY.messages.attackingPlayer.replace('{player}', playerEntry!.username);
                bot.chat(msg);
                const weapon = getBestWeapon();
                if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand');
                bot.pathfinder.setGoal(new goals.GoalFollow(killPlayerEntity, 1), true);
                const attackInterval = setInterval(() => {
                    const stillExists = bot.players[playerEntry!.username]?.entity;
                    if (!stillExists) {
                        clearInterval(attackInterval);
                        intervals.splice(intervals.indexOf(attackInterval), 1);
                        bot.pathfinder.setGoal(null);
                        const leavMsg = PERSONALITY.messages.playerGone.replace('{player}', playerEntry!.username);
                        bot.chat(leavMsg);
                        return;
                    }
                    bot.attack(stillExists);
                }, 500);
                intervals.push(attackInterval);
                break;
            }

            if (playerEntry && !killPlayerEntity) {
                const msg = PERSONALITY.messages.cantSeePlayer.replace('{player}', playerEntry.username);
                bot.chat(msg);
                break;
            }

            const mobEntity = Object.values(bot.entities).find(e =>
                e.type === 'mob' &&
                e.name?.toLowerCase() === killTarget &&
                HOSTILE_MOBS.has(e.name?.toLowerCase() ?? '')
            );

            if (mobEntity) {
                const msg = PERSONALITY.messages.attackingMob.replace('{mob}', killTarget);
                bot.chat(msg);
                const weapon = getBestWeapon();
                if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand');
                bot.pathfinder.setGoal(new goals.GoalFollow(mobEntity, 1), true);
                const attackInterval = setInterval(() => {
                    const stillExists = bot.entities[mobEntity.id];
                    if (!stillExists) {
                        clearInterval(attackInterval);
                        intervals.splice(intervals.indexOf(attackInterval), 1);
                        bot.pathfinder.setGoal(null);
                        const deadMsg = PERSONALITY.messages.mobDead.replace('{mob}', killTarget);
                        bot.chat(deadMsg);
                        return;
                    }
                    bot.attack(stillExists);
                }, 500);
                intervals.push(attackInterval);
                break;
            }

            const msg = PERSONALITY.messages.cantFindTarget.replace('{target}', killTarget);
            bot.chat(msg);
            break;
        }

        case 'glast':
            bot.chat(lastPlayerJoined ? PERSONALITY.messages.lastPlayerJoined.replace('{player}', lastPlayerJoined) : PERSONALITY.messages.nobodyJoined);
            break;

        case 'gsfollow':
            if (currentState === BotState.FOLLOWING) {
                setState(BotState.IDLE);
                bot.chat(PERSONALITY.messages.stoppedFollowing);
            } else {
                bot.chat(PERSONALITY.messages.notFollowing);
            }
            break;

        case 'gscollect':
            if (!collecting) { bot.chat(PERSONALITY.messages.notCollecting); break; }
            collecting = false;
            // BUG FIX: always reset state on manual stop
            setState(BotState.IDLE);
            const summary = Object.entries(collectedSummary)
                .map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`)
                .join(', ');
            const msg = PERSONALITY.messages.stoppedCollecting.replace('{collected}', summary || 'nothing');
            bot.chat(msg);
            collectedSummary = {};
            break;

        case 'gcollect': {
            const resourceGroups: { [key: string]: string[] } = {
                wood: [
                    'oak_log', 'acacia_log', 'birch_log', 'dark_oak_log', 'jungle_log', 'mangrove_log', 'spruce_log',
                    'oak_wood', 'acacia_wood', 'birch_wood', 'dark_oak_wood', 'jungle_wood', 'mangrove_wood', 'spruce_wood'
                ],
                stone: ['stone', 'cobblestone'],
                dirt: ['dirt']
            };

            const resourceType = args[0]?.toLowerCase();
            const amount = Math.max(1, parseInt(args[1], 10) || 2);

            if (!resourceType || !resourceGroups[resourceType]) {
                bot.chat('Usage: gcollect <wood|stone|dirt> <amount>');
                break;
            }

            const resourceTypes = resourceGroups[resourceType];

            function getBestTool(blockName: string) {
                const block = mcData.blocksByName[blockName];
                if (!block || !block.harvestTools) return null;
                let bestTool = null;
                let bestTier = -1;
                for (const item of bot.inventory.items()) {
                    if (!item.name) continue;
                    const tool = mcData.itemsByName[item.name];
                    if (!tool) continue;
                    if (block.harvestTools[tool.id]) {
                        const tier = ['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden'].findIndex(t => item.name.includes(t));
                        if (tier > bestTier) { bestTier = tier; bestTool = item; }
                    }
                }
                return bestTool;
            }

            async function mineBlock(blockName: string, amountToMine = 1) {
                let collected = 0;
                const blockId = mcData.blocksByName[blockName]?.id;
                if (!blockId) return 0;

                while (collected < amountToMine && collecting) {
                    let block = bot.findBlock({ matching: blockId, maxDistance: 16 });
                    if (!block) block = bot.findBlock({ matching: blockId, maxDistance: 32 });
                    if (!block) break;

                    const tool = getBestTool(blockName);
                    if (tool) await bot.equip(tool, 'hand');

                    try {
                        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
                    } catch { break; }

                    const freshBlock = bot.blockAt(block.position);
                    if (!freshBlock || freshBlock.name !== blockName) continue;

                    try { await bot.dig(freshBlock); } catch { continue; }

                    collected++;
                    collectedSummary[blockName] = (collectedSummary[blockName] ?? 0) + 1;
                    await sleep(800);
                }
                return collected;
            }

            if (currentState !== BotState.IDLE) { bot.chat(PERSONALITY.messages.busy); break; }

            setState(BotState.COLLECTING);
            collecting = true;
            collectedSummary = {};
            const collectMsg = PERSONALITY.messages.collectingResource.replace('{amount}', String(amount)).replace('{resource}', resourceType);
            bot.chat(collectMsg);

            let totalCollected = 0;
            let remaining = amount;

            for (const type of resourceTypes) {
                if (remaining <= 0 || !collecting) break;
                const collected = await mineBlock(type, remaining);
                if (collected > 0) {
                    totalCollected += collected;
                    remaining -= collected;
                }
            }

            // BUG FIX: always reset state after collection ends (even if stopped via gscollect)
            if ((currentState as BotState) === BotState.COLLECTING) {
                if (totalCollected === 0) {
                    const notFoundMsg = PERSONALITY.messages.couldntFindResource.replace('{resource}', resourceType);
                    bot.chat(notFoundMsg);
                } else {
                    const gotMsg = PERSONALITY.messages.gotResource.replace('{amount}', String(totalCollected)).replace('{resource}', resourceType);
                    bot.chat(gotMsg);
                }
                collecting = false;
                collectedSummary = {};
                setState(BotState.IDLE);
            }
            break;
        }

        default:
            if (username === 'Shell') console.log(`[Shell] Unknown command: ${command}`);
    }
};


export const createBot = (
    config: { ip: string; port: number; username: string },
    rl: readline.Interface
): void => {
    currentConfig = config;
    rlInstance = rl;
    bot = Mineflayer.createBot({
        host: config.ip,
        port: config.port,
        username: config.username,
    } as any);

    bot.loadPlugin(pathfinder);
    startCommandLine(bot, rl);

    bot.on('error', (err) => console.error('Bot network error:', err));

    bot.on('end', (reason) => {
        console.log('Connection ended:', reason);
        reconnect();
    });

    bot.on('kicked', (reason, loggedIn) => {
        console.error('Kicked. Reason:', reason, '| Logged in:', loggedIn);
    });

    bot.on('entityHurt', (entity) => {
        if (!bot?.entity || entity !== bot.entity) return;
        // BUG FIX: skip if bot is dead
        if (bot.health <= 0) return;

        const now = Date.now();
        if (now - lastHurtMessageTime < 3000) return;
        lastHurtMessageTime = now;

        const nearby = Object.values(bot.entities ?? {}).find(e =>
            e.position?.distanceTo(bot.entity.position) < 4 && e.type === 'mob'
        );
        if (nearby?.name) {
            const msg = PERSONALITY.messages.hurt[0].replace('{mob}', nearby.name);
            bot.chat(msg);
        } else {
            bot.chat(getRandom(PERSONALITY.messages.hurt));
        }
    });

    bot.on('chat', async (username, message) => {
        if (!bot || username === bot.username) return;
        console.log(`[CHAT] <${username}> ${message}`);

        // Always check for commands first
        try { await handleChatCommand(username, message); } catch (e) { console.error("Command error:", e); }

        const botName = bot.username.toLowerCase();
        const msgLower = message.toLowerCase();

        // Solo mode: if only one other player is online, respond to everything
        if (getOtherPlayerCount() === 1) {
            // Don't double-respond if name was mentioned (handled below)
            if (!msgLower.includes(botName)) {
                // BUG FIX: don't chime if bot is busy
                if (currentState === BotState.IDLE || currentState === BotState.FOLLOWING) {
                    await handleAIResponse(username, message, 'solo');
                }
                return;
            }
        }

        // Respond if bot's name is mentioned
        if (msgLower.includes(botName)) {
            await handleAIResponse(username, message, 'mentioned');
            return;
        }

        // Random chime into multi-player conversations
        // BUG FIX: only chime when idle
        if (currentState !== BotState.IDLE) return;
        const chimeNow = Date.now();
        const shouldChime = Math.random() < 0.08 && (chimeNow - lastChimeTime > 2 * 60 * 1000);
        if (shouldChime) {
            lastChimeTime = chimeNow;
            await handleAIResponse(username, message, 'chime');
        }
    });

    const onlineBeforeSpawn = new Set<string>();

    bot.once('spawn', async () => {
        reconnectAttempts = 0;
        reconnecting = false;
        if (!bot?.entity) return;
        console.log(`Logged in as ${bot.username}`);
        console.log(`[AI Status] ${AI_ENABLED ? '✓ AI Features ENABLED' : '✗ AI Features DISABLED (basic commands only)'}`);
        bot.pathfinder.setMovements(getSafeMovements());

        for (const name of Object.keys(bot.players)) onlineBeforeSpawn.add(name);
        await sleep(1000);
        for (const name of Object.keys(bot.players)) onlineBeforeSpawn.add(name);

        // Water escape interval
        intervals.push(setInterval(() => {
            if (!bot.entity) return;
            const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (headBlock?.name?.includes('water')) bot.chat(getRandom(PERSONALITY.messages.waterHelp));
        }, 2000));

        // Water swim-out interval
        intervals.push(setInterval(() => {
            if (!bot.entity?.position || currentState !== BotState.IDLE) return;
            const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            const feetBlock = bot.blockAt(bot.entity.position.offset(0, 0, 0));
            const isInWater = headBlock?.name?.includes("water") || feetBlock?.name?.includes("water");
            if (isInWater) {
                bot.setControlState("jump", true);
                bot.setControlState("forward", true);
                const ground = bot.findBlock({
                    matching: (block) => !!(block?.name && !block.name.includes("water") && block.boundingBox === "block"),
                    maxDistance: 20
                });
                if (ground) bot.lookAt(ground.position.offset(0.5, 0.5, 0.5));
            } else {
                bot.setControlState("jump", false);
                bot.setControlState("forward", false);
            }
        }, 1000));

        // Idle wander interval
        const changePos = async (): Promise<void> => {
            if (!bot?.entity) return;
            const lastAction = getRandom(CONFIG.action.commands) as Mineflayer.ControlState;
            const halfChance = Math.random() < 0.5;

            if (lastAction === 'forward' || lastAction === 'jump') {
                const pos = bot.entity.position;
                const nextPos = pos.offset(-Math.sin(bot.entity.yaw) * 1, 0, Math.cos(bot.entity.yaw) * 1);
                const blockBelow = bot.blockAt(nextPos.offset(0, -1, 0));
                const blockAtNext = bot.blockAt(nextPos);
                const blockBelowY = blockBelow ? blockBelow.position.y : null;
                const currY = Math.floor(pos.y);

                if (
                    (!blockAtNext || blockAtNext.boundingBox === 'empty') &&
                    blockBelowY !== null && currY - blockBelowY > 1
                ) {
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (dx === 0 && dz === 0) continue;
                            const testPos = pos.offset(dx, 0, dz);
                            const testBlockBelow = bot.blockAt(testPos.offset(0, -1, 0));
                            const testBlockAt = bot.blockAt(testPos);
                            const testBlockBelowY = testBlockBelow ? testBlockBelow.position.y : null;
                            if (
                                (!testBlockAt || testBlockAt.boundingBox === 'empty') &&
                                testBlockBelowY !== null && currY - testBlockBelowY <= 1
                            ) {
                                try {
                                    await bot.pathfinder.goto(new goals.GoalBlock(
                                        Math.floor(testPos.x), Math.floor(testBlockBelowY + 1), Math.floor(testPos.z)
                                    ));
                                } catch (e) { console.error("Error moving to safe block:", e); }
                                return;
                            }
                        }
                    }
                    return;
                }
            }

            bot.setControlState('sprint', halfChance);
            bot.setControlState(lastAction, true);
            await sleep(CONFIG.action.holdDuration);
            clearAllControls(bot);
        };

        const changeView = async (): Promise<void> => {
            if (!bot) return;
            const yaw = (Math.random() * Math.PI) - (0.5 * Math.PI);
            const pitch = (Math.random() * Math.PI) - (0.5 * Math.PI);
            try { await bot.look(yaw, pitch, false); } catch (e) { console.error("Error changing view:", e); }
        };

        intervals.push(setInterval(() => {
            if (!bot?.entity || currentState !== BotState.IDLE) return;
            changeView();
            changePos();
        }, CONFIG.action.holdDuration));
    });

    bot.on('playerJoined', (player) => {
        if (!player?.username || player.username === bot.username) return;
        if (onlineBeforeSpawn.has(player.username)) {
            onlineBeforeSpawn.delete(player.username);
            return;
        }
        lastPlayerJoined = player.username;
        const messages = PERSONALITY.messages.playerJoined.map(msg => msg.replace('{player}', player.username));
        setTimeout(() => bot.chat(getRandom(messages)), 1000);
    });

    // BUG FIX: clean up conversation history when player leaves
    bot.on('playerLeft', (player) => {
        if (player?.username && conversationHistory[player.username]) {
            delete conversationHistory[player.username];
        }
    });

    bot.on('entityMoved', (entity) => {
        if (!bot?.entity) return;
        if (!entity || entity.type !== 'mob' || !entity.position) return;
        if (currentState === BotState.FLEEING) return;
        // BUG FIX: don't flee if already dead
        if (bot.health <= 0) return;

        const now = Date.now();
        if (now - lastFleeTime < 3000) return;

        const mobName = entity.name?.toLowerCase();
        if (!mobName || !HOSTILE_MOBS.has(mobName)) return;

        const distance = bot.entity.position.distanceTo(entity.position);
        if (distance >= 6) return;

        lastFleeTime = now;
        setState(BotState.FLEEING);

        const botPos = bot.entity.position;
        const mobPos = entity.position;
        const dx = botPos.x - mobPos.x;
        const dz = botPos.z - mobPos.z;
        const length = Math.sqrt(dx * dx + dz * dz) || 1;
        const runX = botPos.x + (dx / length) * 8;
        const runZ = botPos.z + (dz / length) * 8;
        let runY = botPos.y;

        for (let y = Math.floor(botPos.y); y > 0; y--) {
            const block = bot.blockAt(new Vec3(runX, y, runZ));
            if (block && block.boundingBox === 'block') { runY = y + 1; break; }
        }

        try {
            const msg = PERSONALITY.messages.mobThreat.replace('{mob}', mobName);
            bot.chat(msg);
            bot.pathfinder.setMovements(getSafeMovements());
            bot.pathfinder.setGoal(new goals.GoalBlock(Math.round(runX), Math.round(runY), Math.round(runZ)));
        } catch (e) { console.error("Error fleeing:", e); }

        setTimeout(() => {
            if (currentState === BotState.FLEEING) setState(BotState.IDLE);
        }, 5000);
    });

    bot.once('login', () => {
        console.log(`Bot logged in as ${bot.username} on version ${bot.version}\n`);
        bot.setMaxListeners(35);
        if (AI_ENABLED) {
            setTimeout(() => bot.chat(PERSONALITY.messages.login), 500);
        }
    });
};