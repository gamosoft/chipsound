// SHORTCUTS is the single source of truth — help overlay reads from it too.

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
    { codes: ['KeyL'],          keys: ['L'],             label: 'Open file… (several files start a new playlist)', run: () => pickLocalFile() },
    { codes: ['KeyB'],          keys: ['B'],             label: 'Load (file, curated, local, URL)', run: () => toggleLibrary() },
    { codes: ['ArrowLeft', 'ArrowRight'], keys: ['← / →'], label: 'Previous / next order', run: (e) => {
        const dir = e.code === 'ArrowLeft' ? -1 : +1;
        return e.shiftKey ? skipTrack(dir) : navigateOrder(dir);
    } },
    { codes: [],                keys: ['Shift', '← / →'], joiner: ' + ',                   label: 'Previous / next track in playlist' },
    { codes: [],                keys: ['Previous / Next'],                                 label: 'Orders, or tracks when a playlist is playing' },
    { codes: ['KeyE'],          keys: ['E'],             label: 'Toggle effects (viz on/off)', run: () => $('#toggle-visualizations').click() },
    { codes: ['KeyV'],          keys: ['V'],             label: 'Cycle visualization (Shift: reverse)', run: (e) => cycleVisualization(e?.shiftKey) },
    { codes: ['KeyI'],          keys: ['I'],             label: 'Toggle samples / playlist pane', run: () => $('#toggle-samples').click() },
    { codes: ['KeyM'],          keys: ['M'],             label: 'Toggle mixer (playback parameters)', run: () => toggleMixer() },
    { codes: ['KeyT'],          keys: ['T'],             label: 'Cycle theme (Shift: reverse)', run: (e) => cycleTheme(e?.shiftKey) },
    // Handle-focused — pane-resize.js owns these; listed here for the help overlay.
    { codes: [], keys: ['Handle', '← / →'], joiner: ' + ', label: 'Nudge samples pane (Shift: 40px)' },
    { codes: [], keys: ['Handle', 'Home'], joiner: ' + ',  label: 'Reset samples pane to automatic width' },
    // Mouse-only — listed for docs, no key binding.
    { codes: [], keys: ['Click header'],                           label: 'Toggle channel mute' },
    { codes: [], keys: ['Ctrl', 'Click header'], joiner: ' + ',    label: 'Solo channel (mute others)' },
    { codes: [], keys: ['Click <i class="fa-solid fa-grip-lines-vertical" aria-hidden="true"></i>'], label: 'Toggle ALL channels' },
    { codes: [], keys: ['Drop files'],                           label: 'Play now, or add to playlist if already playing (Shift: replace)' },
    { codes: [], keys: ['Click playlist row'],                   label: 'Jump to that track (samples pane Playlist tab)' },
    { codes: [], keys: ['Playlist trash'],                       label: 'Remove that track (keeps playing if something is next; last one unloads)' },
    { codes: [], keys: ['Headset next / prev'],                  label: 'Skip playlist tracks when a mix is playing' },
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
