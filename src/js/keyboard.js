// SHORTCUTS is the single source of truth — help overlay reads from it too.

import { $, isTypingTarget } from './dom.js';
import { cycleTheme } from './themes.js';
import { cycleVisualization } from './controls.js';
import { toggleMixer } from './mixer.js';

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
    { codes: ['KeyL'],          keys: ['L'],             label: 'Open file…',              run: () => $('#load').click() },
    { codes: ['ArrowLeft'],     keys: ['←'],             label: 'Previous order',          run: () => $('#previous').click() },
    { codes: ['ArrowRight'],    keys: ['→'],             label: 'Next order',              run: () => $('#next').click() },
    { codes: ['KeyE'],          keys: ['E'],             label: 'Toggle effects (viz on/off)', run: () => $('#toggle-visualizations').click() },
    { codes: ['KeyV'],          keys: ['V'],             label: 'Cycle visualization (Shift: reverse)', run: (e) => cycleVisualization(e?.shiftKey) },
    { codes: ['KeyI'],          keys: ['I'],             label: 'Toggle samples',          run: () => $('#toggle-samples').click() },
    { codes: ['KeyM'],          keys: ['M'],             label: 'Toggle mixer (playback parameters)', run: () => toggleMixer() },
    { codes: ['KeyT'],          keys: ['T'],             label: 'Cycle theme (Shift: reverse)', run: (e) => cycleTheme(e?.shiftKey) },
    // Mouse-only — listed for docs, no key binding.
    { codes: [], keys: ['Click header'],                           label: 'Toggle channel mute' },
    { codes: [], keys: ['Ctrl', 'Click header'], joiner: ' + ',    label: 'Solo channel (mute others)' },
    { codes: [], keys: ['Click <i class="fa-solid fa-grip-lines-vertical" aria-hidden="true"></i>'], label: 'Toggle ALL channels' },
    { codes: [], keys: ['Drop file'],                              label: 'Load and auto-play module' },
    { codes: [], keys: ['?'],                                      label: 'Show this help' },
    { codes: [], keys: ['Esc'],                                    label: 'Close this help' },
];

const codeHandlers = new Map();
for (const entry of SHORTCUTS) {
    if (!entry.run) continue;
    for (const code of entry.codes) codeHandlers.set(code, entry.run);
}

export function installKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
        if (isTypingTarget(e.target)) return;
        if (e.code === 'Enter' && isActivatableTarget(e.target)) return;
        const handler = codeHandlers.get(e.code);
        if (!handler) return;
        e.preventDefault();
        handler(e);
    });
}
