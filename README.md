# 🤖 Gurabott - Minecraft AI Bot Framework

> A powerful, customizable Minecraft bot with AI personality, advanced pathfinding, and complete command automation. **No Groq API? No problem** - use as a pure command-based bot!

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-26.6%2B-green)
![Minecraft](https://img.shields.io/badge/Minecraft-Java%20Edition-red)

---

## ✨ What is Gurabott?

Gurabott is a **flexible Minecraft bot** that can operate in two modes:

| Mode | Description | Requirements |
|------|-------------|--------------|
| **AI-Powered** | Bot responds intelligently, maintains conversations, auto-joins chats | Groq API key |
| **Command-Based** | Full bot control via chat commands, no AI needed | None! |

The default personality is **Hatsune Miku** (the world's most famous virtual idol, la la la~), but you can easily customize it to any character you prefer!

---

## 🎮 Features at a Glance

```
┌─────────────────────────────────────────────────────────┐
│  💬 Natural Conversations                              │
│  🎯 Intelligent Command Execution                      │
│  🧠 Behavior Modes (idle / attack / free)              │
│  📦 Resource Collection & Management                   │
│  ⚔️  Combat System (Mobs & Players)                    │
│  🏠 Environment Interaction (Doors, Beds, Crafting)    │
│  🧭 Advanced Pathfinding                               │
│  🔄 Auto-Reconnection                                  │
│  ⚙️ Fully Customizable Personality                     │
└─────────────────────────────────────────────────────────┘
```

---

## 📋 Complete Feature List

### 💬 AI & Chat Features
- **Intelligent Responses** - AI understands context, game state, and conversation history
- **Conversation Windows** - Mentioning the bot's name always gets a reply and opens a window of 3-5 follow-up replies from the same player; otherwise the bot stays quiet until spoken to again
- **Discord Bridge** - Recognizes relayed Discord messages (`[Discord | <channel>] <rank> | <name> » <msg>`) so it can hear and reply to people on Discord; the same name-mention gating applies
- **Custom Personality** - Edit `personality.json` to customize responses, character name, and behavior
- **Optional AI** - Works perfectly fine without an API key (basic commands only)

### 🧠 Behavior Modes
The bot's autonomous behavior is controlled by a single mode, switchable in-game. It starts each connection in the `behaviorMode` set in `config.json` (default `idle`):

| Command | Function |
|---------|----------|
| `gidle` | Stand still and greet nearby players — no wandering, no auto-combat (default) |
| `gattack` | Hunt and fight hostile mobs on sight |
| `gfree` | Context-dependent: wander, socialize, fight small groups, flee when overwhelmed |
| `gmode` | Show the current behavior mode |

Switching to `gidle` cancels any active combat/flee immediately.

### 🎮 Player Interaction
| Command | Function |
|---------|----------|
| `gfollow <player>` | Follow any player on the server |
| `gsfollow` | Stop following |
| `glast` | Show last player who joined |

### 📦 Resource Management
| Command | Function |
|---------|----------|
| `gcollect <wood\|stone\|dirt> <amount>` | Auto-mine resources |
| `gscollect` | Stop collecting and report what was gathered |
| `gsurv [start\|stop]` | Run/stop autonomous survival progression (wood → tools → stone → iron → diamonds) |
| `ginv` | Show inventory count |
| `ginvsee` | Show all items |
| `geat <item_number> <amount>` | Eat food to restore hunger |
| `gdrop <item_number> <amount>` | Drop specific items |
| `gdump` | Drop entire inventory |

### ⚔️ Combat System
| Command | Function |
|---------|----------|
| `gkill <mob>` | Attack hostile mobs |
| `gkill <player>` | Attack players |

**Supports 30+ mob types:** Zombies, Creepers, Skeletons, Spiders, Endermen, Witches, Slimes, Blazes, and more!

**Smart Weapon Selection:** Auto-equips best tool (Netherite → Diamond → Iron → Stone → Wood)

### 🏠 Environment Interaction
| Command | Function |
|---------|----------|
| `gsleep` | Find and sleep in nearby beds |
| `gopendoor` | Find and open doors/trapdoors |
| `gcraft <item_name>` | Craft items with recipes |
| `gjump <amount>` | Jump multiple times |
| `gcr <seconds>` | Hold sneak for duration |
| `gwalk` | Move forward |

### 🖥️ Chest-GUI Automation
Many plugins (EssentialsShop, ChestShop, ShopGUI+, DeluxeMenus, spawner
plugins...) expose trading through chest/inventory GUIs instead of chat
commands. The bot can read and click them exactly like a real client:

| Command | Function |
|---------|----------|
| `gscan [on\|off]` | Toggle window-slot scanning — dumps every opened GUI (title, type, each slot's name/custom name/lore) so you can map a layout |
| `gopen <profile>` | Open a configured GUI (chat command or right-clicking a block) |
| `grun <profile> <action>` | Run a configured click sequence on an open GUI |
| `gsell` | Shortcut: open `/sell` and run the profile's `sell` action |
| `gspawner` | Open the nearest spawner GUI and dump its layout |
| `gsdrop` | Spawner GUI → chest button → "drop all" (empties all stored drops) |
| `gidledrop [on\|off]` | Parked-turret mode: lock onto the spawner and auto-drop forever until toggled off |

GUI behaviour is configured under `config.json → gui.profiles`. A profile
declares how the window opens, which title identifies it, and named click
sequences (absolute slots or "first slot whose item matches this
name/custom-name/lore", with optional shift-click). `gsdrop` verifies the
drop actually happened — it tries left/shift/right/double-click and reports
which one worked, confirmed by the storage submenu's `[n/m]` page counter
decreasing in place (on many servers the "drop all" button requires a
**shift-click**).

Every drop run **locks the bot's gaze on the spawner**: a 0.5s hold before
the first click, staring through all pages, and a 2s hold after the last —
a gaze enforcer rewrites any other camera movement during that window, so
dropped items always fly toward the spawner/water instead of wherever a
passing player or stray pathfinding glance was pointing.

**Parked-turret mode** (`gui.idleDropMode`, default **on**): right after
spawn the bot locks itself facing the nearest spawner (place it where you
want — it never wanders or walks to the spawner), then drops every
`gui.autoGsdropIntervalSec` seconds until you disable it with `gidledrop
off` or disconnect. This stands the normal schedulers down while active.

**Scheduled draining** is available but **off by default**. Set
`"gui.autoGsdrop": true` to have the bot run `gsdrop` on a schedule: once
20 seconds after joining, then every `gui.autoGsdropIntervalSec` seconds
(default 300), clearing up to `gui.autoGsdropMaxRounds` chest pages per run
(default 1, max 20). Each run stops early when a drop fails or the spawner
reads empty, so leftover pages simply wait for the next tick.

### 🔍 Utility Commands
| Command | Function |
|---------|----------|
| `gcords` | Get current coordinates |
| `gping` | Check connection ping |
| `gtp <x> <y> <z>` | Teleport (requires permissions) |
| `gotocord <x> <y> <z>` | Walk to coordinates using pathfinding |
| `glook <x> <y> <z>` | Lock the bot's head on a position and freeze its behavior until `gidle` |
| `ghelp` | Show all commands |
| `gsay <message>` | Make bot say something |

### 🤖 Core Bot Capabilities
- **Smart Pathfinding** - Navigates obstacles with parkour & sprinting
- **State Management** - Tracks: idle, following, collecting, fleeing, eating, sleeping, attacking
- **Auto-Reconnect** - Retries up to 5 times on disconnect
- **Threat Response** - Flees from nearby hostile mobs
- **Adaptive Behavior** - Eats food when hungry during tasks

---

## 🚀 Quick Start

### Requirements
- **Node.js** 26.6+ (OpenTUI's UI needs the experimental `node:ffi` module, see "Runtime" below)
- **npm** or **pnpm**
- Minecraft Java Edition server
- *Optional:* Groq API key (for AI features)

### Runtime (OpenTUI UI)

The terminal UI is built on OpenTUI, which requires Node's experimental
`node:ffi` module (Node **≥ 26.6**) or Bun. The launch scripts
(`npm start` / `npm test`) auto-detect the best Node automatically:

1. If a project-local portable Node 26 exists in `node-runtime/` (see below),
   it's used — so the bot runs even if your system Node is older.
2. Otherwise they fall back to your system `node`, which must be **≥ 26.6**.

```bash
npm start
```

You can pin to a known-good portable runtime so your system Node version
doesn't matter:

```powershell
# Windows
node-runtime\download.ps1
```
```bash
# Linux / macOS
./node-runtime/download.sh
```

Then `npm start` again. The script picks the portable Node first, so the bot
runs even with an older system Node. On Linux/macOS you can also run the bot
directly once the scripts are executable:

```bash
chmod +x index.js scripts/run.mjs
./index.js          # same as `npm start`
```

`node-runtime/` is gitignored and **optional** on any platform — without it
the bot uses the system Node.

**Terminal UI controls:** the bottom prompt runs commands (`ghelp` lists them).
`↑/↓` walk history, Enter runs, `Ctrl+C` exits unconditionally, and `Esc`
clears the prompt — on an empty prompt `Esc` asks for confirmation first
(`Esc` again to quit, any other key to cancel), so it never kills the bot
by accident. Command history persists across restarts in the gitignored
`command-history.json`, so `↑` recalls commands from previous sessions too.

### Installation

1. **Clone and install**
```bash
git clone https://github.com/TofuGG/gurabott.git
cd gurabott
pnpm install
```

2. **Configure**
```bash
cp config.json.example config.json
```

3. **Edit `config.json`**
```json
{
  "client": {
    "host": "your.server.ip",
    "port": "25565",
    "username": "YourBotName"
  },
  "ai": {
    "enabled": true,
    "apiKey": "gsk_YOUR_GROQ_API_KEY",
    "maxTokens": 150
  },
  "auth": {
    "enabled": false,
    "password": "",
    "mode": "command"
  },
  "greeting": true,
  "autoReconnect": true,
  "behaviorMode": "idle",
  "guardrails": true,
  "mcp": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 5400
  },
  "action": {
    "retryDelay": 5000
  },
  "gui": {
    "debugWindows": false,
    "idleDropMode": true,
    "autoGsdrop": false,
    "autoGsdropIntervalSec": 300,
    "autoGsdropMaxRounds": 1,
    "verboseLogging": false,
    "profiles": {}
  }
}
```

4. **Run**
```bash
npm start
```

---

## ⚙️ Configuration

### `config.json` Reference

| Option | Type | Description |
|--------|------|-------------|
| `client.host` | string | Server IP or hostname |
| `client.port` | string | Server port (default: 25565) |
| `client.username` | string | Bot's in-game name |
| `ai.enabled` | boolean | Enable AI features |
| `ai.apiKey` | string | Groq API key (or "YOUR_GROQ_API" to skip) |
| `ai.maxTokens` | number | Max response length (150-500) |
| `auth.*` | object | AuthMe login automation (`mode`: command/gui/anvil/dialog/both) |
| `greeting` | boolean | Say hello when players join |
| `autoReconnect` | boolean | Reconnect on disconnect |
| `behaviorMode` | string | Default behavior mode on join: `idle`, `attack`, or `free` (default: `idle`) |
| `mcp.*` | object | MCP server settings (default: 127.0.0.1:5400) |
| `action.retryDelay` | number | Reconnect delay (ms) |
| `gui.debugWindows` | boolean | Auto-dump every opened GUI window on launch (`gscan on` persists here) |
| `gui.idleDropMode` | boolean | Parked-turret mode: face the spawner after spawn and auto-drop forever (default: **true**) |
| `gui.autoGsdrop` | boolean | Run `gsdrop` on a schedule while gidledrop is off (default: **false**) |
| `gui.autoGsdropIntervalSec` | number | Seconds between automatic drops; first drop fires 20s after join (default: 300, min: 5, invalid → 300) |
| `gui.autoGsdropMaxRounds` | number | Chest pages to drop per scheduled run; stops early on empty/failure (default: 1, max: 20) |
| `gui.verboseLogging` | boolean | Trace every camera move with caller attribution, window open/close/clicks, item spawns/pickups — for diagnosing look/click mysteries (default: **false**) |
| `gui.profiles.*` | object | Chest-GUI profiles: title match, how the window opens, and named click sequences (see "Chest-GUI Automation") |

---

## 📄 Logs

Every run writes one JSON line per log entry (chat, system, errors, AI, state)
to two files in the gitignored `logs/` directory:

- `<YYYY-MM-DD-HH-mm-ss-SSS>-<username>.log` — the per-run archive
- `Latest_Log.txt` — a live mirror of the current run

Retention keeps the newest 10 per-run files; older ones are pruned on startup.

---

## 🎨 Customizing Personality

Edit `personality.json` to completely change how the bot behaves:

```json
{
  "name": "Your Character Name",
  "description": "Short description",
  "traits": ["trait1", "trait2"],
  "systemPrompt": "Instructions for AI on how to act...",
  "messages": {
    "login": "Custom login message",
    "playerJoined": ["Welcome message 1", "Welcome message 2"],
    ...
  }
}
```

### Example: Change to Another Character
```json
{
  "name": "Aqua",
  "systemPrompt": "You are Aqua from Konosuba. You're a clumsy goddess with a pure heart...",
  "traits": ["clumsy", "kind", "divine"],
  "messages": {
    "login": "I am Aqua! The goddess of water has arrived!"
  }
}
```

---

## 🤖 AI Mode vs Command Mode

### AI Mode (Requires Groq API)
✅ Bot responds to chat naturally  
✅ Conversation windows (mention the bot to start chatting)  
✅ Makes intelligent decisions  
✅ Customizable personality  
❌ Requires API key  
❌ Uses API quota  

### Command Mode (No API)
✅ All commands still work  
✅ No API key needed  
✅ No costs  
✅ Faster response times  
❌ No natural responses  
❌ No AI decisions  

**How to use Command Mode:**
- Set `"enabled": false` in config
- OR leave `apiKey` as `"YOUR_GROQ_API"`
- Bot will show: *"Sorry, AI is not available. Use basic commands!"*

---

## 🏗️ Architecture

### File Structure
```
gurabott/
├── src/
│   ├── index.ts          # Entry point
│   ├── bot.ts            # Bot orchestrator (wires all modules)
│   ├── config.ts         # Config loader
│   ├── protocolFix.ts    # Runtime fix for 1.21.6+ dialog-system packets
│   ├── utils.ts          # Helper functions (safeGoto, timeouts)
│   ├── session.ts        # Per-connection lifecycle
│   ├── web.ts            # Health-check HTTP server
│   ├── constants.ts      # Shared block/entity name lists
│   ├── movementAI.ts     # Ambient movement AI (wander, stare, suppression)
│   ├── stuckDetector.ts  # Physics-based stuck detection
│   ├── core/
│   │   ├── store.ts      # Event bus + telemetry/log snapshot store
│   │   ├── logFile.ts    # JSONL log archiving + retention
│   │   └── gazeLock.ts   # Camera lock: rewrites bot.look while staring at a target
│   ├── modules/
│   │   ├── commands.ts   # All g-command handlers
│   │   ├── state.ts      # Bot state machine
│   │   ├── mode.ts       # Behavior mode controller (gidle/gattack/gfree)
│   │   ├── survival.ts   # Autonomous survival loop (gsurv)
│   │   ├── combat.ts     # Hostile-mob combat & flee controller
│   │   ├── mining.ts     # Shared mining/tool/pickup helpers
│   │   ├── water.ts      # Water self-rescue + call-for-help
│   │   ├── gui.ts        # Chest-GUI automation (profiles, spawner drop, autoSell)
│   │   ├── debugTrace.ts # Opt-in verbose tracer for look/click debugging
│   │   ├── guardrails.ts # Safety guards on dangerous actions
│   │   ├── pathRecorder.ts # Records walk routes for sellPath replay
│   │   ├── ai.ts         # Groq chat integration
│   │   ├── auth.ts       # AuthMe login automation (command/gui/anvil/dialog/both)
│   │   ├── connection.ts # Reconnect manager
│   │   ├── mcp.ts        # MCP server (control the bot from any AI)
│   │   └── mcpCommands.ts # g-commands exposed as MCP tools
│   ├── ui/               # OpenTUI renderer (Solid components)
│   └── types/            # Ambient type declarations
├── config.json           # Your configuration (gitignored)
├── config.json.example   # Config shape reference
├── personality.json      # Character personality
├── package.json          # Dependencies
├── scripts/run.mjs       # Launcher (picks Node runtime, injects flags)
└── README.md            # This file
```

### Core Technologies
- **Mineflayer** - Minecraft bot framework
- **mineflayer-baritone** - Baritone pathfinding (native C++ bridge)
- **OpenTUI** - Terminal UI framework (Node `node:ffi`)
- **Groq API** - LLaMA 3.1 AI model
- **MCP (Model Context Protocol)** - Let any AI observe and control the bot
- **minecraft-data** - Block/item database
- **TypeScript** - Type-safe code

---

## 🐛 Troubleshooting

### Bot won't connect
- Check server IP and port
- Verify bot account isn't banned
- Ensure network connectivity
- Check logs for error messages

### AI responds slowly
- Check Groq API status
- Reduce `maxTokens` in config
- Check internet connection
- Verify API key is valid

### Commands don't work
- Use exact command spelling
- Check bot has required permissions
- Use `ghelp` to see available commands
- Verify not in busy state

### Bot keeps disconnecting
- Increase `retryDelay` in config
- Check server stability
- Look for kick/ban messages
- Monitor account status

---

## 📝 Command Examples

### Farming Setup
```
gfollow <player>          # Tag along
gcollect wood 64          # Mine 64 wood
gcollect stone 32         # Mine 32 stone
gdump                     # Drop everything
```

### Combat Scenario
```
gkill zombie              # Attack zombie
gkill <player_name>       # Attack player
```

### Resource Check
```
ginvsee                   # See inventory
gcords                    # Check position
gping                     # Check latency
```

### Crafting Workflow
```
gcraft wood_pickaxe       # Craft pickaxe
gcraft chest              # Craft chest
```

---

## 📄 License

This project is licensed under **GNU General Public License v3.0**

You are free to:
- ✅ Use, modify, and distribute
- ✅ Use for commercial purposes
- ✅ Include in your projects

You must:
- ✅ Include original license
- ✅ Disclose source code modifications
- ✅ Use same GPL-3.0 license for derivatives

See [LICENSE](LICENSE) for details.

---

## 🤝 Contributing

Contributions welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests
- Improve documentation

---

## ⚠️ Disclaimer

This bot is for **educational and testing purposes**. Use responsibly on servers where you have permission. The developers are not responsible for misuse of this software.

---

## 🔗 Resources

- [Mineflayer Documentation](https://github.com/PrismarineJS/mineflayer)
- [Groq API Console](https://console.groq.com)
- [Minecraft Data](https://github.com/PrismarineJS/minecraft-data)

---

**Made with ❤️ for Minecraft enthusiasts**
