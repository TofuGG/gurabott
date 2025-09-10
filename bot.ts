import mineflayer from 'mineflayer';
import { patchBotForForge } from 'mineflayer-forge';
import { sleep, getRandom } from "./utils.ts";
import CONFIG from "../config.json" assert { type: 'json' };
import pathfinder from 'mineflayer-pathfinder';
import Movements from 'mineflayer-pathfinder';

let loop: NodeJS.Timer;
let bot: Mineflayer.Bot;

const disconnect = (): void => {
    clearInterval(loop);
    bot?.quit?.();
    bot?.end?.();
};


const reconnect = async (): Promise<void> => {
    console.log(`Trying to reconnect in ${CONFIG.action.retryDelay / 1000} seconds...\n`);

    disconnect();
    await sleep(CONFIG.action.retryDelay);
    createBot();
};

const createBot = (): void => {
    bot = mineflayer.createBot({
        host: CONFIG.client.host,
        port: +CONFIG.client.port,
        username: CONFIG.client.username,
        version: false, // Let it auto-detect or specify like "1.12.2"
        forge: true     // This tells it to connect as Forge client
    });
    
    patchBotForForge(bot); // Patch the bot after creation    

    bot.once('error', (error) => {
        console.error(`Gura got an error: ${error}`);
    });

    bot.once('kicked', (rawResponse) => {
        console.error(`\n\nGura is disconnected: ${rawResponse}`);
    });

    bot.once('end', () => void reconnect());

    bot.on('playerLeft', (player) => {
        bot.chat( `Goodbye ${player.username}!`);
    });

    //add feature to make the bot read chat messages from minecraft and discord and respond to the commands
    bot.on('chat', async (username, message) => {
        const items = bot.inventory.items();
        if (username === bot.username) return;
        const args = message.split(' ');
        const command = args.shift()?.toLowerCase();
        if (command === 'gping') {
            bot.chat(`Pong! ${bot.player.ping}ms`);
        } else if (command === 'ghelp') {
            bot.chat(`Chat commands:
>>gping: responds with the bot's ping.
>>ghelp: displays a list of available commands.
>>gsay: repeats a message sent by the user.
>>ginv: displays the bot's inventory.
>>ginvsee: displays the bot's inventory with item names and counts.
>>geat: makes the bot eat food from its inventory.
>>gjump: makes the bot jump.
>>gdrop: makes the bot drop an item from its inventory.
>>gwalk: makes the bot walk forward.
>>gcr: makes the bot crouch and uncrouch.
>>gcords: displays the bot's coordinates.`);
        } else if (command === 'gstop') {
            bot.chat(`Stopping...`);
            await sleep(1000);
            disconnect();
        } else if (command === 'gsay'){
            bot.chat(args.join(' '));
        } else if (command === 'ginv'){
            //tells how many stuff she has
            if (items.length === 0)
                bot.chat('I have nothing');
            else
                bot.chat(`I have ${bot.inventory.items().length} items`);
        } else if (command === 'ginvsee'){
            /*tells what she has {item} x{ammount} listing every item like this:
              "1. Watermelon x4
               2. dirt x6"*/
            if (items.length === 0)
                bot.chat('I have nothing');
            else {
                const output = items.map((item, index) => `${index + 1}. ${item.name} x${item.count}`).join('\n');
                bot.chat(output);
            }
        } else if (command === 'geat'){
            //eats the first item in the inventory or says "im full" if she is already full
            if (bot.food === 20){
                bot.chat("I'm full");
            } else {
                const items = bot.inventory.items();
                if (items.length === 0) {
                    bot.chat("I don't have any food to eat!");
                    return;
                }
                const food = items[0];
                bot.chat(`Eating ${food.name}`);
                bot.activateItem();
            }
        } else if (command === 'gjump'){
            //jumps
            bot.setControlState('jump', true);
            await sleep(500);
            bot.setControlState('jump', false);
        } else if (command === 'gdrop'){
            //drops the first item in the inventory
            const items = bot.inventory.items();
            if (items.length === 0) {
                bot.chat("I don't have any items to drop!");
                return;
            }
            const item = items[0];
            bot.chat(`Dropping ${item.name}`);
            bot.tossStack(item);
        } else if (command === 'gwalk'){
            //walk 5 blocks forward
            bot.setControlState('forward', true);
            await sleep(500);
            bot.setControlState('forward', false);
        } else if (command === 'gcr'){
            //crouch and uncrouch
            bot.setControlState('sneak', true);
            await sleep(500);  
            bot.setControlState('sneak', false);
        } else if (command === "gcords") {
          //make the bot send its cordinates
            bot.chat('My cords are ' + bot.entity.position);
        } else if (command === "ggo") {
            //go to a certain position
            const x = +args[0];
            const y = +args[1];
            const z = +args[2];
            // bot.pathfinder.goto({ x, y, z });
            //TypeError: Cannot read properties of undefined (reading 'goto')
            

        } else if (command === "gtp") {
            //teleport to a certain position
        } 
      });

    bot.once('spawn', () => {
        const changePos = async (): Promise<void> => {
            const lastAction = getRandom(CONFIG.action.commands) as Mineflayer.ControlState;
            const halfChance: boolean = Math.random() < 0.5 ? true : false; // 50% chance to sprint

            bot.setControlState('sprint', halfChance);
            bot.setControlState(lastAction, true); // starts the selected random action

            await sleep(CONFIG.action.holdDuration);
            bot.clearControlStates();
            return;
        };

        const changeView = async (): Promise<void> => {
            const yaw = (Math.random() * Math.PI) - (0.5 * Math.PI);
            const pitch = (Math.random() * Math.PI) - (0.5 * Math.PI);

            await bot.look(yaw, pitch, false);
            return;
        };

        loop = setInterval(() => {
            changeView();
            changePos();
        }, CONFIG.action.holdDuration);

        bot.on('playerJoined', (player) => {
            const messages = [
                `Oh, what's this? ${player.username}, a new friend has swum into our server! Hello and welcome!`,
                `Welcome back, ${player.username}! The chat just got a whole lot more fin-tastic!`,
                `Ah, it's ${player.username} making a grand entrance once again! Welcome back to the sharky shenanigans!`,
                `The ocean is brighter with ${player.username} around! Welcome to the underwater party!`
            ];
            // waits 1 secs before sending the message
            setTimeout(() => // sends the message
                bot.chat(getRandom(messages)), 1000);
        });
    });

    bot.once('login', () => {
        bot.chat(`password`);
        setTimeout(() => bot.chat(`Hewwo! Same desu~`), 1690);
        console.log(`AFKBot logged in ${bot.username}\n`);
        bot.setMaxListeners(35); // or any number greater than your current number of listeners
    });
};

export default (): void => {
    createBot();
};