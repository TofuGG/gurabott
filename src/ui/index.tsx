/**
 * ui/index.ts — OpenTUI renderer facade exposing the initTUI/destroyTUI/
 * updateAIStatus surface to the entry point.
 *
 * The bot engine never imports this module — it only emits into the core
 * store (addLog/pushTelemetry) and the UI subscribes.
 */
import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { App, type CommandHandler } from './app.tsx';

let renderer: CliRenderer | null = null;
let commandHandler: CommandHandler | null = null;
let registeredExitNet = false;

export async function initTUI(opts: {
    onCommand: CommandHandler;
    aiEnabled: boolean;
    serverInfo: string;
    onExit: () => void;
}): Promise<void> {
    commandHandler = opts.onCommand;
    void opts.aiEnabled;

    if (renderer) await destroyTUI();

    renderer = await createCliRenderer({
        exitSignals: [],
        exitOnCtrlC: false,
        clearOnShutdown: true,
    });

    // Safety net: restore the terminal even if the process dies without an
    // orderly destroyTUI() (uncaught exception path, etc.).
    if (!registeredExitNet) {
        registeredExitNet = true;
        process.on('exit', () => {
            try { renderer?.destroy(); } catch {}
        });
    }

    await render(
        () => <App serverInfo={opts.serverInfo} onCommand={opts.onCommand} onExit={opts.onExit} />,
        renderer,
    );
}

export async function destroyTUI(): Promise<void> {
    try { renderer?.destroy(); } catch {}
    renderer = null;
}

export function updateAIStatus(_enabled: boolean): void {
    // The OpenTUI header reads aiEnabled from the telemetry snapshot, so no
    // push here is needed.
}
