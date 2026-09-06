// Samples pane width. By default the pane fits its content (CSS
// fit-content, capped at 40 % of the row) so blank or short sample names
// don't waste space that 32-channel patterns could use. A drag handle on
// the pane's inner edge sets an explicit width (persisted); double-click
// the handle to go back to automatic.

import { $ } from './dom.js';
import { prefs } from './prefs.js';
import { relayoutTracker } from './tracker.js';

const MIN_PX = 120;
const MAX_FRACTION = 0.6;

let container = null;
let pane = null;
let handle = null;

function applyWidth(px) {
    if (px == null) container.style.removeProperty('--samples-col');
    else container.style.setProperty('--samples-col', `${Math.round(px)}px`);
    requestAnimationFrame(() => relayoutTracker());
}

// Which edge faces the tracker? Themes may put the samples on the left.
function paneIsLeftOfMain() {
    const main = $('.tracker-main');
    if (!main) return false;
    return pane.getBoundingClientRect().left < main.getBoundingClientRect().left;
}

function syncHandleSide() {
    pane.classList.toggle('samples-left', paneIsLeftOfMain());
}

export function resetSamplesWidth() {
    prefs.samplesWidth = null;
    applyWidth(null);
}

export function installSamplesResizer() {
    container = $('.tracker-container');
    pane = $('.sample-section');
    if (!container || !pane) return;

    handle = document.createElement('div');
    handle.className = 'pane-resizer';
    handle.title = 'Drag to resize the samples pane · double-click for automatic width';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize samples pane');
    handle.tabIndex = 0;
    pane.appendChild(handle);

    const saved = prefs.samplesWidth;
    if (typeof saved === 'number' && saved >= MIN_PX) applyWidth(saved);
    syncHandleSide();
    window.addEventListener('resize', syncHandleSide);

    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        syncHandleSide();
        const left = pane.classList.contains('samples-left');
        const rect = pane.getBoundingClientRect();
        const startX = e.clientX;
        const startW = rect.width;
        const maxPx = container.getBoundingClientRect().width * MAX_FRACTION;
        try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        handle.classList.add('dragging');
        document.body.classList.add('pane-resizing');
        let pending = null;
        const move = ev => {
            const dx = ev.clientX - startX;
            const w = Math.min(maxPx, Math.max(MIN_PX, left ? startW + dx : startW - dx));
            pending = w;
            container.style.setProperty('--samples-col', `${Math.round(w)}px`);
        };
        const up = () => {
            handle.classList.remove('dragging');
            document.body.classList.remove('pane-resizing');
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            if (pending != null) { prefs.samplesWidth = Math.round(pending); applyWidth(pending); }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', resetSamplesWidth);
    handle.addEventListener('keydown', e => {
        const left = pane.classList.contains('samples-left');
        const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (dir) {
            e.preventDefault();
            const w = pane.getBoundingClientRect().width + dir * (left ? 1 : -1) * (e.shiftKey ? 40 : 10);
            const maxPx = container.getBoundingClientRect().width * MAX_FRACTION;
            const clamped = Math.min(maxPx, Math.max(MIN_PX, w));
            prefs.samplesWidth = Math.round(clamped);
            applyWidth(clamped);
        } else if (e.key === 'Home' || e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            resetSamplesWidth();
        }
    });
}
