/**
 * footer.tsx — bottom control surface with a live command prompt.
 *
 * An OpenTUI `<input>` owns the command line: type to edit, Enter to submit,
 * ↑/↓ to walk history. Esc clears the buffer (or, on an already-empty buffer,
 * arms a two-step exit confirmation — a second Esc confirms, any other key
 * cancels) and Ctrl+C exits unconditionally.
 *
 * KEY DISPATCH: OpenTUI delivers key events to global `keyInput` listeners
 * BEFORE the focused renderable (the input) gets them, so the `useKeyboard`
 * handlers here can act first and `key.stopPropagation()` to keep the input
 * from also processing arrows / escape.
 *
 * REACTIVITY NOTE: like header.tsx, the eager react-jsx transform evaluates
 * props once, so the input is driven imperatively through its node ref
 * (`inputEl.value`) rather than a controlled signal.
 */
import { useKeyboard } from '@opentui/solid';
import { onMount } from 'solid-js/dist/solid.js';
import { theme } from './theme.ts';
import { loadHistory, saveHistory } from './history.ts';

type AnyInput = { value: string; placeholder: string; focus: () => void };

const HISTORY_LIMIT = 100;
const DEFAULT_PLACEHOLDER = 'Type a command — e.g. ghelp, status, quit';
const CONFIRM_PLACEHOLDER = 'Press ESC again to confirm exit — any other key cancels';

export function Footer(props: { onCommand: (cmd: string, args: string[]) => void | Promise<void>; onExit: () => void; historyFile?: string }) {
    let inputEl: AnyInput | null = null;
    // Seed the ring from disk so ↑/↓ recall commands from previous sessions.
    const history: string[] = loadHistory(props.historyFile);
    let histIdx = -1;
    let confirmExit = false;

    const setValue = (v: string): void => {
        if (inputEl && inputEl.value !== v) inputEl.value = v;
    };

    const setConfirm = (on: boolean): void => {
        confirmExit = on;
        if (inputEl && inputEl.placeholder !== (on ? CONFIRM_PLACEHOLDER : DEFAULT_PLACEHOLDER)) {
            inputEl.placeholder = on ? CONFIRM_PLACEHOLDER : DEFAULT_PLACEHOLDER;
        }
    };

    const submit = (raw: string): void => {
        const trimmed = raw.trim();
        setValue('');
        if (!trimmed) return;

        history.push(trimmed);
        if (history.length > HISTORY_LIMIT) history.shift();
        histIdx = -1;
        saveHistory(history, props.historyFile);

        const parts = trimmed.split(/\s+/);
        void props.onCommand(parts[0], parts.slice(1));
    };

    useKeyboard((key) => {
        if (key.name === 'escape') {
            if (confirmExit) {
                // Second Esc on the empty buffer confirms the exit.
                key.stopPropagation();
                setConfirm(false);
                props.onExit();
            } else if (inputEl && inputEl.value) {
                // First Esc with text typed: clear the buffer.
                key.stopPropagation();
                setValue('');
            } else {
                // First Esc on an empty buffer: arm the confirmation instead of
                // exiting outright — an accidental Esc no longer kills the bot.
                key.stopPropagation();
                setConfirm(true);
            }
            return;
        }
        // Any other key cancels a pending exit confirmation.
        setConfirm(false);
        if (key.name === 'up') {
            key.stopPropagation();
            if (histIdx === -1) histIdx = history.length;
            if (histIdx > 0) {
                histIdx--;
                setValue(history[histIdx]);
            }
        } else if (key.name === 'down') {
            key.stopPropagation();
            if (histIdx !== -1) {
                histIdx++;
                if (histIdx >= history.length) {
                    histIdx = -1;
                    setValue('');
                } else {
                    setValue(history[histIdx]);
                }
            }
        }
    });

    // Defensive: ensure the prompt owns keyboard focus once mounted.
    onMount(() => inputEl?.focus());

    return (
        <box
            height={2}
            paddingX={1}
            style={{ backgroundColor: theme.footer.bg, border: ['top'], borderStyle: 'single', borderColor: theme.footer.border }}
        >
            <box flexDirection="row" gap={1} height={1}>
                <text content="›" flexShrink={0} style={{ fg: theme.footer.prompt }} />
                <input
                    flexGrow={1}
                    focused
                    placeholder={DEFAULT_PLACEHOLDER}
                    placeholderColor={theme.footer.hint}
                    backgroundColor={theme.footer.bg}
                    focusedBackgroundColor={theme.footer.bg}
                    textColor={theme.footer.text}
                    focusedTextColor={theme.footer.text}
                    onSubmit={(v: any) => submit(typeof v === 'string' ? v : '')}
                    ref={(n: any) => { inputEl = n; }}
                />
                <text content="Enter run · ↑/↓ history · Esc Esc quit · Ctrl+C quit" flexShrink={0} style={{ fg: theme.footer.hint }} />
            </box>
        </box>
    );
}
