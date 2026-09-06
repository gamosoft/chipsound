// Render-to-file: exports the loaded module as a WAV using the current mixer
// settings, channel mutes and subsong. The heavy lifting happens in
// render-worker.js (a second libopenmpt instance), so playback is unaffected.

import { $ } from './dom.js';
import { prefs } from './prefs.js';
import { playerState } from './state.js';
import { toast } from './toast.js';

const MAX_SECONDS = 30 * 60;

let worker = null;      // render-worker (libopenmpt → PCM)
let encoder = null;     // encode-worker (PCM → WAV)
let ui = null;   // { root, rate, format, loops, button, cancel, bar, status }

// value → label; the encode worker switches on the value.
export const FORMATS = [
    ['wav16',    'WAV 16-bit'],
    ['wav32f',   'WAV 32-bit float'],
];

export function isRendering() {
    return worker !== null || encoder !== null;
}

function fmtTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function baseName() {
    const name = playerState.fileName || playerState.meta?.title || 'module';
    return String(name).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'module';
}

function setBusy(busy) {
    ui.button.disabled = busy || !playerState.player?.buffer;
    ui.cancel.hidden = !busy;
    ui.bar.hidden = !busy;
    ui.root.classList.toggle('rendering', busy);
    if (!busy) ui.bar.value = 0;
}

export function refreshRenderAvailability() {
    if (!ui) return;
    if (!isRendering()) ui.button.disabled = !playerState.player?.buffer;
}

function readSettings() {
    const s = {
        sampleRate: Number(ui.rate.value) || 48000,
        format: FORMATS.some(([v]) => v === ui.format.value) ? ui.format.value : 'wav16',
        loops: Math.max(0, Math.min(16, Math.floor(Number(ui.loops.value) || 0))),
    };
    prefs.renderFile = s;
    return s;
}

export function startRender() {
    const player = playerState.player;
    if (!player?.buffer) { toast('Load a module first', { variant: 'error' }); return; }
    if (isRendering()) return;

    const settings = readSettings();
    const subsongSel = $('#subsong');
    const subsong = subsongSel && !subsongSel.hidden && subsongSel.value !== '' ? Number(subsongSel.value) : -1;

    worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    const started = performance.now();
    setBusy(true);
    ui.status.textContent = 'Starting…';

    worker.onmessage = ({ data }) => {
        if (data.cmd === 'progress') {
            if (data.total > 0) {
                ui.bar.max = data.total;
                ui.bar.value = Math.min(data.seconds, data.total);
                ui.status.textContent = `Rendering ${fmtTime(data.seconds)} / ${fmtTime(data.total)}`;
            } else {
                ui.bar.removeAttribute('value');
                ui.status.textContent = `Rendering ${fmtTime(data.seconds)}`;
            }
        } else if (data.cmd === 'done') {
            worker.terminate();
            worker = null;
            encodePcm(data, settings, started);
        } else if (data.cmd === 'error') {
            ui.status.textContent = `Render failed: ${data.message}`;
            toast(`Render failed: ${data.message}`, { variant: 'error', duration: 6000 });
            finish();
        }
    };
    worker.onerror = e => {
        ui.status.textContent = `Render failed: ${e.message || 'worker error'}`;
        toast('Render failed (worker error)', { variant: 'error', duration: 6000 });
        finish();
    };

    // Structured clone — the player keeps its own copy.
    worker.postMessage({
        cmd: 'render',
        buffer: player.buffer,
        config: player.config,
        mutes: [...playerState.mutedChannels],
        subsong,
        maxSeconds: MAX_SECONDS,
        ...settings,
    });
}

function encodePcm(pcm, settings, started) {
    ui.status.textContent = 'Encoding…';
    ui.bar.max = pcm.left.length;
    ui.bar.value = 0;
    encoder = new Worker(new URL('./encode-worker.js', import.meta.url));
    encoder.onmessage = ({ data }) => {
        if (data.cmd === 'progress') {
            ui.bar.max = data.total;
            ui.bar.value = data.done;
            ui.status.textContent = `Encoding ${Math.round(100 * data.done / data.total)}%`;
        } else if (data.cmd === 'done') {
            const elapsed = ((performance.now() - started) / 1000).toFixed(1);
            const name = `${baseName()}.${data.ext}`;
            const blob = new Blob([data.bytes], { type: data.mime });
            download(blob, name);
            const mb = (blob.size / 1048576).toFixed(1);
            ui.status.textContent = `${name} · ${fmtTime(pcm.seconds)} · ${mb} MB · ${elapsed}s` + (pcm.truncated ? ' · truncated at 30 min' : '');
            toast(`Rendered ${name}`, { duration: 4000 });
            finish();
        } else if (data.cmd === 'error') {
            ui.status.textContent = `Encode failed: ${data.message}`;
            toast(`Encode failed: ${data.message}`, { variant: 'error', duration: 6000 });
            finish();
        }
    };
    encoder.onerror = e => {
        ui.status.textContent = `Encode failed: ${e.message || 'worker error'}`;
        toast('Encode failed (worker error)', { variant: 'error', duration: 6000 });
        finish();
    };
    encoder.postMessage({
        cmd: 'encode',
        format: settings.format,
        sampleRate: settings.sampleRate,
        left: pcm.left,
        right: pcm.right,
    }, [pcm.left.buffer, pcm.right.buffer]);
}

export function cancelRender() {
    if (!isRendering()) return;
    finish();
    ui.status.textContent = 'Cancelled';
}

function finish() {
    worker?.terminate();
    worker = null;
    encoder?.terminate();
    encoder = null;
    setBusy(false);
}

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function select(id, label, options, current) {
    const wrap = document.createElement('label');
    wrap.className = 'render-field';
    wrap.innerHTML = `<span>${label}</span>`;
    const sel = document.createElement('select');
    sel.className = 'retro-select';
    sel.id = id;
    for (const [v, text] of options) {
        const o = document.createElement('option');
        o.value = String(v); o.textContent = text;
        sel.appendChild(o);
    }
    sel.value = String(current);
    wrap.appendChild(sel);
    return [wrap, sel];
}

// Builds the export row inside the mixer panel.
export function mountRenderControls(parent) {
    const saved = { sampleRate: 48000, format: 'wav16', loops: 0, ...(prefs.renderFile || {}) };

    const root = document.createElement('div');
    root.className = 'render-row';

    const title = document.createElement('span');
    title.className = 'render-title';
    title.innerHTML = '<i class="fa-solid fa-file-export" aria-hidden="true"></i> Render to file';

    const [rateWrap, rate] = select('render-rate', 'Rate', [[44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']], saved.sampleRate);
    const [formatWrap, format] = select('render-format', 'Format', FORMATS, saved.format);

    const loopsWrap = document.createElement('label');
    loopsWrap.className = 'render-field';
    loopsWrap.title = 'Extra times to repeat the song in the file (0 = play once)';
    loopsWrap.innerHTML = '<span>Loops</span>';
    const loops = document.createElement('input');
    loops.type = 'number'; loops.min = 0; loops.max = 16; loops.step = 1;
    loops.id = 'render-loops';
    loops.className = 'retro-select render-loops';
    loops.value = String(saved.loops);
    loopsWrap.appendChild(loops);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'retro-button render-button';
    button.title = 'Render the loaded module to a file with the current settings and mutes';
    button.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i> <span class="btn-label">Render</span>';
    button.addEventListener('click', startRender);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'retro-button render-cancel';
    cancel.hidden = true;
    cancel.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i> <span class="btn-label">Cancel</span>';
    cancel.addEventListener('click', cancelRender);

    const bar = document.createElement('progress');
    bar.className = 'render-progress';
    bar.hidden = true;
    bar.max = 1; bar.value = 0;

    const status = document.createElement('span');
    status.className = 'render-status';
    status.setAttribute('aria-live', 'polite');

    root.append(title, formatWrap, rateWrap, loopsWrap, button, cancel, bar, status);
    parent.appendChild(root);

    ui = { root, rate, format, loops, button, cancel, bar, status };
    refreshRenderAvailability();
    return root;
}
