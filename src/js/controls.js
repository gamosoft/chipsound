// Buttons, drag-drop, channel mute / solo, subsong & viz pickers, volume.

import { $, on, setText, setEnabled } from './dom.js';
import { playerState } from './state.js';
import { prefs } from './prefs.js';
import { toast, hideToast } from './toast.js';
import { recordRecent, closeLibrary } from './library.js';
import { playList, addToPlaylist, playlistLength, skipTrack } from './playlist.js';
import {
    clearSampleHighlights,
    resetTracker,
    renderTracker,
    toggleSamplesVisible,
    toggleVisualizationsVisible,
    refreshMutedChannelsAttribute,
    jumpToOrder,
    getCurrentOrder,
} from './tracker.js';
import { clearVisualizations, availableVisualizations, visualizationNames } from './viz-engine.js';
import { openHelp } from './help.js';
import { setMediaSessionPlaybackState, setMediaSessionMetadata } from './media-session.js';
import { placeholderMeta } from './placeholder.js';

const ACCEPTED_EXTENSIONS = ['.mod', '.s3m', '.xm', '.it'];

function isAcceptedFile(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    return ACCEPTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function filenameFromUrl(url) {
    try {
        const u = new URL(url, location.href);
        const path = u.pathname.replace(/\/+$/, '');
        const last = path.split('/').pop();
        if (last) return decodeURIComponent(last);
    } catch { /* not a URL — fall through */ }
    const last = url.split(/[?#]/)[0].split('/').pop() || url;
    try { return decodeURIComponent(last); } catch { return last; }
}

// RFC 5987 `filename*=` takes precedence over plain `filename=`.
function filenameFromContentDisposition(header) {
    if (!header) return null;
    const ext = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
    if (ext) {
        try { return decodeURIComponent(ext[1].trim()); } catch { /* fall through */ }
    }
    const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header);
    if (plain) return (plain[1] || plain[2] || '').trim() || null;
    return null;
}

// host + first numeric/string query value, e.g. "modarchive.org #212083".
function urlDisplayLabel(url) {
    try {
        const u = new URL(url, location.href);
        const host = u.hostname.replace(/^(api|www)\./, '');
        let id = null;
        for (const [, v] of u.searchParams) {
            if (/^\d+$/.test(v)) { id = v; break; }
        }
        if (!id) {
            for (const [, v] of u.searchParams) {
                if (v) { id = v.length > 16 ? v.slice(0, 16) + '…' : v; break; }
            }
        }
        return id ? `${host} #${id}` : host;
    } catch {
        return '';
    }
}

let onPlayStart = () => {};
let onPlayStop = () => {};
let onPauseHook = () => {};
let onVizChange = () => {};

// Resolved from prefs.vizId once discovery completes; see wireVizPicker.
let currentVizIndex = 0;
export let displayedVisualizations = [];

export function getCurrentVisualizations() {
    return displayedVisualizations;
}

const PLAYING = 'playing';
const PAUSED = 'paused';
const STOPPED = 'stopped';

function updateButtonsUI(state) {
    const play = $('#play');
    const playing = state === PLAYING;
    play.classList.toggle('playing', playing);
    play.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
    setEnabled($('#stop'), state !== STOPPED);
}

// MediaSession's vocab is a 3-way that maps cleanly onto our own.
const MEDIA_SESSION_STATE = {
    [PLAYING]: 'playing',
    [PAUSED]: 'paused',
    [STOPPED]: 'none',
};

// Single source of truth for playback transitions.
export function setPlaybackState(next) {
    playerState.isPlaying = next === PLAYING;
    playerState.isPaused = next === PAUSED;
    updateButtonsUI(next);
    setMediaSessionPlaybackState(MEDIA_SESSION_STATE[next] ?? 'none');

    if (next === PLAYING) {
        onPlayStart();
    } else if (next === PAUSED) {
        onPauseHook();
    } else {
        onPlayStop();
        clearSampleHighlights();
        playerState.pendingJumpOrder = null;
        if (playerState.meta) resetTracker(playerState.meta);
    }
}

// setPlaying(false) === setPlaybackState(STOPPED).
export function setPlaying(value) {
    setPlaybackState(value ? PLAYING : STOPPED);
}

// Stop omitted (setPlaybackState). vizPicker too — see syncVizControlEnabled.
const SONG_DEPENDENT_CONTROLS = [
    '#play', '#previous', '#next',
    '#toggle-visualizations', '#toggle-samples',
];

let songLoaded = false;

export function setControlsAvailable(enabled) {
    songLoaded = !!enabled;
    for (const sel of SONG_DEPENDENT_CONTROLS) setEnabled($(sel), enabled);
    syncVizControlEnabled();
}

function hasLiveModule() {
    return Boolean(playerState.meta?.song) && playerState.meta.isPlaceholder !== true;
}

// Worklet load/metadata is async. Unload bumps loadEpoch without posting, so
// a late onMetadata / onEnded from the discarded module can be ignored.
let loadEpoch = 0;
let postedEpoch = 0;

function notePostedLoad() {
    postedEpoch = ++loadEpoch;
}

export function isStaleModuleEvent() {
    return loadEpoch !== postedEpoch;
}

// Playlist is empty: back to the boot player (placeholder grid, no module).
export function unloadLiveModule() {
    loadEpoch++;
    abortInFlightUrlLoad();
    pendingFile = null;
    autoPlayOnNextLoad = false;
    playerState.player?.stop();
    playerState.fileName = '';
    setText('#fileName', '');
    playerState.meta = placeholderMeta();
    playerState.modpos = {};
    playerState.pendingJumpOrder = null;
    setPlaying(false);
    setControlsAvailable(false);
    renderTracker(playerState.meta);
    refreshSubsongSelector(null);
    setMediaSessionMetadata({ title: '', fileName: '' });
    hideToast();
}

export function initControls({ onTick, onIdle, onPause, onVizChange: vizChangeCb }) {
    onPlayStart = onTick;
    onPlayStop = onIdle;
    onPauseHook = onPause || onIdle;
    onVizChange = vizChangeCb || (() => {});

    wireFileInput();
    wireDragAndDrop();
    wireButtons();
    wireChannelMuteDelegation();
    wireSubsongSelector();
    wireVizPicker();
    wireVolumeSlider();
    applyInitialToggles();
}

// Stashed until the worklet finishes addModule() — see flushPendingLoad.
let pendingFile = null;
let autoPlayOnNextLoad = false;

function isWorkletReady() {
    return Boolean(playerState.player?.processNode);
}

export function loadFile(file, { autoPlay = true } = {}) {
    if (!file) return;
    if (!isAcceptedFile(file.name)) {
        toast(`Unsupported file type: ${file.name}`, { variant: 'warn' });
        return;
    }

    closeLibrary();
    recordRecent({ url: 'local:' + file.name, name: file.name, file });

    // Supersede any in-flight URL load — without this, a slow Modarchive
    // fetch (or its scheduled retry) keeps running in the background and
    // would later overwrite the file the user just picked.
    abortInFlightUrlLoad();

    // Only flip to STOPPED when we genuinely won't be playing. If autoPlay is
    // true, holding the prior PLAYING state through the worklet hand-off
    // avoids a misleading STOPPED flash while the old song is still rendering.
    if (!autoPlay) setPlaying(false);
    setControlsAvailable(false);
    playerState.fileName = file.name;
    setText('#fileName', file.name);
    autoPlayOnNextLoad = autoPlay;

    if (isWorkletReady()) {
        notePostedLoad();
        playerState.player.load(file);
    } else {
        pendingFile = file;
    }
}

// `?load=<url>`. We fetch directly (instead of via chiptune3.load) to read
// Content-Disposition, sniff Content-Type, cap size, and bound the wait time.
// libopenmpt format-sniffs the bytes, so URL extension is not gated.
const MAX_URL_LOAD_BYTES = 32 * 1024 * 1024;
const URL_LOAD_TIMEOUT_MS = 45_000;
const FETCH_RETRY_DELAY_MS = 500;
const TOAST_URL_MAX_LEN = 64;

function isAbortLike(e) {
    return e?.name === 'TimeoutError' || e?.name === 'AbortError';
}

// Shrinks a long URL down to "host #id" (urlDisplayLabel) when possible,
// otherwise to a head…tail ellipsis so the loading toast stays readable on
// narrow mobile viewports. Full URL still goes to the console / address bar.
function urlForToast(url) {
    const label = urlDisplayLabel(url);
    if (label) return label;
    if (url.length <= TOAST_URL_MAX_LEN) return url;
    const head = Math.floor((TOAST_URL_MAX_LEN - 1) * 0.6);
    const tail = TOAST_URL_MAX_LEN - 1 - head;
    return url.slice(0, head) + '\u2026' + url.slice(-tail);
}

// Tracks any in-flight URL load so a subsequent loadFile / loadFromUrl /
// drag-drop aborts it. Without this, a slow upstream (e.g. Modarchive at
// peak) can outrun the user's next action and overwrite the new selection
// when its bytes finally arrive — the more annoying half of which is the
// retry below still ticking 21 + 0.5 + 21 seconds in the background.
let urlLoadAbort = null;

function abortInFlightUrlLoad() {
    if (!urlLoadAbort) return;
    urlLoadAbort.abort();
    urlLoadAbort = null;
}

// Promise that resolves after `ms` or rejects with AbortError when `signal`
// fires. Used by fetchWithRetry's between-attempts wait so a superseding load
// cancels the retry instead of forcing the user to wait through another 21s
// TCP timeout for an attempt nobody cares about anymore.
function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// One-shot retry on transient network errors. Timeout / explicit aborts are
// NOT retried — those are user-visible budget exceeded. HTTP error statuses
// are not retried either (they're deterministic; the caller surfaces them).
async function fetchWithRetry(url, signal) {
    try {
        return await fetch(url, { signal });
    } catch (e) {
        if (isAbortLike(e)) throw e;
        if (signal.aborted) throw e;
        await abortableDelay(FETCH_RETRY_DELAY_MS, signal);
        return await fetch(url, { signal });
    }
}

// Returns 'ok' | 'fail' | 'aborted' so the playlist can skip a dead URL
// without treating a superseded load as a hard error.
export async function loadFromUrl(url, { autoPlay = true, name = null } = {}) {
    if (!url) return 'fail';

    // Supersede any previous in-flight URL load.
    abortInFlightUrlLoad();

    // Two reasons we'd abort: user moved on (silent) and timeout (toast).
    // Distinguishing them after the fact is awkward (both surface as
    // AbortError), so we set a flag from the timeout path.
    const controller = new AbortController();
    urlLoadAbort = controller;
    let timedOut = false;
    const timeoutTimer = setTimeout(() => { timedOut = true; controller.abort(); }, URL_LOAD_TIMEOUT_MS);

    const isCurrent = () => urlLoadAbort === controller;
    // Superseded loads stay silent — the new load already owns the toast.
    const surfaceAbort = (e, fallback) => {
        if (e?.name === 'AbortError' && !timedOut) return;
        toast((timedOut || isAbortLike(e)) ? 'URL load timed out' : fallback,
              { variant: 'error', duration: 5000 });
    };

    // Single try/finally so the timer + tracker are released on every exit
    // path — including future edits that introduce a new early return or
    // throw. Without this, every `return` would have to remember to call
    // cleanup() and any miss leaks the controller + a 45s setTimeout.
    try {
        // Sticky info toast for the duration of the fetch. Any error toast below
        // supersedes it; hideToast() is called once the buffer reaches the worklet.
        toast(`Loading: ${urlForToast(url)}`, { variant: 'info', duration: 0 });

        let response;
        try {
            response = await fetchWithRetry(url, controller.signal);
        } catch (e) {
            if (e?.name === 'AbortError' && !timedOut) return 'aborted';
            surfaceAbort(e, 'Could not load URL');
            return 'fail';
        }
        if (!isCurrent()) return 'aborted';
        if (!response.ok) {
            toast(`Could not load URL (HTTP ${response.status})`, { variant: 'error', duration: 5000 });
            return 'fail';
        }

        const ctype = (response.headers.get('Content-Type') || '').toLowerCase();
        if (ctype.startsWith('text/html') || ctype.startsWith('text/plain') || ctype.startsWith('application/json')) {
            toast(`URL did not return a module (${ctype || 'unknown type'})`, { variant: 'warn' });
            return 'fail';
        }

        const declared = parseInt(response.headers.get('Content-Length') || '0', 10);
        if (declared > MAX_URL_LOAD_BYTES) {
            toast(`File too large: ${(declared / 1024 / 1024).toFixed(1)} MB`, { variant: 'warn' });
            return 'fail';
        }

        let buffer;
        try {
            buffer = await response.arrayBuffer();
        } catch (e) {
            if (e?.name === 'AbortError' && !timedOut) return 'aborted';
            surfaceAbort(e, 'Connection lost while loading URL');
            return 'fail';
        }
        if (!isCurrent()) return 'aborted';

        if (buffer.byteLength > MAX_URL_LOAD_BYTES) {
            toast(`File too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`, { variant: 'warn' });
            return 'fail';
        }

        // Resolve a *meaningful* filename. Accept the source's own name only when
        // it looks like a module file (right extension); otherwise fall back to a
        // URL-derived host+id label so the Filename field stays informative even
        // for endpoint URLs (e.g. Modarchive hides Content-Disposition behind CORS
        // and the path is just "/downloads.php").
        const headerName = filenameFromContentDisposition(response.headers.get('Content-Disposition'));
        const urlName = filenameFromUrl(url);
        // A caller-supplied name wins only when it looks like a module file
        // (curated `2nd_pm.s3m`). Hints like `#212083` from ?modarchive= fall
        // through so Content-Disposition / URL labels can win.
        const filename = (name && isAcceptedFile(name))             ? name
                       : (headerName && isAcceptedFile(headerName)) ? headerName
                       : (urlName && isAcceptedFile(urlName))       ? urlName
                       : urlDisplayLabel(url) || name;
        recordRecent({ url, name: filename });

        if (!autoPlay) setPlaying(false);
        setControlsAvailable(false);
        playerState.fileName = filename;
        setText('#fileName', filename);
        autoPlayOnNextLoad = autoPlay;
        hideToast();
        notePostedLoad();
        playerState.player.loadBuffer(buffer);
        return 'ok';
    } finally {
        clearTimeout(timeoutTimer);
        if (urlLoadAbort === controller) urlLoadAbort = null;
    }
}

export function flushPendingLoad() {
    if (!pendingFile || !isWorkletReady()) return;
    const file = pendingFile;
    pendingFile = null;
    notePostedLoad();
    playerState.player.load(file);
}

export function onSongLoaded() {
    if (!autoPlayOnNextLoad) return;
    autoPlayOnNextLoad = false;
    if (!playerState.player || !playerState.meta?.song) return;
    playerState.player.play();
    setPlaybackState(PLAYING);
}

function wireFileInput() {
    const input = $('#files');
    input.addEventListener('change', evt => {
        const files = [...(evt.target.files || [])];
        if (files.length) ingestFiles(files, { replace: true });
        // Same input can pick the same file again after a cancel / re-open.
        input.value = '';
    });
}

export function pickLocalFile() {
    $('#files')?.click();
}

// Track dragenter/leave depth — dragleave fires across every child boundary.
function wireDragAndDrop() {
    const body = document.body;
    let dragDepth = 0;

    const hasFile = e => {
        const types = e.dataTransfer?.types;
        if (!types) return false;
        for (const t of types) if (t === 'Files') return true;
        return false;
    };

    document.addEventListener('dragenter', e => {
        if (!hasFile(e)) return;
        e.preventDefault();
        dragDepth++;
        body.classList.add('drag-over');
    });
    document.addEventListener('dragleave', e => {
        if (!hasFile(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) body.classList.remove('drag-over');
    });
    document.addEventListener('dragover', e => {
        if (!hasFile(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', e => {
        if (!hasFile(e)) return;
        e.preventDefault();
        dragDepth = 0;
        body.classList.remove('drag-over');
        const replace = e.shiftKey || !dropAddsToPlaylist();
        void collectDropFiles(e.dataTransfer).then(files => {
            if (files.length) ingestFiles(files, { replace });
        });
    });
}

const PLAYLIST_CAP = 100;
const MAX_FOLDER_DEPTH = 3;

function dropAddsToPlaylist() {
    if (playerState.isPlaying || playerState.isPaused) return true;
    return playlistLength() > 0;
}

function ingestFiles(files, { replace }) {
    const accepted = [];
    let rejected = 0;
    let capped = false;
    for (const file of files) {
        if (accepted.length >= PLAYLIST_CAP) { capped = true; break; }
        if (isAcceptedFile(file.name)) accepted.push(file);
        else rejected++;
    }
    if (!accepted.length) {
        const name = files[0]?.name;
        toast(name ? `Unsupported file type: ${name}` : 'No modules in that drop', { variant: 'warn' });
        return;
    }

    const items = accepted.map(file => ({ file, name: file.name }));
    const notes = [];
    if (rejected) notes.push(`skipped ${rejected}`);
    if (capped) notes.push(`capped at ${PLAYLIST_CAP}`);
    const extra = notes.length ? `, ${notes.join(', ')}` : '';

    if (replace) {
        void playList(items, { autoPlay: true });
        if (extra) toast(`Playing ${accepted.length}${extra}`, { variant: 'warn' });
        return;
    }

    addToPlaylist(items);
    const n = playlistLength();
    const added = accepted.length === 1 ? accepted[0].name : `${accepted.length} tracks`;
    toast(`Added to playlist: ${added}${extra} · ${n} total`, { variant: 'info' });
}

async function collectDropFiles(dt) {
    const items = dt?.items;
    if (items?.length && typeof items[0].webkitGetAsEntry === 'function') {
        const collected = [];
        const jobs = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry();
            if (entry) jobs.push(walkEntry(entry, collected, 0));
        }
        await Promise.all(jobs);
        if (collected.length) return collected;
    }
    return [...(dt?.files || [])];
}

function entryFile(entry) {
    return new Promise(resolve => {
        entry.file(resolve, () => resolve(null));
    });
}

function readAllEntries(dirEntry) {
    const reader = dirEntry.createReader();
    const all = [];
    const next = () => new Promise(resolve => {
        reader.readEntries(resolve, () => resolve([]));
    });
    return (async () => {
        for (;;) {
            const batch = await next();
            if (!batch.length) return all;
            all.push(...batch);
        }
    })();
}

async function walkEntry(entry, out, depth) {
    if (!entry || out.length >= PLAYLIST_CAP) return;
    if (entry.isFile) {
        const file = await entryFile(entry);
        if (file) out.push(file);
        return;
    }
    if (!entry.isDirectory || depth >= MAX_FOLDER_DEPTH) return;
    const children = await readAllEntries(entry);
    for (const child of children) {
        if (out.length >= PLAYLIST_CAP) return;
        await walkEntry(child, out, depth + 1);
    }
}

function wireButtons() {
    // Three-way: stopped → play; playing → pause; paused → unpause.
    $('#play').addEventListener('click', () => {
        if (!hasLiveModule()) {
            toast('Load a module first', { variant: 'warn' });
            return;
        }
        if (playerState.isPlaying) {
            playerState.player.pause();
            setPlaybackState(PAUSED);
        } else if (playerState.isPaused) {
            // Synchronous resume() in the gesture — iOS Safari interrupts the
            // AudioContext across the file picker / background and resume from
            // the capture-phase unlock is async; calling here too guarantees
            // the worklet has a running context before we flip paused=false.
            const ctx = playerState.player?.context;
            if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
            playerState.player.unpause();
            setPlaybackState(PLAYING);
        } else {
            const ctx = playerState.player?.context;
            if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
            playerState.player.play();
            setPlaybackState(PLAYING);
        }
    });

    $('#stop').addEventListener('click', () => {
        if (!hasLiveModule()) return;
        if (!playerState.isPlaying && !playerState.isPaused) return;
        playerState.player.stop();
        setPlaybackState(STOPPED);
    });

    $('#previous').addEventListener('click', () => skipOrOrder(-1));
    $('#next').addEventListener('click', () => skipOrOrder(+1));

    $('#toggle-visualizations').addEventListener('click', () => {
        const visible = !prefs.showVisualizations;
        prefs.showVisualizations = visible;
        toggleVisualizationsVisible(visible);
        syncVizControlEnabled();
    });

    $('#toggle-samples').addEventListener('click', () => {
        const visible = !prefs.showSamples;
        prefs.showSamples = visible;
        toggleSamplesVisible(visible);
    });

    $('#show-help')?.addEventListener('click', () => openHelp());
}

function skipOrOrder(delta) {
    // A mix is armed: the buttons mean tracks, like a deck. ←/→ stay order-level
    // so pattern study still works; Shift+←/→ is the keyboard twin of these.
    if (playlistLength() > 1) {
        skipTrack(delta);
        return;
    }
    navigateOrder(delta);
}

export function navigateOrder(delta) {
    const song = playerState.meta?.song;
    if (!song || !playerState.player || playerState.meta.isPlaceholder) return;

    const target = getCurrentOrder() + delta;
    if (target < 0 || target >= song.totalOrders) return;

    if (playerState.isPlaying) {
        jumpToOrder(song, target);
        playerState.player.setPattern(target);
        return;
    }

    const actual = jumpToOrder(song, target);
    playerState.player.setPattern(actual);
    clearVisualizations(song, getCurrentVisualizations());
}

// V key. Gates on picker disabled state. Shift+V cycles backward.
export function cycleVisualization(backward = false) {
    if (availableVisualizations.length === 0) return;
    const picker = $('#vizPicker');
    if (picker && picker.disabled) return;
    const delta = backward ? -1 : 1;
    const n = availableVisualizations.length;
    selectVisualization((currentVizIndex + delta + n) % n);
}

function selectVisualization(index) {
    if (index < 0 || index >= availableVisualizations.length) return;
    currentVizIndex = index;
    displayedVisualizations = [availableVisualizations[currentVizIndex]];
    prefs.vizId = availableVisualizations[currentVizIndex];
    syncVizPicker();
    onVizChange(displayedVisualizations);
}

function displayNameFor(id) {
    return visualizationNames[id] ?? id;
}

function wireVizPicker() {
    const select = $('#vizPicker');
    if (!select) return;

    let html = '';
    for (let i = 0; i < availableVisualizations.length; i++) {
        html += `<option value="${i}">${displayNameFor(availableVisualizations[i])}</option>`;
    }
    select.innerHTML = html;

    // Resolve saved id against the discovered list. Renamed / removed → 0.
    if (availableVisualizations.length > 0) {
        const savedId = prefs.vizId;
        const found = savedId ? availableVisualizations.indexOf(savedId) : -1;
        currentVizIndex = found >= 0 ? found : 0;
        displayedVisualizations = [availableVisualizations[currentVizIndex]];
        prefs.vizId = availableVisualizations[currentVizIndex];
    }

    syncVizPicker();
    syncVizControlEnabled();

    select.addEventListener('change', () => {
        const idx = Number(select.value);
        if (Number.isNaN(idx)) return;
        selectVisualization(idx);
    });
}

function syncVizPicker() {
    const select = $('#vizPicker');
    if (!select) return;
    const value = String(currentVizIndex);
    if (select.value !== value) select.value = value;
}

// Enabled iff song loaded AND effects on. Disable (don't hide) to avoid reflow.
function syncVizControlEnabled() {
    const select = $('#vizPicker');
    if (!select) return;
    setEnabled(select, songLoaded && prefs.showVisualizations);
}

function wireChannelMuteDelegation() {
    // Three behaviours: All toggle, Ctrl/Cmd-click solo, plain-click single mute.
    on(document, 'click', '.muteable', function (e) {
        const raw = this.dataset.channel;
        if (raw === undefined) return;

        if (raw === 'all') {
            toggleAllChannels();
            return;
        }

        const channel = Number(raw);
        if (e.ctrlKey || e.metaKey) {
            toggleAllOtherChannels(channel);
        } else {
            toggleChannel(channel);
        }
    });
}

// Idempotent.
function setChannelMutedState(channel, muted) {
    if (playerState.isChannelMuted(channel) === muted) return;
    playerState.setChannelMuted(channel, muted);
    document
        .querySelectorAll(`.muteable[data-channel="${channel}"]`)
        .forEach(node => node.setAttribute('aria-pressed', muted ? 'true' : 'false'));
    playerState.player?.setChannelMute(channel, muted);
}

function toggleChannel(channel) {
    setChannelMutedState(channel, !playerState.isChannelMuted(channel));
    refreshMutedChannelsAttribute();
    refreshAllChannelsAria();
}

// If anything is unmuted, mute everything; else unmute.
function toggleAllChannels() {
    const channels = playerState.meta?.song?.channels ?? 0;
    if (!channels) return;

    let anyUnmuted = false;
    for (let i = 0; i < channels; i++) {
        if (!playerState.isChannelMuted(i)) { anyUnmuted = true; break; }
    }
    const targetMuted = anyUnmuted;
    for (let i = 0; i < channels; i++) setChannelMutedState(i, targetMuted);
    refreshMutedChannelsAttribute();
    refreshAllChannelsAria();
}

// Solo — clicked channel forced audible; others mute-first then un-solo.
function toggleAllOtherChannels(except) {
    const channels = playerState.meta?.song?.channels ?? 0;
    if (!channels) return;

    let anyOtherUnmuted = false;
    for (let i = 0; i < channels; i++) {
        if (i === except) continue;
        if (!playerState.isChannelMuted(i)) { anyOtherUnmuted = true; break; }
    }
    const targetMuted = anyOtherUnmuted;

    setChannelMutedState(except, false);
    for (let i = 0; i < channels; i++) {
        if (i === except) continue;
        setChannelMutedState(i, targetMuted);
    }
    refreshMutedChannelsAttribute();
    refreshAllChannelsAria();
}

// All button aria-pressed: true / false / mixed.
function refreshAllChannelsAria() {
    const channels = playerState.meta?.song?.channels ?? 0;
    const allBtn = document.querySelector('.muteable[data-channel="all"]');
    if (!allBtn || !channels) return;

    let mutedCount = 0;
    for (let i = 0; i < channels; i++) if (playerState.isChannelMuted(i)) mutedCount++;

    let state;
    if (mutedCount === 0) state = 'false';
    else if (mutedCount === channels) state = 'true';
    else state = 'mixed';

    allBtn.setAttribute('aria-pressed', state);
    allBtn.classList.toggle('muted', state === 'true');
}

function wireSubsongSelector() {
    const select = $('#subsong');
    if (!select) return;
    select.addEventListener('change', () => {
        const idx = Number(select.value);
        if (Number.isNaN(idx)) return;
        playerState.player?.selectSubsong(idx);
        // Surface first pattern now while stopped; worklet does it while playing.
        const song = playerState.meta?.song;
        if (song && !playerState.isPlaying) jumpToOrder(song, 0);
    });
}

export function refreshSubsongSelector(song) {
    const wrap = $('#subsongControl');
    const select = $('#subsong');
    if (!wrap || !select) return;

    const names = song?.subsongNames;
    if (!names || names.length <= 1) {
        wrap.hidden = true;
        return;
    }

    let html = '';
    for (let i = 0; i < names.length; i++) {
        html += `<option value="${i}">${names[i]}</option>`;
    }
    select.innerHTML = html;
    select.value = '0';
    wrap.hidden = false;
}

function wireVolumeSlider() {
    const slider = $('#volume');
    if (!slider) return;
    const initial = prefs.volume;
    slider.value = initial;
    slider.title = `Volume: ${initial}%`;

    slider.addEventListener('input', () => {
        const value = Number(slider.value);
        slider.title = `Volume: ${value}%`;
        prefs.volume = value;
        playerState.player?.setVol(value);
    });
}

function applyInitialToggles() {
    toggleVisualizationsVisible(prefs.showVisualizations);
    toggleSamplesVisible(prefs.showSamples);
}
