    import Mineflayer from 'mineflayer';
    import pathfinderLib from 'mineflayer-pathfinder';
    import { sleep, getRandom } from "./utils.ts";
    import CONFIG from "../config.json" with { type: 'json' };
    import readline from 'readline';
    import minecraftData from 'minecraft-data';
    import { Vec3 } from 'vec3';
    const { pathfinder, Movements, goals } = pathfinderLib;
    const { GoalFollow } = goals;

    let bot: Mineflayer.Bot;
    let following = false;
    let lastPlayerJoined: string | null = null;
    let loop: NodeJS.Timeout;
    const DEFAULT_RETRY_DELAY = 5000;
    let currentConfig: { ip: string; port: number; username: string; version: string } | null = null;


    const disconnect = (): void => {
        clearInterval(loop);
        bot?.quit?.();
        bot?.end?.();
    };

    const reconnect = async (): Promise<void> => {
    console.log(`Trying to reconnect in ${CONFIG.action.retryDelay / 1000} seconds...\n`);
    disconnect();
    await sleep(CONFIG.action.retryDelay);
    if (currentConfig) {
        createBot(currentConfig, rl);
    }
    };

    function startCommandLine(bot: any, rl: readline.Interface) {
        rl.on('line', (line) => {
            const [cmd, ...args] = line.trim().split(/\s+/);
            if (cmd === 'gsay') {
                const msg = args.join(' ');
                bot.chat(msg);
            }
            
        });
    }




    function handleCommand(line: string, bot: Mineflayer.Bot) {
    const items = bot.inventory.items();
    }


    function clearAllControls(bot: Mineflayer.Bot) {
    const controls: Mineflayer.ControlState[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    for (const c of controls) bot.setControlState(c, false);
    }

    function getRandomDelay(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }



    const handleChatCommand = async (username: string, rawMessage: string) => {
        const items = bot.inventory?.items?.() ?? [];
        const args = rawMessage.trim().split(' ');
        const command = args.shift()?.toLowerCase();

        if (!command) return;

        switch (command) {
            case 'gping':
                bot.chat(`Pong! ${bot.player.ping}ms`);
                break;

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
                    `>>gstop: disconnect the bot.`,
                    `>>gdump: drop all items from inventory.`,
                    `>>gkill: disconnect and exit the process.`,
                    `>>glast: show the last player who joined.`,
                    `>>gstopfollow: stop following the current player.`
                ];
                for (const line of helpMessages) {
                    await sleep(getRandomDelay(700, 1200)); // longer delay
                    try {
                        bot.chat(line);
                    } catch (err) {
                        console.error("Failed to send chat:", err);
                    }
                }
                break;

            case 'gsay':
                if (args.length === 0) {
                    bot.chat('Usage: gsay <message>');
                } else {
                    bot.chat(args.join(' '));
                }
                break;

            case 'ginv':
                bot.chat(items.length === 0 ? 'I have nothing' : `I have ${items.length} items`);
                break;

            case 'ginvsee':
                if (items.length === 0) {
                    bot.chat('I have nothing');
                } else {
                    const output = items.map((item, index) => `${index + 1}. ${item.name} x${item.count}`).join('\n');
                    bot.chat(output);
                }
                break;

            case 'geat':
                if (args.length === 0) {
                    if (items.length === 0) {
                        bot.chat("I don't have any food to eat!");
                    } else {
                        // List all food items with numbers
                        const foodList = items.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join('\n');
                        bot.chat(foodList);
                        bot.chat('Usage: geat <food_number> <amount>');
                    }
                } else {
                    const foodIdx = parseInt(args[0], 10) - 1;
                    const amount = parseInt(args[1], 10) || 1;
                    if (isNaN(foodIdx) || foodIdx < 0 || foodIdx >= items.length) {
                        bot.chat('Invalid food number. Usage: geat <food_number> <amount>');
                        break;
                    }
                    const food = items[foodIdx];
                    let eaten = 0;
                    for (let i = 0; i < amount && bot.food < 20 && food.count > 0; i++) {
                        bot.activateItem();
                        eaten++;
                        food.count--;
                        await sleep(500); // simulate eating delay
                        if (bot.food === 20) {
                            bot.chat("Now I'm full!");
                            break;
                        }
                    }
                    bot.chat(`Ate ${eaten} ${food.name}`);
                    if (bot.food === 20) bot.chat("Now I'm full!");
                }
                break;

            case 'gjump':
                const jumpAmount = parseInt(args[0], 10) || 1;
                for (let i = 0; i < jumpAmount; i++) {
                    bot.setControlState('jump', true);
                    await sleep(500);
                    bot.setControlState('jump', false);
                    if (i < jumpAmount - 1) await sleep(500);
                }
                break;

            case 'gdrop':
                if (args.length === 0) {
                    if (items.length === 0) {
                        bot.chat("I don't have any items to drop!");
                    } else {
                        const itemList = items.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join('\n');
                        bot.chat(itemList);
                        bot.chat('Usage: gdrop <item_number> <amount>');
                    }
                } else {
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
                        await bot.toss(item.type, null, 1);
                        await sleep(200);
                    }
                }
                break;


            case 'gwalk':
                bot.setControlState('forward', true);
                await sleep(500);
                bot.setControlState('forward', false);
                break;

            case 'gcr':
                const sneakAmount = parseInt(args[0], 10) || 1;
                for (let i = 0; i < sneakAmount; i++) {
                    bot.setControlState('sneak', true);
                    await sleep(500);
                    bot.setControlState('sneak', false);
                    if (i < sneakAmount - 1) await sleep(500);
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
                const onMessage = (jsonMsg: any) => {
                    const msg = jsonMsg.toString();
                    if (
                        msg.includes("Unknown command") ||
                        msg.includes("You do not have permission") ||
                        msg.includes("no permission") ||
                        msg.includes("not a valid number") ||
                        msg.includes("cannot be found")
                    ) {
                        bot.chat("I don't have permission to use /tp.");
                        bot.removeListener('message', onMessage);
                    }
                };

                bot.chat(tpCommand);
                break;
            
            case 'gfollow':
                let targetName = args[0];
                if (!targetName) {
                    await bot.chat('Usage: gfollow <player>/me');
                    break;
                }

                // If the player types "gfollow me", use the sender's username
                if (targetName.toLowerCase() === 'me') {
                    targetName = username;
                }

                const playerEntity = bot.players[targetName]?.entity;
                if (!playerEntity) {
                    await bot.chat(`I can't see ${targetName}`);
                    break;
                }

                following = true;
                await bot.chat(`Following ${targetName}`);
                bot.pathfinder.setMovements(new Movements(bot));
                bot.pathfinder.setGoal(new GoalFollow(playerEntity, 1), true);
                break;


            /*case 'gcraft': {
                const itemName = args[0];
                if (!itemName) {
                    bot.chat('Usage: gcraft <item_name>');
                    break;
                }
                const mcData = minecraftData(bot.version);
                const item = mcData.itemsByName[itemName];
                if (!item) {
                    bot.chat(`Unknown item: ${itemName}`);
                    break;
                }
                const recipe = bot.recipesAll(item.id, null, 1)[0];
                if (!recipe) {
                    bot.chat(`No recipe found for ${itemName}`);
                    break;
                }
                try {
                    await bot.craft(recipe, 1, null);
                    bot.chat(`Crafted 1 ${itemName}`);
                } catch (e: any) {
                    bot.chat(`Failed to craft: ${e.message}`);
                }
                break;
                }*/

            case 'gcraft': {
                const itemName = args[0];
                if (!itemName) {
                    bot.chat('Usage: gcraft <item_name>');
                    break;
                }

                const mcData = minecraftData(bot.version);
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

                // Try to find a crafting table nearby if needed
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
                } catch (err: any) {
                    bot.chat(`Failed to craft ${itemName}: ${err.message}`);
                }
                break;
                }


            case 'gstop':
                bot.chat(`Disconnecting...`);
                await sleep(1000);
                disconnect();
                break;


            case 'gdump':
                if (items.length === 0) {
                    bot.chat('I have nothing to drop!');
                } else {
                    bot.chat(`Dropping all items...`);
                    for (const item of items) {
                        await bot.tossStack(item);
                        await sleep(200);
                    }
                }
                break;


            case 'gkill':
                bot.chat('Shutting down...');
                await sleep(500);
                bot.quit();        // disconnect from server
                rl.close();        // stop listening for stdin
                process.exit(0);   // fully exit the Node process
                break;
                            



            case 'glast':
                if (lastPlayerJoined) {
                    bot.chat(`Last player joined: ${lastPlayerJoined}`);
                } else {
                    bot.chat(`No one has joined since I started.`);
                }
                break;



            case 'gstopfollow':
                if (following) {
                    following = false;
                    bot.pathfinder.setGoal(null);
                    bot.chat("Stopped following.");
                } else {
                    bot.chat(`<Not following anyone>`);
                }
                break;


            default:
                if (username === 'Shell') {
                    console.log(`[Shell] Unknown command: ${command}`);
                }
        }
    };

    export const createBot = (
        config: { ip: string; port: number; username: string; version: string },
        rl: readline.Interface
        ): void => {
        bot = Mineflayer.createBot({
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

        /*bot.on('kicked', (rawResponse) => {
            //console.error(`\n\nGura is disconnected: ${rawResponse}`);
            console.error('Kicked:', reason, 'Logged in?', loggedIn);
        });*/
        bot.on('kicked', (reason, loggedIn) => {
            console.error('\n\nGura is disconnected by server.');
            console.error('Kick reason (raw):', reason);
            console.error('Logged in when kicked?:', loggedIn);
        });


        bot.on('end', (reason) => {
            console.log('Connection ended (Mineflayer):', reason);
            reconnect();   // or use setTimeout(reconnect, delay)
        });



        bot.on('chat', async (username, message) => {
            console.log(`[CHAT] <${username}> ${message}`);
            if (username !== bot.username) {
                await handleChatCommand(username, message); // updated name
            }
        });


        bot.once('spawn', () => {
            console.log(`Logged in as ${bot.username}`);
            bot.pathfinder.setMovements(new Movements(bot));
            //startCommandLine(bot, rl);


            const changePos = async (): Promise<void> => {
                const lastAction = getRandom(CONFIG.action.commands) as Mineflayer.ControlState;
                const halfChance = Math.random() < 0.5;
                bot.setControlState('sprint', halfChance);
                bot.setControlState(lastAction, true);
                await sleep(CONFIG.action.holdDuration);
                clearAllControls(bot);
            };

            const changeView = async (): Promise<void> => {
                const yaw = (Math.random() * Math.PI) - (0.5 * Math.PI);
                const pitch = (Math.random() * Math.PI) - (0.5 * Math.PI);
                await bot.look(yaw, pitch, false);
            };

            loop = setInterval(() => {
                if (!following) {  // <-- ADD THIS CHECK
                changeView();
                changePos();
                }
            }, CONFIG.action.holdDuration);

            

            bot.on('playerJoined', (player) => {
                lastPlayerJoined = player.username;
                const messages = [
                `Oh, what's this? ${player.username}, a new friend has swum into our server!`,
                `Welcome back, ${player.username}!`,
                `Ah, it's ${player.username} again!`,
                `The ocean is brighter with ${player.username} around!`
                ];
                setTimeout(() => bot.chat(getRandom(messages)), 1000);
            });
        });


        bot.once('login', () => {
            //bot.chat(` `);
            setTimeout(() => bot.chat(`Hewwo! Same desu~`), 500);
            console.log(`AFKBot logged in as ${bot.username}\n`);
            bot.setMaxListeners(35);
        });
        bot.on('kicked', (reason, loggedIn) => {
            console.error('Kicked:', reason, 'logged in?', loggedIn);
        });

    };
