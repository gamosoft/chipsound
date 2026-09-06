// Help overlay. Lazy-built on the shared modal primitive (modal.js).
// Shortcut list: keyboard.js#SHORTCUTS. Credits mirror /NOTICE and
// docs/licenses.md.

import { isTypingTarget } from './dom.js';
import { SHORTCUTS } from './keyboard.js';
import { createModal } from './modal.js';

const CREDITS = [
    { name: 'libopenmpt',    url: 'https://lib.openmpt.org/libopenmpt/',          license: 'BSD-3' },
    { name: 'Chiptune.js',   url: 'https://github.com/DrSnuggles/chiptune',       license: 'MIT'   },
    { name: 'Font Awesome',  url: 'https://fontawesome.com/license/free',         license: 'CC BY 4.0' },
];

const help = createModal({
    id: 'helpOverlay',
    title: 'Keyboard shortcuts',
    className: 'modal-help',
    build(body) {
        let rows = '';
        for (const { keys, label, joiner = ' / ' } of SHORTCUTS) {
            const kbds = keys.map(k => `<kbd>${k}</kbd>`).join(joiner);
            rows += `<dt>${kbds}</dt><dd>${label}</dd>`;
        }
        const creditLinks = CREDITS
            .map(c => `<a href="${c.url}" target="_blank" rel="noopener">${c.name}</a> <span class="help-credits-license">(${c.license})</span>`)
            .join(' · ');
        body.innerHTML = `
            <dl class="help-list">${rows}</dl>
            <footer class="help-credits">
                <div class="help-home">
                    <a href="https://chipsound.com" target="_blank" rel="noopener">
                        <img src="./images/favicon.svg" alt="" width="22" height="22" aria-hidden="true">
                        <span>chipsound.com</span>
                    </a>
                    <a href="https://ko-fi.com/gamosoft" target="_blank" rel="noopener" class="help-support">
                        <span class="help-support-icon" aria-hidden="true">☕</span>
                        <span>Support on Ko-fi</span>
                    </a>
                </div>
                Built on ${creditLinks}.
            </footer>`;
    },
});

export function openHelp() { help.open(); }
export function closeHelp() { help.close(); }
export function toggleHelp() { help.toggle(); }

// '?' (Shift+/) — not in the shortcut table; it's a derived shifted key.
// Esc is handled by the modal primitive.
export function installHelpEscape() {
    document.addEventListener('keydown', e => {
        if (e.key === '?' && !isTypingTarget(e.target)) {
            e.preventDefault();
            toggleHelp();
        }
    });
}
