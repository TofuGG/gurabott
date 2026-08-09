# Gurabott Architecture Map

Navigation index for the codebase. Every module, its job, and the symbols to look for.
Generated from the graphify knowledge graph (`graphify-out/graph.json`).

## Startup flow

```
index.js (thin wrapper → scripts/run.mjs)
  → src/index.ts main()          interactive config prompts → shutdown() on exit
      → src/bot.ts createBot()   THE orchestrator hub (27 edges)
          → loadJson()/loadConfig()   lazy-load config.json + personality.json
          → initAuth()                anvil/GUI login before spawn
          → startMcpServer()          Streamable HTTP on 127.0.0.1:5400
          → startMovementAI()         ambient behavior loop
          → startStuckDetector()      watchdog
          → configureBaritone()       pathfinding plugin
```

## Module-by-module

### src/bot.ts — Orchestrator  [Bot Orchestration]
Entry hub: `createBot()` (L242). Creates the mineflayer client (L305), wires chat → commands, AI response loop (`handleAIResponse` L150), death handling, telemetry (`pushBotTelemetry` L59). Context builders: `buildCommandCtx`, `buildAIStateContext`, `getBotCommandCtx`.

### src/core/store.ts — Event bus + log/telemetry store  [Log & Telemetry Store]
The single sink. Engine code pushes, UI subscribes — never the reverse.
- **Producer side:** `addLog()` (L67) — every module logs here; `pushTelemetry()` (L104); `interceptConsole()` (L127) redirects `console.*` into addLog.
- **Consumer side:** `onLog()` (L88), `onTelemetry()` (L115), `getLogs()` (L95), `getTelemetry()` (L111).
- Types: `LogType` ('chat'|'system'|'error'|'state'|'ai'|'movement'|'warn'), `LogEntry`, `TelemetrySnapshot`.
- `LOG_TRIM_BATCH` / `MAX_LOG_ENTRIES` — ring-buffer trimming.

### src/modules/commands.ts — `g*` command registry  [Commands & MCP / Resources & Survival]
`commands` Record of all `g*` commands; `handleCommand()` (L690) is the dispatch entry (bot chat, AI actions, MCP all funnel here). `CommandContext`, `BUSY_STATES`, `formatMsg()`.

### src/modules/mcp.ts — MCP server  [Commands & MCP]
Streamable HTTP on 127.0.0.1:5400. `startMcpServer()` (L491), `registerAllTools()` (L161, exposes bot + store functions as MCP tools), `createMcpSession()`, exec-lock helpers (`withExecLock`, `execLock`).

### src/modules/mcpCommands.ts — MCP tool specs  [Commands & MCP]
`commandSpecs` (zod-validated tool schemas), `registerMcpCommands()` (L212). Bridges commands.ts into the MCP tool surface.

### src/modules/state.ts — State machine  [Bot Orchestration / Resources & Survival]
`BotState` enum, `getState()` (L28), `setState()` (L32, same-state = no-op; IDLE clears movement), `onStateChange()` (pub/sub), `attachBot()`, `resetState()`, `clearAllControls()`.

### src/modules/survival.ts — Survival loops  [Resources & Survival]
`startSurv()`, `runLoop()` (L—), `step()`, `mine()`, `smelt()`, `craft()`, `placeNearby()`, `goTo()`, `countOf()`, `has()`, `invSummary()`. Thin log wrappers `log()/logWarn()/logErr()` (L91-93) → addLog.

### src/modules/mining.ts — Mining helpers  [Resources & Survival]
`equipBestTool()`, `getBestToolForBlock()`, `getBestWeapon()`, `waitForPickup()`.

### src/modules/combat.ts — Combat  [Bot Orchestration / Movement AI / Resources & Survival]
`createCombatController()` (L30) — hostile detection, attack/flee via setState.

### src/movementAI.ts — Ambient movement AI  [Movement AI / Commands & MCP / Session & Timers]
`startMovementAI()` (L409) launched by createBot. Weighted random behaviors (`do*` fns: stroll/stand/pace/circle/crouch-fidget/look-at-player/distracted-walk), safety checks (`isSafeGround`, `isNearFire`, `isWaterAt`), `suppressMovement()`/`resumeMovement()`/`isMovementSuppressed()` (respects session.moveActive).

### src/modules/ai.ts — Groq AI (optional)  [AI Response]
`getAIResponse()` (L135), `parseAIReply()`, rate limiting (`isRateLimited`, `recordRequest`), action parsing (`isAction`, `ACTION_PREFIXES`). Gated by `AI_ENABLED` in bot.ts.

### src/modules/auth.ts — Server login  [Bot Orchestration]
`initAuth()` (L125), `runAnvilLogin()` (L108), `runGuiLogin()`, `clickSlots()`, `isAuthWindow()`.

### src/modules/connection.ts — Reconnect  [Bot Orchestration]
`initReconnect()`, `triggerReconnect()`, `resetReconnectAttempts()`, `setDisconnecting()`.

### src/modules/water.ts — Water survival  [Bot Orchestration]
`startWaterSurvival()`.

### src/session.ts — Connection-scoped timers  [Session & Timers]
`BotSession`: every timer/async loop owned by a connection must be `session.track()`-ed so disconnect cancels atomically. `.end()`, `.onEnd()`, `.clearTimers()`.

### src/stuckDetector.ts — Watchdog  [Bot Orchestration / Resources & Survival]
`startStuckDetector()` — detects pathfinding stalls.

### src/config.ts — Config  [Bot Orchestration]
`loadConfig()` (L55) reads config.json (gitignored, has API key/password), `loadJson()` (L49), `BotConfig` type, backfills legacy keys (auth/mcp/greeting).

### src/constants.ts — Shared constants  [Resources & Survival / Commands & MCP / Movement AI]
`COBBLE/STONE/IRON_ORE/DIAMOND/LOG_LOGS/PLANKS`, `BLOCK_DROPS`, `RESOURCE_GROUPS`, `DOOR_NAMES`, `HOSTILE_MOBS`.

### src/utils.ts — Shared utilities  [Bot Orchestration / Movement AI / Resources & Survival]
`safeGoto()` (L38 — always navigate via this, never bare `bot.ashfinder.goto()`), `sleep()`, `withTimeout()`, `getRandom()`, `parseChatMessage()`, `ParsedChat`.

### src/web.ts — Misc web helpers  [Bot Orchestration]
`setBotHealthStatus()`, `escapeHtml()`.

### src/ui/* — OpenTUI + Solid terminal UI  [Log & Telemetry Store]
- `index.tsx`: `initTUI()`, `destroyTUI()`, `updateAIStatus()`
- `app.tsx`: `App()` — root layout; CommandHandler
- `header.tsx`: `Header()` — consumes `getTelemetry()` + `onTelemetry()`
- `scrollback.tsx`: `Scrollback()` — consumes `getLogs()` + `onLog()`; virtualized feed
- `footer.tsx`: `Footer()`
- `theme.ts`: `theme`, `formatUptime()`, `vitalityColor()`, `bar()`

### src/index.ts — CLI bootstrap  [Bot Orchestration]
`main()`, `shutdown()`. Runs interactive prompts over readline, then strips readline stdin listeners before OpenTUI takes over (do not regress).

### scripts/run.mjs — Cross-platform launcher  [Runtime Launcher]
Picks the Node binary (portable `node-runtime/` first, system `node` as fallback), injects the OpenTUI-required `--experimental-ffi` CLI flags, and spawns tsx on the requested entry (`src/index.ts`, `src/test.mts`, ...). Both `npm start` and `index.js` delegate here.

### Config files
- `config.json` (gitignored) / `config.json.example` — shape source of truth
- `personality.json` — bot personality
- `tsconfig.json` — NodeNext ESM, `noEmit`, `allowImportingTsExtensions` (explicit `.ts` imports everywhere)
- `.opencode/opencode.json` — graphify plugin wiring

## Key data flows

```
[input] chat ──► bot.ts ──► handleCommand() ──► g* command
                      │
[input] AI actions ──► handleAIResponse() ──► handleCommand()  (or setState)
                      │
MCP client ──► startMcpServer ──► registerAllTools ──► handleCommand()
                      │
[every module] ──► addLog() ──► store.logs ──► onLog() ──► Scrollback() UI
                  pushTelemetry() ──► onTelemetry() ──► Header() UI
                      │
state ──► getState()/setState() ──► survival loops, combat, movementAI
```

## Rule of thumb for finding things

| You want to... | Look in |
|---|---|
| Add a bot command | `src/modules/commands.ts` (commands Record) + `src/modules/mcpCommands.ts` for the MCP surface |
| Change what the bot does automatically | `src/modules/survival.ts` (runLoop/step) or `src/movementAI.ts` (behaviors) |
| Add a log/telemetry field | `src/core/store.ts` (addLog/pushTelemetry + types) |
| Change UI layout | `src/ui/*` (Header/Scrollback consume the store) |
| Change login flow | `src/modules/auth.ts` |
| Handle reconnects | `src/modules/connection.ts` |
| Navigate the bot somewhere | `safeGoto()` in `src/utils.ts` |
| Track a new background task | `session.track()` in `src/session.ts` |
| Change state transitions | `src/modules/state.ts` + `BotState` in the same file |
| Change config shape | `src/config.ts` + `config.json.example` |
