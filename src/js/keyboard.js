// SHORTCUTS is the help overlay and the global keydown table.
// Entries with `run` are installed on document keydown. Empty `codes` are
// help-only: contextual keys, or mouse + modifier. Clicks, playlist chrome,
// and headset buttons are README — not this list.

import { $, isTypingTarget } from './dom.js';
import { cycleTheme } from './themes.js';
import { cycleVisualization, pickLocalFile, navigateOrder } from './controls.js';
import { skipTrack } from './playlist.js';
import { toggleMixer } from './mixer.js';
import { toggleLibrary } from './library.js';
import { isAnyModalOpen } from './modal.js';

// ENTER belongs to focused button-likes; SPACE stays global Play/Pause.
function isActivatableTarget(target) {
    if (!target) return false;
    if (target.tagName === 'BUTTON') return true;
    if (target.getAttribute && target.getAttribute('role') === 'button') return true;
    return false;
}

// `joiner`: ' / ' for alternative keys, ' + ' for chorded inputs.
// `run` receives the keydown event so handlers can branch on e.shiftKey etc.
export const SHORTCUTS = [
    { codes: ['Space', 'KeyP'], keys: ['Space', 'P'],    label: 'Play / Pause',            run: () => $('#play').click() },
    { codes: ['KeyS'],          keys: ['S'],             label: 'Stop',                    run: () => $('#stop').click() },
    { codes: ['KeyL'],          keys: ['L'],             label: 'Open file…',               run: () => pickLocalFile() },
    { codes: ['KeyB'],          keys: ['B'],             label: 'Load',                     run: () => toggleLibrary() },
    { codes: ['ArrowLeft', 'ArrowRight'], keys: ['← / →'], label: 'Previous / next order', run: (e) => {
        const dir = e.code === 'ArrowLeft' ? -1 : +1;
        return e.shiftKey ? skipTrack(dir) : navigateOrder(dir);
    } },
    { codes: [],                keys: ['Shift', '← / →'], joiner: ' + ',                   label: 'Previous / next track in playlist' },
    { codes: ['KeyE'],          keys: ['E'],             label: 'Toggle effects (viz on/off)', run: () => $('#toggle-visualizations').click() },
    { codes: ['KeyV'],          keys: ['V'],             label: 'Cycle visualization (Shift: reverse)', run: (e) => cycleVisualization(e?.shiftKey) },
    { codes: ['KeyI'],          keys: ['I'],             label: 'Toggle samples / playlist pane', run: () => $('#toggle-samples').click() },
    { codes: ['KeyM'],          keys: ['M'],             label: 'Toggle mixer',             run: () => toggleMixer() },
    { codes: ['KeyT'],          keys: ['T'],             label: 'Cycle theme (Shift: reverse)', run: (e) => cycleTheme(e?.shiftKey) },
    // Handle-focused — pane-resize.js owns these; listed here for the help overlay.
    { codes: [], keys: ['Handle', '← / →'], joiner: ' + ', label: 'Nudge samples pane (Shift: 40px)' },
    { codes: [], keys: ['Handle', 'Home'], joiner: ' + ',  label: 'Reset samples pane to automatic width' },
    { codes: [], keys: ['Ctrl / ⌘', 'Click header'], joiner: ' + ', label: 'Solo channel (mute others)' },
    { codes: [], keys: ['Shift', 'Drop'], joiner: ' + ',   label: 'Replace the playlist' },
    { codes: [], keys: ['?'],                              label: 'Toggle keyboard shortcuts' },
    { codes: [], keys: ['Esc'],                            label: 'Close dialog' },
];

const codeHandlers = new Map();
for (const entry of SHORTCUTS) {
    if (!entry.run) continue;
    for (const code of entry.codes) codeHandlers.set(code, entry.run);
}

export function installKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
        if (isTypingTarget(e.target)) return;
        // A dialog owns the keyboard while it is open (its own keys, Esc, Tab).
        if (isAnyModalOpen()) return;
        if (e.target?.classList?.contains('pane-resizer')) return;
        if (e.code === 'Enter' && isActivatableTarget(e.target)) return;
        const handler = codeHandlers.get(e.code);
        if (!handler) return;
        e.preventDefault();
        handler(e);
    });
}
