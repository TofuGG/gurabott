"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBot = void 0;
const mineflayer_1 = __importDefault(require("mineflayer"));
const mineflayer_pathfinder_1 = __importDefault(require("mineflayer-pathfinder"));
const utils_ts_1 = require("./utils.ts");
const config_json_1 = __importDefault(require("../config.json"));
const minecraft_data_1 = __importDefault(require("minecraft-data"));
const vec3_1 = require("vec3");
const { pathfinder, Movements, goals } = mineflayer_pathfinder_1.default;
const { GoalFollow } = goals;
let bot;
let lastPlayerJoined = null;
let loop;
let currentConfig = null;
let rlInstance = null;
let collecting = false;
let collectedSummary = {};
let intervals = [];
var BotState;
(function (BotState) {
    BotState["IDLE"] = "idle";
    BotState["FOLLOWING"] = "following";
    BotState["COLLECTING"] = "collecting";
    BotState["FLEEING"] = "fleeing";
    BotState["EATING"] = "eating";
    BotState["SLEEPING"] = "sleeping";
})(BotState || (BotState = {}));
let currentState = BotState.IDLE;
function setState(newState) {
    if (currentState === newState)
        return;
    console.log(`[STATE] ${currentState} → ${newState}`);
    currentState = newState;
    // Stop any current movement when switching tasks
    try {
        bot.pathfinder?.setGoal(null);
        clearAllControls(bot);
    }
    catch { }
}
const disconnect = () => {
    for (const i of intervals)
        clearInterval(i);
    intervals = [];
    bot?.removeAllListeners();
    bot?.quit();
};
let reconnectAttempts = 0;
let reconnecting = false;
async function reconnect() {
    if (reconnecting)
        return;
    reconnecting = true;
    if (reconnectAttempts >= 5) {
        console.log("Too many reconnect attempts. Stopping.");
        return;
    }
    reconnectAttempts++;
    console.log(`Reconnecting (${reconnectAttempts}/5) in ${config_json_1.default.action.retryDelay / 1000}s...`);
    disconnect();
    await (0, utils_ts_1.sleep)(config_json_1.default.action.retryDelay);
    if (currentConfig && rlInstance) {
        (0, exports.createBot)(currentConfig, rlInstance);
    }
    reconnecting = false;
}
function startCommandLine(bot, rl) {
    rl.on('line', (line) => {
        const [cmd, ...args] = line.trim().split(/\s+/);
        if (cmd === 'gsay') {
            const msg = args.join(' ');
            bot.chat(msg);
        }
    });
}
function handleCommand(line, bot) {
    const items = bot.inventory.items();
}
function clearAllControls(bot) {
    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    for (const c of controls)
        bot.setControlState(c, false);
}
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
const handleChatCommand = async (username, rawMessage) => {
    if (!bot || !bot.inventory)
        return;
    const items = bot.inventory.items?.() ?? [];
    const args = rawMessage?.trim().split(' ') ?? [];
    const command = args.shift()?.toLowerCase();
    if (!command)
        return;
    switch (command) {
        case 'gping':
            bot.chat(`Pong! ${bot.player.ping}ms`);
            break;
        case 'gsleep': {
            if (currentState !== BotState.IDLE) {
                bot.chat("I'm busy right now!");
                break;
            }
            const mcData = (0, minecraft_data_1.default)(bot.version);
            // Find the head of the bed
            const bed = bot.findBlock({
                matching: (block) => {
                    return block?.name?.endsWith('_bed') && block.metadata === 0; // metadata 0 = head in most versions
                },
                maxDistance: 32
            });
            if (!bed) {
                bot.chat("I can't see any bed.");
                break;
            }
            const distance = bot.entity.position.distanceTo(bed.position);
            if (distance > 12) {
                bot.chat("The bed is too far away.");
                break;
            }
            setState(BotState.SLEEPING);
            try {
                bot.chat("I am going to sleep. Goodnight 🌙");
                bot.pathfinder.setMovements(new Movements(bot));
                bot.pathfinder.setGoal(new goals.GoalBlock(bed.position.x, bed.position.y, bed.position.z));
                await (0, utils_ts_1.sleep)(1500);
                await bot.sleep(bed);
            }
            catch (err) {
                const msg = err?.message?.toLowerCase?.() || "";
                if (msg.includes("day")) {
                    bot.chat("It's not night, I can't sleep now.");
                }
                else if (msg.includes("monster")) {
                    bot.chat("I feel scared to sleep when monsters are nearby.");
                }
                else if (msg.includes("obstructed")) {
                    bot.chat("The bed is blocked.");
                }
                else {
                    bot.chat("I couldn't sleep.");
                }
            }
            finally {
                bot.pathfinder.setGoal(null);
                setState(BotState.IDLE);
            }
            break;
        }
        case 'ghelp':
            const helpMessages = [
                `Chat commands:`,
                `>>gping: responds with the bot's ping.`,
                `>>ghelp: displays a list of available commands.`,
                `>>gsay: repeats a message sent by the user.`,
                `>>ginv: displays the bot's inventory.`,
                `>>ginvsee: shows inventory item names and counts.`,
                `>>geat: makes the bot eat food.`,
                `>>gjump: makes the bot jump.`,
                `>>gdrop: makes the bot drop an item.`,
                `>>gwalk: makes the bot walk forward.`,
                `>>gcr: makes the bot crouch and uncrouch.`,
                `>>gcords: shows the bot's coordinates.`,
                `>>gtp: teleport to a location if permitted.`,
                `>>gfollow <player>: follow a player.`,
                `>>gcraft <item_name>: craft an item if recipe exists.`,
                `>>gdump: drop all items from inventory.`,
                `>>gkill <mob|player name>: attack a nearby hostile mob or player using the best axe (if available), else best sword, else hand.`,
                `>>glast: show the last player who joined.`,
                `>>gsfollow: stop following the current player.`,
                `>>gcollect <wood|stone|dirt> <amount>: collect a specific amount of the given resource type using the best tool available.`,
                `>>gsleep: make the bot sleep in a nearby bed.`,
            ];
            for (const line of helpMessages) {
                await (0, utils_ts_1.sleep)(getRandomDelay(700, 1200));
                try {
                    bot.chat(line);
                }
                catch (err) {
                    console.error("Failed to send chat:", err);
                }
            }
            break;
        case 'gsay':
            if (args.length === 0) {
                bot.chat('Usage: gsay <message>');
            }
            else {
                bot.chat(args.join(' '));
            }
            break;
        case 'ginv':
            bot.chat(items.length === 0 ? 'I have nothing' : `I have ${items.length} items`);
            break;
        case 'ginvsee':
            if (!items || items.length === 0) {
                bot.chat('I have nothing');
            }
            else {
                const output = items.map((item, index) => `${index + 1}. ${item.name ?? 'unknown'} x${item.count ?? 0}`).join('\n');
                bot.chat(output);
            }
            break;
        case 'geat': {
            if (currentState !== BotState.IDLE) {
                bot.chat("I'm busy right now!");
                break;
            }
            const items = bot.inventory.items();
            if (args.length === 0) {
                if (items.length === 0) {
                    bot.chat("I don't have any food to eat!");
                }
                else {
                    const foodList = items
                        .map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`)
                        .join('\n');
                    bot.chat(foodList);
                    bot.chat('Usage: geat <food_number> <amount>');
                }
                break;
            }
            const foodIdx = parseInt(args[0], 10) - 1; // user sees 1-based
            const amount = Math.max(1, parseInt(args[1], 10) || 1);
            if (Number.isNaN(foodIdx) || foodIdx < 0 || foodIdx >= items.length) {
                bot.chat('Invalid food number. Usage: geat <food_number> <amount>');
                break;
            }
            const food = items[foodIdx];
            setState(BotState.EATING);
            let eaten = 0;
            try {
                await bot.equip(food, 'hand');
                for (let i = 0; i < amount && bot.food < 20; i++) {
                    await bot.consume();
                    eaten++;
                    await (0, utils_ts_1.sleep)(500);
                    if (bot.food === 20) {
                        bot.chat("Now I'm full!");
                        break;
                    }
                }
                bot.chat(`Ate ${eaten} ${food.name}`);
            }
            catch (err) {
                bot.chat("I couldn't eat that food.");
            }
            finally {
                setState(BotState.IDLE);
            }
            break;
        }
        case 'gjump':
            const jumpAmount = parseInt(args[0], 10) || 1;
            for (let i = 0; i < jumpAmount; i++) {
                bot.setControlState('jump', true);
                await (0, utils_ts_1.sleep)(500);
                bot.setControlState('jump', false);
                if (i < jumpAmount - 1)
                    await (0, utils_ts_1.sleep)(250);
            }
            break;
        case 'gdrop':
            if (args.length === 0) {
                if (items.length === 0) {
                    bot.chat("I don't have any items to drop!");
                }
                else {
                    const itemList = items.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join('\n');
                    bot.chat(itemList);
                    bot.chat('Usage: gdrop <item_number> <amount>');
                }
            }
            else {
                const itemIdx = parseInt(args[0], 10) - 1;
                const amount = parseInt(args[1], 10) || 1;
                if (isNaN(itemIdx) || itemIdx < 0 || itemIdx >= items.length) {
                    bot.chat('Invalid item number. Usage: gdrop <item_number> <amount>');
                    break;
                }
                const item = items[itemIdx];
                if (amount > item.count) {
                    bot.chat(`I only have ${item.count} of ${item.name}.`);
                    break;
                }
                bot.chat(`Dropping ${amount} ${item.name}`);
                for (let i = 0; i < amount; i++) {
                    await bot.toss(item.type, null, Math.min(amount, item.count));
                    await (0, utils_ts_1.sleep)(200);
                }
            }
            break;
        case 'gwalk':
            bot.setControlState('forward', true);
            await (0, utils_ts_1.sleep)(500);
            bot.setControlState('forward', false);
            break;
        case 'gcr':
            const sneakAmount = parseInt(args[0], 10) || 1;
            for (let i = 0; i < sneakAmount; i++) {
                bot.setControlState('sneak', true);
                await (0, utils_ts_1.sleep)(500);
                bot.setControlState('sneak', false);
                if (i < sneakAmount - 1)
                    await (0, utils_ts_1.sleep)(500);
            }
            break;
        case 'gcords':
            bot.chat(`My coords are ${bot.entity.position}`);
            break;
        case 'gtp':
            const [x, y, z] = args;
            if (!x || !y || !z) {
                bot.chat('Usage: gtp <x> <y> <z>');
                break;
            }
            const tpCommand = `/tp ${bot.username} ${x} ${y} ${z}`;
            const onMessage = (jsonMsg) => {
                const msg = jsonMsg.toString();
                if (msg.includes("Unknown command") ||
                    msg.includes("You do not have permission") ||
                    msg.includes("no permission") ||
                    msg.includes("not a valid number") ||
                    msg.includes("cannot be found")) {
                    bot.chat("I don't have permission to use /tp.");
                    bot.removeListener('message', onMessage);
                }
            };
            bot.on('message', onMessage);
            // send command
            bot.chat(tpCommand);
            // auto cleanup
            setTimeout(() => {
                bot.removeListener('message', onMessage);
            }, 3000);
            break;
        case 'gfollow':
            let targetName = args[0];
            if (!targetName) {
                await bot.chat('Usage: gfollow <player>/me');
                break;
            }
            if (targetName.toLowerCase() === 'me') {
                targetName = username;
            }
            const playerEntity = bot.players[targetName]?.entity;
            if (!playerEntity) {
                await bot.chat(`I can't see ${targetName}`);
                break;
            }
            setState(BotState.FOLLOWING);
            await bot.chat(`Following ${targetName}`);
            bot.pathfinder.setMovements(new Movements(bot));
            bot.pathfinder.setGoal(new GoalFollow(playerEntity, 1), true);
            break;
        case 'gcraft': {
            const itemName = args[0];
            if (!itemName) {
                bot.chat('Usage: gcraft <item_name>');
                break;
            }
            let mcData;
            try {
                mcData = (0, minecraft_data_1.default)(bot.version);
            }
            catch (e) {
                bot.chat("Failed to load Minecraft data.");
                break;
            }
            const item = mcData.itemsByName[itemName];
            if (!item) {
                bot.chat(`Unknown item: ${itemName}`);
                break;
            }
            const recipe = bot.recipesFor(item.id, null, 1, null)[0];
            if (!recipe) {
                bot.chat(`No recipe for ${itemName}`);
                break;
            }
            let craftingTable = null;
            if (recipe.requiresTable) {
                const tableId = mcData.blocksByName.crafting_table.id;
                craftingTable = bot.findBlock({
                    matching: tableId,
                    maxDistance: 6
                });
                if (!craftingTable) {
                    bot.chat(`Need a crafting table nearby to craft ${itemName}.`);
                    break;
                }
            }
            try {
                await bot.craft(recipe, 1, craftingTable ?? undefined);
                bot.chat(`Successfully crafted ${itemName}!`);
            }
            catch (err) {
                bot.chat(`Failed to craft ${itemName}: ${err.message}`);
            }
            break;
        }
        case 'gdump':
            if (items.length === 0) {
                bot.chat('I have nothing to drop!');
            }
            else {
                bot.chat(`Dropping all items...`);
                for (const item of items) {
                    await bot.tossStack(item);
                    await (0, utils_ts_1.sleep)(200);
                }
            }
            break;
        case 'gkill': {
            const targetName = args[0]?.toLowerCase();
            if (!targetName) {
                bot.chat('Usage: gkill <mob|player name>');
                break;
            }
            let mcData;
            try {
                mcData = (0, minecraft_data_1.default)(bot.version);
            }
            catch (e) {
                bot.chat("Failed to load Minecraft data.");
                break;
            }
            function getBestWeapon() {
                const priorities = [
                    ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'],
                    ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
                ];
                for (const group of priorities) {
                    for (const name of group) {
                        const item = bot.inventory.items().find(i => i.name === name);
                        if (item)
                            return item;
                    }
                }
                return null;
            }
            const playerEntry = Object.values(bot.players).find(p => p.username?.toLowerCase() === targetName);
            const playerEntity = playerEntry?.entity;
            if (playerEntity) {
                bot.chat(`Attacking player ${playerEntry.username}!`);
                const weapon = getBestWeapon();
                if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name))
                    await bot.equip(weapon, 'hand');
                bot.pathfinder.setGoal(new goals.GoalFollow(playerEntity, 1), true);
                bot.attack(playerEntity);
                break;
            }
            if (playerEntry && !playerEntity) {
                bot.chat(`I see player "${playerEntry.username}" in the world, but can't reach them right now.`);
                break;
            }
            // Try to find a hostile mob nearby
            const hostileMobs = [
                "zombie", "creeper", "skeleton", "spider", "enderman", "witch", "slime", "drowned", "husk", "stray",
                "phantom", "pillager", "vindicator", "evoker", "ravager", "illusioner", "blaze", "magma_cube", "ghast",
                "wither_skeleton", "piglin", "piglin_brute", "zombified_piglin", "hoglin", "zoglin", "warden", "shulker",
                "silverfish", "endermite", "guardian", "elder_guardian", "vex"
            ];
            const mobEntity = Object.values(bot.entities).find(e => e.type === 'mob' &&
                e.name?.toLowerCase() === targetName &&
                hostileMobs.includes(e.name?.toLowerCase()));
            if (mobEntity) {
                bot.chat(`Attacking mob ${targetName}!`);
                const weapon = getBestWeapon();
                if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name))
                    await bot.equip(weapon, 'hand');
                bot.pathfinder.setGoal(new goals.GoalFollow(mobEntity, 1), true);
                bot.attack(mobEntity);
                break;
            }
            bot.chat(`Could not find player or hostile mob named "${targetName}" nearby.`);
            break;
        }
        case 'glast':
            if (lastPlayerJoined) {
                bot.chat(`Last player joined: ${lastPlayerJoined}`);
            }
            else {
                bot.chat(`No one has joined since I started.`);
            }
            break;
        case 'gsfollow':
            if (currentState === BotState.FOLLOWING) {
                setState(BotState.IDLE);
                bot.chat("Stopped following.");
            }
            else {
                bot.chat(`<Not following anyone>`);
            }
            break;
        case 'gscollect':
            if (!collecting) {
                bot.chat("I'm not collecting anything right now.");
                break;
            }
            collecting = false;
            // Report what was collected so far
            const summary = Object.entries(collectedSummary)
                .map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`)
                .join(', ');
            bot.chat(`Stopped collecting. Collected: ${summary || 'nothing'}.`);
            collectedSummary = {};
            break;
        case 'gcollect': {
            let mcData;
            try {
                mcData = (0, minecraft_data_1.default)(bot.version);
            }
            catch (e) {
                bot.chat("Failed to load Minecraft data.");
                break;
            }
            const resourceGroups = {
                wood: [
                    'oak_log', 'acacia_log', 'birch_log', 'dark_oak_log', 'jungle_log', 'mangrove_log', 'spruce_log',
                    'oak_wood', 'acacia_wood', 'birch_wood', 'dark_oak_wood', 'jungle_wood', 'mangrove_wood', 'spruce_wood'
                ],
                stone: [
                    'stone', 'cobblestone'
                ],
                dirt: [
                    'dirt'
                ]
            };
            const resourceType = args[0]?.toLowerCase();
            const amount = Math.max(1, parseInt(args[1], 10) || 2);
            if (!resourceType || !resourceGroups[resourceType]) {
                bot.chat('Usage: gcollect <wood|stone|dirt> <amount>');
                break;
            }
            const resourceTypes = resourceGroups[resourceType];
            function getBestTool(blockName) {
                const block = mcData.blocksByName[blockName];
                if (!block || !block.harvestTools)
                    return null;
                let bestTool = null;
                let bestTier = -1;
                for (const item of bot.inventory.items()) {
                    if (!item.name)
                        continue;
                    const tool = mcData.itemsByName[item.name];
                    if (!tool)
                        continue;
                    if (block.harvestTools[tool.id]) {
                        const tier = ['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden'].findIndex(t => item.name.includes(t));
                        if (tier > bestTier) {
                            bestTier = tier;
                            bestTool = item;
                        }
                    }
                }
                return bestTool;
            }
            async function mineBlock(blockName, amountToMine = 1) {
                let collected = 0;
                const blockId = mcData.blocksByName[blockName]?.id;
                if (!blockId)
                    return 0;
                while (collected < amountToMine && collecting) {
                    const block = bot.findBlock({
                        matching: blockId,
                        maxDistance: 32
                    });
                    if (!block)
                        break;
                    const tool = getBestTool(blockName);
                    if (tool)
                        await bot.equip(tool, 'hand');
                    await bot.pathfinder.goto(new goals.GoalBlock(block.position.x, block.position.y, block.position.z));
                    await bot.dig(block);
                    collected++;
                    collectedSummary[blockName] =
                        (collectedSummary[blockName] ?? 0) + 1;
                }
                return collected;
            }
            if (currentState !== BotState.IDLE) {
                bot.chat("I'm busy right now!");
                break;
            }
            setState(BotState.COLLECTING);
            collecting = true;
            collectedSummary = {};
            bot.chat(`Collecting ${amount} ${resourceType}...`);
            let totalCollected = 0;
            let remaining = amount;
            for (const type of resourceTypes) {
                if (remaining <= 0 || !collecting)
                    break;
                const collected = await mineBlock(type, remaining);
                if (collected > 0) {
                    bot.chat(`Collected ${collected} ${type.replace(/_/g, ' ')}`);
                    totalCollected += collected;
                    remaining -= collected;
                }
            }
            if (collecting) {
                if (totalCollected === 0) {
                    bot.chat(`Couldn't find any ${resourceType} nearby.`);
                }
                else {
                    bot.chat(`Finished collecting ${totalCollected} ${resourceType}.`);
                }
                collecting = false;
                collectedSummary = {};
                setState(BotState.IDLE);
            }
            break;
        }
        default:
            if (username === 'Shell') {
                console.log(`[Shell] Unknown command: ${command}`);
            }
    }
};
const createBot = (config, rl) => {
    currentConfig = config;
    rlInstance = rl;
    bot = mineflayer_1.default.createBot({
        host: config.ip,
        port: config.port,
        username: config.username,
        version: config.version
    });
    bot.loadPlugin(pathfinder);
    startCommandLine(bot, rl);
    bot.on('error', (err) => {
        console.error('Gura network error:', err);
    });
    bot.on('end', (reason) => {
        console.log('Connection ended:', reason);
        reconnect();
    });
    bot.on('kicked', (reason, loggedIn) => {
        console.error('\n\nGura is disconnected by server.');
        console.error('Kick reason (raw):', reason);
        console.error('Logged in when kicked?:', loggedIn);
    });
    bot.on('entityHurt', (entity) => {
        if (!bot || !bot.entity)
            return;
        if (entity === bot.entity) {
            bot.chat(`Ouch! I took damage.`);
            const velY = bot.entity.velocity?.y ?? 0;
            if (velY < -0.5) {
                bot.chat("Oof! I think I fell too hard!");
            }
            const nearby = Object.values(bot.entities ?? {}).find(e => e.position?.distanceTo(bot.entity.position) < 4 &&
                e.type === 'mob');
            if (nearby && nearby.name) {
                bot.chat(`Help! ${nearby.name} is attacking me!`);
            }
        }
    });
    bot.on('chat', async (username, message) => {
        if (!bot)
            return;
        console.log(`[CHAT] <${username}> ${message}`);
        if (username !== bot.username) {
            try {
                await handleChatCommand(username, message);
            }
            catch (e) {
                console.error("Error handling chat command:", e);
            }
        }
    });
    bot.once('spawn', () => {
        if (!bot || !bot.entity)
            return;
        console.log(`Logged in as ${bot.username}`);
        bot.pathfinder.setMovements(new Movements(bot));
        intervals.push(setInterval(() => {
            if (!bot.entity)
                return;
            const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (headBlock?.name?.includes('water')) {
                bot.chat("Glub glub... I'm underwater!");
            }
        }, 2000));
        intervals.push(setInterval(() => {
            if (!bot.entity || !bot.entity.position)
                return;
            const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            const feetBlock = bot.blockAt(bot.entity.position.offset(0, 0, 0));
            const isInWater = (headBlock?.name?.includes("water") || feetBlock?.name?.includes("water"));
            if (isInWater) {
                bot.setControlState("jump", true);
                bot.setControlState("forward", true);
                const ground = bot.findBlock({
                    matching: (block) => {
                        if (!block?.name)
                            return false;
                        return !block.name.includes("water") && block.boundingBox === "block";
                    },
                    maxDistance: 20
                });
                if (ground) {
                    bot.lookAt(ground.position.offset(0.5, 0.5, 0.5));
                }
            }
            else {
                bot.setControlState("jump", false);
                bot.setControlState("forward", false);
            }
        }, 1000));
        const changePos = async () => {
            if (!bot || !bot.entity)
                return;
            const lastAction = (0, utils_ts_1.getRandom)(config_json_1.default.action.commands);
            const halfChance = Math.random() < 0.5;
            if (lastAction === 'forward' || lastAction === 'jump') {
                const pos = bot.entity.position;
                const nextPos = pos.offset(-Math.sin(bot.entity.yaw) * 1, 0, Math.cos(bot.entity.yaw) * 1);
                const blockBelow = bot.blockAt(nextPos.offset(0, -1, 0));
                const blockAtNext = bot.blockAt(nextPos);
                const blockBelowY = blockBelow ? blockBelow.position.y : null;
                const currY = Math.floor(pos.y);
                if ((!blockAtNext || blockAtNext.boundingBox === 'empty') &&
                    blockBelowY !== null &&
                    currY - blockBelowY > 1) {
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (dx === 0 && dz === 0)
                                continue;
                            const testPos = pos.offset(dx, 0, dz);
                            const testBlockBelow = bot.blockAt(testPos.offset(0, -1, 0));
                            const testBlockAt = bot.blockAt(testPos);
                            const testBlockBelowY = testBlockBelow ? testBlockBelow.position.y : null;
                            if ((!testBlockAt || testBlockAt.boundingBox === 'empty') &&
                                testBlockBelowY !== null &&
                                currY - testBlockBelowY <= 1) {
                                try {
                                    await bot.pathfinder.goto(new goals.GoalBlock(Math.floor(testPos.x), Math.floor(testBlockBelowY + 1), Math.floor(testPos.z)));
                                }
                                catch (e) {
                                    console.error("Error moving to safe block:", e);
                                }
                                return;
                            }
                        }
                    }
                    return;
                }
            }
            bot.setControlState('sprint', halfChance);
            bot.setControlState(lastAction, true);
            await (0, utils_ts_1.sleep)(config_json_1.default.action.holdDuration);
            clearAllControls(bot);
        };
        const changeView = async () => {
            if (!bot)
                return;
            const yaw = (Math.random() * Math.PI) - (0.5 * Math.PI);
            const pitch = (Math.random() * Math.PI) - (0.5 * Math.PI);
            try {
                await bot.look(yaw, pitch, false);
            }
            catch (e) {
                console.error("Error changing view:", e);
            }
        };
        intervals.push(setInterval(() => {
            if (!bot || !bot.entity)
                return;
            if (currentState !== BotState.IDLE)
                return;
            changeView();
            changePos();
        }, config_json_1.default.action.holdDuration));
        bot.on('playerJoined', (player) => {
            if (!player || !player.username)
                return;
            lastPlayerJoined = player.username;
            const messages = [
                `Oh, what's this? ${player.username}, a new friend has swum into our server!`,
                `Welcome back, ${player.username}!`,
                `Ah, it's ${player.username} again!`,
                `The ocean is brighter with ${player.username} around!`
            ];
            setTimeout(() => bot.chat((0, utils_ts_1.getRandom)(messages)), 1000);
        });
    });
    const hostileMobs = [
        "zombie", "creeper", "skeleton", "spider", "enderman", "witch", "slime", "drowned", "husk", "stray",
        "phantom", "pillager", "vindicator", "evoker", "ravager", "illusioner", "blaze", "magma_cube", "ghast",
        "wither_skeleton", "piglin", "piglin_brute", "zombified_piglin", "hoglin", "zoglin", "warden", "shulker",
        "silverfish", "endermite", "guardian", "elder_guardian", "vex"
    ];
    bot.on('entityMoved', (entity) => {
        if (!bot || !bot.entity)
            return;
        if (!entity || entity.type !== 'mob' || !entity.position)
            return;
        if (currentState === BotState.FLEEING)
            return;
        const mobName = entity.name?.toLowerCase();
        if (!mobName || !hostileMobs.includes(mobName))
            return;
        const distance = bot.entity.position.distanceTo(entity.position);
        if (distance >= 6)
            return;
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
            const block = bot.blockAt(new vec3_1.Vec3(runX, y, runZ));
            if (block && block.boundingBox === 'block') {
                runY = y + 1;
                break;
            }
        }
        try {
            bot.chat("Hostile mob detected! Running away!");
            bot.pathfinder.setMovements(new Movements(bot));
            bot.pathfinder.setGoal(new goals.GoalBlock(Math.round(runX), Math.round(runY), Math.round(runZ)));
        }
        catch (e) {
            console.error("Error fleeing:", e);
        }
        setTimeout(() => {
            if (currentState === BotState.FLEEING) {
                setState(BotState.IDLE);
            }
        }, 5000);
    });
    bot.once('login', () => {
        setTimeout(() => bot.chat(`Hewwo! Same desu~`), 500);
        console.log(`AFKBot logged in as ${bot.username}\n`);
        bot.setMaxListeners(35);
    });
};
exports.createBot = createBot;
