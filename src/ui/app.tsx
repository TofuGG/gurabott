/**
 * app.tsx — root component of the OpenTUI interface.
 *
 * opencode-style split-footer layout:
 *   ┌────────────────────────────┐
 *   │  Header (live status bar)  │
 *   ├────────────────────────────┤
 *   │  Scrollback (log feed)     │  ← grows to fill
 *   ├────────────────────────────┤
 *   │  Footer (input/status)     │
 *   └────────────────────────────┘
 */
import { useKeyboard, useRenderer, useSelectionHandler } from '@opentui/solid';
import type { Selection } from '@opentui/core';
import { Header } from './header.tsx';
import { Scrollback } from './scrollback.tsx';
import { Footer } from './footer.tsx';
import { theme } from './theme.ts';

export type CommandHandler = (cmd: string, args: string[]) => void | Promise<void>;

export function App(props: { serverInfo: string; onCommand: CommandHandler; onExit: () => void }) {
    // Ctrl+C exits unconditionally — even mid-typing. Global key listeners run
    // before the focused input processes the key, so this fires reliably.
    useKeyboard((key) => {
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            key.stopPropagation();
            props.onExit();
        }
    });

    // Copy-on-selection: OpenTUI captures the mouse (native terminal selection
    // is impossible while the renderer owns the screen), so any finished text
    // selection is pushed to the system clipboard via OSC 52.
    const renderer = useRenderer();
    useSelectionHandler((selection: Selection) => {
        const text = selection.getSelectedText();
        if (text) {
            try {
                renderer.copyToClipboardOSC52(text);
            } catch {
                // Clipboard unavailable (terminal doesn't support OSC 52) —
                // selection still works, just nothing is copied.
            }
        }
    });

    return (
        <box flexDirection="column" width="100%" height="100%" style={{ backgroundColor: theme.background }}>
            <Header serverInfo={props.serverInfo} />
            <Scrollback />
            <Footer onCommand={props.onCommand} onExit={props.onExit} />
        </box>
    );
}
