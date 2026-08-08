# 🤖 Gurabott - Minecraft AI Bot Framework

> A powerful, customizable Minecraft bot with AI personality, advanced pathfinding, and complete command automation. **No Groq API? No problem** - use as a pure command-based bot!

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![Minecraft](https://img.shields.io/badge/Minecraft-Java%20Edition-red)

---

## ✨ What is Gurabott?

Gurabott is a **flexible Minecraft bot** that can operate in two modes:

| Mode | Description | Requirements |
|------|-------------|--------------|
| **AI-Powered** | Bot responds intelligently, maintains conversations, auto-joins chats | Groq API key |
| **Command-Based** | Full bot control via chat commands, no AI needed | None! |

The default personality is **Gawr Gura** (smol shark girl VTuber, glub glub), but you can easily customize it to any character you prefer!

---

## 🎮 Features at a Glance

```
┌─────────────────────────────────────────────────────────┐
│  💬 Natural Conversations                              │
│  🎯 Intelligent Command Execution                      │
│  📦 Resource Collection & Management                   │
│  ⚔️  Combat System (Mobs & Players)                    │
│  🏠 Environment Interaction (Doors, Beds, Crafting)    │
│  🧭 Advanced Pathfinding                               │
│  🔄 Auto-Reconnection                                  │
│  ⚙️  Fully Customizable Personality                    │
└─────────────────────────────────────────────────────────┘
```

---

## 📋 Complete Feature List

### 💬 AI & Chat Features
- **Intelligent Responses** - AI understands context, game state, and conversation history
- **Three Interaction Modes**:
  - Direct mention: Responds when name is spoken
  - Chiming in: Randomly joins conversations (multiplayer)
  - Solo mode: Responds to everything (single player)
- **Custom Personality** - Edit `personality.json` to customize responses, character name, and behavior
- **Optional AI** - Works perfectly fine without an API key (basic commands only)

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

### 🔍 Utility Commands
| Command | Function |
|---------|----------|
| `gcords` | Get current coordinates |
| `gping` | Check connection ping |
| `gtp <x> <y> <z>` | Teleport (requires permissions) |
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
- **Node.js** 18+ (the OpenTUI UI needs **Node ≥ 26** with `node:ffi`, see "Runtime" below)
- **npm** or **pnpm**
- Minecraft Java Edition server
- *Optional:* Groq API key (for AI features)

### Runtime (OpenTUI UI)

The terminal UI is built on OpenTUI, which requires Node's experimental
`node:ffi` module (Node **≥ 26.6**) or Bun. The `npm start` script runs the bot
through a project-local portable Node 26 (`node-runtime/`). First run:

```bash
node-runtime\download.ps1   # downloads + extracts Node 26 into node-runtime/
npm start
```

`node-runtime/` is gitignored; without it the bot will not start.

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
  "mcp": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 5400
  },
  "action": {
    "retryDelay": 5000
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
| `auth.*` | object | AuthMe login automation (`mode`: command/gui/anvil/both) |
| `greeting` | boolean | Say hello when players join |
| `autoReconnect` | boolean | Reconnect on disconnect |
| `mcp.*` | object | MCP server settings (default: 127.0.0.1:5400) |
| `action.retryDelay` | number | Reconnect delay (ms) |

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

### Example: Change from Gura to Another Character
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
✅ Auto-chimes into conversations  
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
│   ├── utils.ts          # Helper functions (safeGoto, timeouts)
│   ├── session.ts        # Per-connection lifecycle
│   ├── web.ts            # Health-check HTTP server
│   ├── core/
│   │   └── store.ts      # Event bus + telemetry/log snapshot store
│   ├── constants.ts      # Shared block/entity name lists
│   ├── modules/
│   │   ├── commands.ts   # All g-command handlers
│   │   ├── state.ts      # Bot state machine
│   │   ├── survival.ts   # Autonomous survival loop (gsurv)
│   │   ├── combat.ts     # Hostile-mob combat & flee controller
│   │   ├── mining.ts     # Shared mining/tool/pickup helpers
│   │   ├── water.ts      # Water self-rescue + call-for-help
│   │   ├── movementAI.ts # Idle/wander behaviors
│   │   ├── stuckDetector.ts # Physics-based stuck detection
│   │   ├── ai.ts         # Groq chat integration
│   │   ├── auth.ts       # AuthMe login automation
│   │   ├── connection.ts # Reconnect manager
│   │   ├── mcp.ts        # MCP server (control the bot from any AI)
│   │   └── mcpCommands.ts # g-commands exposed as MCP tools
│   ├── ui/               # OpenTUI renderer (React-style components)
│   └── types/            # Ambient type declarations
├── config.json           # Your configuration
├── personality.json      # Character personality
├── package.json          # Dependencies
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
