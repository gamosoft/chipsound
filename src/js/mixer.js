// Mixer panel — live playback parameters. Every control maps to one key of
// the worklet config (see openmpt-params.js#applyRenderParam); changes go
// straight to libopenmpt and take effect on the next audio quantum. Values
// persist in prefs.render (engine units) and are fed into the player's
// initial config by index.js, so a reload comes back exactly as you left it.
//
// Control paradigms (borrowed from DAWs and NN/g's "linked controls"):
//   drag slider          coarse, snaps to `step` and to the default detent
//   hold Shift           while dragging (any time): fine, 10× slower
//   wheel / ←→ ↑↓        one step; with Shift one fine step
//   value field          type an exact value (Enter commits, Esc reverts),
//                        ↑↓ nudge, or drag it sideways to scrub
//   double-click / Ctrl-click   reset that control to its default

import { $ } from './dom.js';
import { prefs } from './prefs.js';
import { playerState } from './state.js';
import { relayoutTracker } from './tracker.js';
import { mountRenderControls } from './render.js';

const signed = v => (v > 0 ? '+' : '') + v;

// UI values are in display units; toEngine/fromEngine convert to the worklet
// config units (defaults here are the engine defaults from chiptune3.js).
export const PARAMS = [
    {
        key: 'stereoSeparation', label: 'Stereo separation', type: 'range',
        min: 0, max: 200, step: 5, fine: 1, def: 100, detent: 3, decimals: 0, unit: '%',
        hint: '0 = mono · 100 = default · 200 = full width (Amiga hard pan)',
    },
    {
        key: 'amigaResampler', label: 'Amiga resampler', type: 'select', def: 'a1200',
        options: [['off', 'Off'], ['auto', 'Auto'], ['a500', 'A500'], ['a1200', 'A1200'], ['unfiltered', 'Unfiltered']],
        hint: 'Paula emulation for Amiga-style modules (MOD etc.). A500 is the darkest, Unfiltered the brightest; Off = use the interpolation filter below. Easiest to hear on a MOD with bright samples.',
    },
    {
        key: 'interpolationFilter', label: 'Interpolation', type: 'select', def: 0,
        options: [[0, 'Default'], [1, 'None (nearest)'], [2, 'Linear'], [4, 'Cubic'], [8, 'Sinc (8-tap)']],
        hint: 'Sample interpolation. Default = 8-tap sinc. None is the audible one (aliasing on low-rate samples); cubic vs sinc is subtle. Ignored for Amiga modules while the Amiga resampler is on.',
    },
    {
        key: 'volumeRamping', label: 'Volume ramping', type: 'range',
        min: -1, max: 10, step: 1, fine: 1, def: -1, decimals: 0,
        fmt: v => (v < 0 ? 'Default' : v === 0 ? 'Off' : String(v)),
        parse: s => (/^d/i.test(s) ? -1 : /^o/i.test(s) ? 0 : Number(s)),
        hint: 'Smooths volume jumps to avoid clicks. Off = raw tracker behaviour.',
    },
    {
        key: 'tempoFactor', label: 'Tempo', type: 'range',
        min: 50, max: 200, step: 1, fine: 0.1, def: 100, detent: 1, decimals: 1, unit: '%',
        toEngine: v => v / 100, fromEngine: f => f * 100,
        hint: 'Speed without changing pitch.',
    },
    {
        key: 'pitchFactor', label: 'Pitch', type: 'range',
        min: -12, max: 12, step: 1, fine: 0.01, def: 0, detent: 0.2, decimals: 2, unit: ' st',
        fmt: v => `${signed(v.toFixed(2))} st`,
        toEngine: st => 2 ** (st / 12), fromEngine: f => 12 * Math.log2(f),
        hint: 'Semitones (fine step = 1 cent). Pitch without changing speed.',
    },
    {
        key: 'masterGain', label: 'Gain', type: 'range',
        min: -12, max: 12, step: 1, fine: 0.1, def: 0, detent: 0.2, decimals: 1, unit: ' dB',
        fmt: v => `${signed(v.toFixed(1))} dB`,
        toEngine: db => Math.round(db * 100), fromEngine: mb => mb / 100,
        hint: 'Pre-mix master gain inside libopenmpt (independent of the volume slider).',
    },
    {
        key: 'repeatCount', label: 'Loop', type: 'select', def: 0,
        options: [[0, 'Play once'], [-1, 'Forever'], [1, 'Twice'], [3, '4 times']],
        hint: 'What happens when the module reaches its end.',
    },
];

let panelEl = null;
let toggleBtn = null;
const controls = new Map();   // key -> { input, field, value }
const rows = new Map();       // key -> row element

// libopenmpt only runs the Amiga (Paula) resampler for modules flagged as
// Amiga-style; these are the format ids (metadata "type") that get the flag.
const AMIGA_TYPES = new Set(['mod', 'm15', 'stk', 'nst', 'wow', 'pt36', 'okt', 'digi', 'sfx', 'sfx2', 'med', 'mmd0', 'mmd1', 'mmd2', 'mmd3', 'stp']);
let moduleType = null;

// Some rows can't affect the current module: say so instead of letting the
// user hunt for a difference that isn't there.
function refreshInert() {
    const amigaModule = moduleType ? AMIGA_TYPES.has(moduleType) : null;
    const amigaOn = controls.get('amigaResampler')?.value !== 'off';
    const mark = (key, reason) => {
        const row = rows.get(key);
        if (!row) return;
        row.classList.toggle('inert', Boolean(reason));
        let tag = row.querySelector('.mixer-inert');
        if (reason) {
            if (!tag) { tag = document.createElement('span'); tag.className = 'mixer-inert'; row.appendChild(tag); }
            tag.textContent = reason;
        } else tag?.remove();
    };
    mark('amigaResampler', amigaModule === false ? `no effect: ${moduleType.toUpperCase()} isn't an Amiga format` : '');
    mark('interpolationFilter', amigaModule && amigaOn ? 'ignored while the Amiga resampler is on' : '');
}

export function setModuleType(type) {
    moduleType = type ? String(type).toLowerCase() : null;
    refreshInert();
}

const toEngine = (p, v) => (p.toEngine ? p.toEngine(v) : v);
const fromEngine = (p, v) => (p.fromEngine ? p.fromEngine(v) : v);

function fmt(p, v) {
    if (p.fmt) return p.fmt(v);
    return `${Number(v).toFixed(p.decimals ?? 0)}${p.unit ?? ''}`;
}

function clamp(p, v) {
    return Math.min(p.max, Math.max(p.min, v));
}

function quantize(v, q) {
    const n = Math.round(v / q) * q;
    // kill float noise (0.1 * 3 = 0.30000000000000004)
    return Number(n.toFixed(6));
}

// Engine-unit value from persisted prefs, validated.
function coerceEngine(p, raw) {
    if (p.type === 'select') {
        const opt = p.options.find(([v]) => String(v) === String(raw));
        return opt ? opt[0] : p.def;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return toEngine(p, p.def);
    const ui = clamp(p, fromEngine(p, n));
    return toEngine(p, quantize(ui, p.fine));
}

// Saved settings merged over defaults, in engine units. Used by index.js to
// seed the player config before the worklet even starts.
export function savedRenderConfig() {
    const saved = prefs.render || {};
    const out = {};
    for (const p of PARAMS) out[p.key] = p.key in saved ? coerceEngine(p, saved[p.key]) : toEngine(p, p.def);
    return out;
}

function persist() {
    const cfg = {};
    for (const p of PARAMS) cfg[p.key] = toEngine(p, controls.get(p.key).value);
    prefs.render = cfg;
}

// Set a control to a UI-unit value: updates slider + field, sends to engine.
function setParam(p, value, { save = true } = {}) {
    const c = controls.get(p.key);
    if (p.type === 'range') value = clamp(p, quantize(value, p.fine));
    c.value = value;
    if (c.input && String(c.input.value) !== String(value)) c.input.value = value;
    if (c.field && document.activeElement !== c.field) c.field.value = fmt(p, value);
    playerState.player?.setRenderParam(p.key, toEngine(p, value));
    if (save) persist();
    if (p.key === 'amigaResampler') refreshInert();
}

function nudge(p, dir, fine) {
    const c = controls.get(p.key);
    const q = fine ? p.fine : p.step;
    setParam(p, quantize(c.value + dir * q, q));
}

function parseTyped(p, text) {
    const s = String(text).trim();
    if (p.parse) { const v = p.parse(s); if (Number.isFinite(v)) return v; }
    const m = s.replace(',', '.').match(/[-+]?\d*\.?\d+/);
    return m ? Number(m[0]) : NaN;
}

function buildRange(p, row, current) {
    const id = `mixer-${p.key}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = p.min; input.max = p.max;
    input.step = p.fine;                    // continuous track; we snap in JS
    input.value = String(current);
    input.setAttribute('aria-label', p.label);

    // Default-value tick mark under the track (NN/g: show the default).
    const list = document.createElement('datalist');
    list.id = `${id}-ticks`;
    const tick = document.createElement('option');
    tick.value = String(p.def);
    tick.label = 'default';
    list.appendChild(tick);
    input.setAttribute('list', list.id);

    const field = document.createElement('input');
    field.type = 'text';
    field.inputMode = 'decimal';
    field.className = 'mixer-value';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.setAttribute('aria-label', `${p.label} value`);
    field.title = 'Type a value, ↑↓ to nudge, drag sideways to scrub';

    controls.set(p.key, { input, field, value: current });

    // --- slider: coarse drag with step + default detent ---
    input.addEventListener('input', () => {
        if (input.dataset.fineDrag) {
            // Some browsers keep dragging the native thumb even after the
            // pointerdown was cancelled; pin it to the value we computed.
            input.value = controls.get(p.key).value;
            return;
        }
        let v = quantize(Number(input.value), p.step);
        if (p.detent !== undefined && Math.abs(v - p.def) <= p.detent) v = p.def;
        setParam(p, v);
    });

    // --- drag: we own every pointer drag so Shift can be pressed or released
    // at any point mid-drag (DAW style). Modes:
    //   absolute  plain drag from pointerdown: thumb tracks the pointer like
    //             the native slider, snapped to `step` with the default detent
    //   fine      Shift held: relative, 10× slower, `fine` resolution
    //   relative  Shift released after a fine stretch: relative at coarse
    //             speed so the thumb doesn't jump back under the pointer
    // mousedown is cancelled as well as pointerdown because browsers differ
    // on which one starts the native thumb drag.
    input.addEventListener('mousedown', e => { if (e.button === 0) e.preventDefault(); });
    input.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) { setParam(p, p.def); return; }
        input.focus({ preventScroll: true });
        try { input.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        input.dataset.fineDrag = '1';

        const rect = input.getBoundingClientRect();
        const THUMB = 16;                                   // native thumb width, approx
        const usable = Math.max(1, rect.width - THUMB);
        const perPx = (p.max - p.min) / usable;
        const fromX = x => p.min + (x - rect.left - THUMB / 2) / usable * (p.max - p.min);
        const coarse = v => {
            v = quantize(v, p.step);
            if (p.detent !== undefined && Math.abs(v - p.def) <= p.detent) v = p.def;
            return v;
        };

        let mode = 'absolute';
        let anchorX = 0, anchorV = 0;
        const rearm = (ev, next) => {
            mode = next;
            anchorX = ev.clientX;
            anchorV = controls.get(p.key).value;
            input.classList.toggle('fine-drag', mode === 'fine');
        };
        const apply = ev => {
            if (ev.shiftKey && mode !== 'fine') rearm(ev, 'fine');
            else if (!ev.shiftKey && mode === 'fine') rearm(ev, 'relative');
            if (mode === 'absolute')      setParam(p, coarse(fromX(ev.clientX)));
            else if (mode === 'relative') setParam(p, coarse(anchorV + (ev.clientX - anchorX) * perPx));
            else                          setParam(p, anchorV + (ev.clientX - anchorX) * perPx * 0.1);
        };
        // Shift pressed/released without moving the mouse must re-anchor too.
        let lastEv = e;
        const key = ev => { if (ev.key === 'Shift') apply({ clientX: lastEv.clientX, shiftKey: ev.type === 'keydown' }); };
        const move = ev => { ev.preventDefault(); lastEv = ev; apply(ev); };
        const up = () => {
            delete input.dataset.fineDrag;
            input.classList.remove('fine-drag');
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
            window.removeEventListener('keydown', key, true);
            window.removeEventListener('keyup', key, true);
            input.value = controls.get(p.key).value;
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        window.addEventListener('keydown', key, true);
        window.addEventListener('keyup', key, true);
        apply(e);
    });
    input.addEventListener('dblclick', () => setParam(p, p.def));

    // --- keyboard: arrows = step, Shift = fine (override native fine step) ---
    input.addEventListener('keydown', e => {
        const dir = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 1
                  : (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ? -1 : 0;
        if (dir) { e.preventDefault(); nudge(p, dir, e.shiftKey); return; }
        if (e.key === 'Home') { e.preventDefault(); setParam(p, p.min); }
        if (e.key === 'End')  { e.preventDefault(); setParam(p, p.max); }
    });

    // --- wheel over the whole row ---
    row.addEventListener('wheel', e => {
        e.preventDefault();
        const dir = e.deltaY < 0 || e.deltaX > 0 ? 1 : -1;
        nudge(p, dir, e.shiftKey);
    }, { passive: false });

    // --- value field: type, nudge, scrub ---
    const commit = () => {
        const v = parseTyped(p, field.value);
        if (Number.isFinite(v)) setParam(p, v);
        field.value = fmt(p, controls.get(p.key).value);
    };
    field.addEventListener('focus', () => { field.select(); });
    field.addEventListener('blur', commit);
    field.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); field.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); field.value = fmt(p, controls.get(p.key).value); field.blur(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(p, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
            field.value = fmt(p, controls.get(p.key).value);
            field.select();
        }
    });
    field.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); setParam(p, p.def); return; }
        const startX = e.clientX, startV = controls.get(p.key).value;
        let scrubbing = false;
        const PX_PER_STEP = 4;
        const move = ev => {
            const dx = ev.clientX - startX;
            if (!scrubbing && Math.abs(dx) < 3) return;
            if (!scrubbing) { scrubbing = true; try { field.setPointerCapture(e.pointerId); } catch { /* synthetic */ } field.blur(); field.classList.add('scrubbing'); }
            const q = ev.shiftKey ? p.fine : p.step;
            setParam(p, startV + Math.trunc(dx / PX_PER_STEP) * q);
            field.value = fmt(p, controls.get(p.key).value);
        };
        const up = () => {
            field.removeEventListener('pointermove', move);
            field.removeEventListener('pointerup', up);
            field.removeEventListener('pointercancel', up);
            if (scrubbing) field.classList.remove('scrubbing');
        };
        field.addEventListener('pointermove', move);
        field.addEventListener('pointerup', up);
        field.addEventListener('pointercancel', up);
    });
    field.addEventListener('dblclick', e => { e.preventDefault(); setParam(p, p.def); field.value = fmt(p, p.def); });

    row.append(input, list, field);
    field.value = fmt(p, current);
}

function buildSelect(p, row, current) {
    const input = document.createElement('select');
    input.className = 'retro-select';
    input.id = `mixer-${p.key}`;
    for (const [value, text] of p.options) {
        const o = document.createElement('option');
        o.value = String(value);
        o.textContent = text;
        input.appendChild(o);
    }
    input.value = String(current);
    input.setAttribute('aria-label', p.label);
    controls.set(p.key, { input, field: null, value: current });
    input.addEventListener('input', () => {
        const opt = p.options.find(([v]) => String(v) === input.value);
        setParam(p, opt ? opt[0] : p.def);
    });
    const spacer = document.createElement('span');
    row.append(input, spacer);
}

function buildRow(p, current) {
    const row = document.createElement('div');
    row.className = `mixer-row mixer-${p.type}`;
    row.title = p.hint || '';
    rows.set(p.key, row);

    const label = document.createElement('label');
    label.className = 'mixer-label';
    label.htmlFor = `mixer-${p.key}`;
    label.textContent = p.label;
    row.appendChild(label);

    if (p.type === 'select') buildSelect(p, row, current);
    else buildRange(p, row, current);
    return row;
}

function buildPanel() {
    const cfg = savedRenderConfig();
    panelEl.innerHTML = '';
    controls.clear();

    const head = document.createElement('div');
    head.className = 'mixer-head';
    head.innerHTML = `<span class="mixer-title"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Playback parameters</span>
        <span class="mixer-note">drag · hold <kbd>Shift</kbd> while dragging for fine · wheel / arrows nudge · click a value to type · double-click resets</span>`;
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'retro-button retro-button-icon mixer-reset';
    reset.title = 'Reset all to defaults';
    reset.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i> <span class="btn-label">Reset</span>';
    reset.addEventListener('click', resetAll);
    head.appendChild(reset);
    panelEl.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'mixer-grid';
    for (const p of PARAMS) {
        const ui = p.type === 'select' ? cfg[p.key] : clamp(p, quantize(fromEngine(p, cfg[p.key]), p.fine));
        grid.appendChild(buildRow(p, ui));
    }
    panelEl.appendChild(grid);
    refreshInert();
    mountRenderControls(panelEl);
}

export function resetAll() {
    for (const p of PARAMS) setParam(p, p.def, { save: false });
    persist();
}

export function isMixerOpen() {
    return Boolean(panelEl && !panelEl.hidden);
}

export function setMixerOpen(open) {
    if (!panelEl) return;
    panelEl.hidden = !open;
    toggleBtn?.setAttribute('aria-pressed', String(open));
    toggleBtn?.classList.toggle('active', open);
    prefs.showMixer = open;
    // Panel height changes the space left for the tracker grid.
    requestAnimationFrame(() => relayoutTracker());
}

export function toggleMixer() {
    setMixerOpen(!isMixerOpen());
}

export function initMixer() {
    panelEl = $('#mixerPanel');
    toggleBtn = $('#toggle-mixer');
    if (!panelEl) return;
    buildPanel();
    toggleBtn?.addEventListener('click', toggleMixer);
    setMixerOpen(Boolean(prefs.showMixer));
    // Mark rows that can't affect the loaded module (metadata "type").
    playerState.player?.onMetadata(meta => setModuleType(meta?.type));
    if (playerState.meta?.type) setModuleType(playerState.meta.type);
    refreshInert();
}
