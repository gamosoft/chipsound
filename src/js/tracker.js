// Tracker UI: channel headers, pattern grid (double-buffered), sample list.

import { $, $$, el, show } from './dom.js';
import { hb, padNumber, renderNote } from './format.js';
import { playerState } from './state.js';
import {
    registerCanvas,
    clearCanvasCache,
    invalidateCanvasSizes,
} from './viz-engine.js';

// Two Sets so updateUsedSamples can swap roles each tick (no per-frame alloc).
let sampleItemsById = {};
let channelSampleId = [];
let highlightedSampleIds = new Set();
let pendingSampleIds = new Set();

// Double-buffered grids: activeGrid visible, prefetchGrid holds next pattern.
let gridA = null;
let gridB = null;
let activeGrid   = null;
let prefetchGrid = null;

let prefetchIdleHandle = -1;

let lastDrawnPattern = -1;
let lastDrawnRow = -1;

// Throttle the sample-list highlight on unchanged rows (~20 Hz).
const SAMPLE_THROTTLE_DIVISOR = 3;
let sampleUpdateCounter = 0;

let currentOrder = 0;

// Status-bar text fields are static elements in index.html — never replaced,
// just rewritten. We resolve each selector to its node on first write and
// cache it alongside the last-written text. After the first frame, the hot
// update path is one property lookup + one string compare + (when changed)
// one textContent write — zero DOM queries.
const statusFields = Object.create(null);

let scrollOffset = 18;

let trackerMainEl = null;
function getTrackerMain() {
    if (!trackerMainEl) trackerMainEl = $('.tracker-main');
    return trackerMainEl;
}

let trackerHeaderEl = null;
function getTrackerHeader() {
    if (!trackerHeaderEl) trackerHeaderEl = $('#trackerHeader');
    return trackerHeaderEl;
}

// Public: build the whole tracker for a freshly loaded song.
export function renderTracker(meta) {
    if (!meta || !meta.song) return;

    const song = meta.song;
    playerState.resetChannelMutes();

    ensureChannelMuteRules();

    resetGrids(song);
    clearCanvasCache();
    renderHeaders(song.channels);
    renderSamples(song);
    refreshMutedChannelsAttribute();

    lastDrawnPattern = -1;
    lastDrawnRow = -1;
    invalidateStatusCache();

    requestAnimationFrame(() => resetTracker(meta));
}

const MIN_CHANNEL_WIDTH = 70;

function gridTemplate(channels) {
    return `var(--row-label-col, 20px) repeat(${channels}, minmax(${MIN_CHANNEL_WIDTH}px, 1fr))`;
}

// Public: reset to the song's starting position. Drives placeholder + real loads.
export function resetTracker(meta) {
    if (!meta || !meta.song) return;
    const song = meta.song;
    const firstPattern = song.orders[0];
    const placeholder = meta.isPlaceholder === true;

    invalidateStatusCache();

    if (!placeholder) {
        writeIfChanged('#songName', meta.title || '-');
        writeIfChanged('#channels', String(song.channels));
        writeIfChanged('#samples', String(song.samples.length));

        writeIfChanged('#order', `01 / ${padNumber(song.totalOrders)}`);
        writeIfChanged('#pattern', hb(firstPattern));
        writeIfChanged('#row', '00');
        writeIfChanged('#bpm', String(song.bpm));
    }

    lastDrawnPattern = -1;
    lastDrawnRow = -1;
    currentOrder = 0;

    layoutGrids(song);
    showPattern(song, firstPattern, 0);
    clearSampleHighlights();
    updateCurrentRow(firstPattern, 0);

    if (!placeholder) {
        schedulePrefetch(song, 0);
    }
}

// Public: jump to a specific order. Returns the shown order (clamped).
export function jumpToOrder(song, targetOrder) {
    if (!song || !song.orders) return currentOrder;
    const clamped = Math.max(0, Math.min(song.totalOrders - 1, targetOrder));
    const pattern = song.orders[clamped];
    if (pattern == null) return currentOrder;

    // Keep shared state in sync so Play resumption doesn't snap back.
    const prev = playerState.modpos || {};
    playerState.modpos = {
        ...prev,
        order: clamped,
        pattern,
        row: 0,
        bpm: prev.bpm ?? song.bpm,
        chVol: prev.chVol,
    };

    // Arm the stale-pos filter in index.js#onProgress. See state.js#pendingJumpOrder.
    playerState.pendingJumpOrder = clamped;

    showPattern(song, pattern, 0);
    updateCurrentRow(pattern, 0);
    writeIfChanged('#order', `${padNumber(clamped + 1)} / ${padNumber(song.totalOrders)}`);
    writeIfChanged('#pattern', hb(pattern));
    writeIfChanged('#row', '00');

    currentOrder = clamped;
    schedulePrefetch(song, clamped);
    return clamped;
}

export function getCurrentOrder() {
    return currentOrder;
}

// Public: diagnostics — bounded by design (always 0–2). See ?diag.
export function getPatternCacheSize() {
    let n = 0;
    if (activeGrid   && activeGrid.patternIndex   !== -1) n++;
    if (prefetchGrid && prefetchGrid.patternIndex !== -1) n++;
    return n;
}

// Public: diagnostics — bounded (0 or 1).
export function getRenderQueueSize() {
    return prefetchIdleHandle === -1 ? 0 : 1;
}

// Public: called every animation frame while playing.
export function updateTrackerFrame(song, pos, volumes) {
    if (typeof pos.pattern !== 'number' || typeof pos.row !== 'number') return;

    // Stale-pos guard: a pos for the OUTGOING song can arrive between loads.
    if (pos.pattern < 0 || pos.pattern >= song.patterns.length) return;

    if (pos.pattern === lastDrawnPattern && pos.row === lastDrawnRow) {
        if (++sampleUpdateCounter % SAMPLE_THROTTLE_DIVISOR === 0) {
            updateUsedSamples(song, pos, volumes);
        }
        return;
    }

    if (pos.pattern !== activeGrid?.patternIndex) {
        showPattern(song, pos.pattern, pos.row);
        schedulePrefetch(song, pos.order);
    }

    updateCurrentRow(pos.pattern, pos.row);
    if (typeof pos.order === 'number') currentOrder = pos.order;
    writeIfChanged('#order', `${padNumber((pos.order ?? 0) + 1)} / ${padNumber(song.totalOrders)}`);
    writeIfChanged('#pattern', hb(pos.pattern));
    writeIfChanged('#row', hb(pos.row));
    writeIfChanged('#bpm', String(pos.bpm ?? song.bpm));

    sampleUpdateCounter = 0;
    updateUsedSamples(song, pos, volumes);
}

function writeIfChanged(selector, text) {
    let slot = statusFields[selector];
    if (slot === undefined) {
        const node = $(selector);
        if (!node) return;
        slot = statusFields[selector] = { node, lastText: null };
    }
    if (slot.lastText === text) return;
    slot.lastText = text;
    slot.node.textContent = text;
}

function invalidateStatusCache() {
    for (const k in statusFields) statusFields[k].lastText = null;
}

export function clearSampleHighlights() {
    for (const id of highlightedSampleIds) {
        sampleItemsById[id]?.classList.remove('highlighted');
    }
    highlightedSampleIds.clear();
    for (let i = 0; i < channelSampleId.length; i++) channelSampleId[i] = null;
}

// Public: funnel for layout-affecting changes (resize, theme/viz/samples toggle).
export function relayoutTracker() {
    if (!playerState.meta || !playerState.meta.song) return;
    layoutGrids(playerState.meta.song);

    if (activeGrid && activeGrid.el) {
        const rowLabel = activeGrid.el.querySelector('.row-label');
        if (rowLabel?.offsetHeight) scrollOffset = rowLabel.offsetHeight;
    }

    refreshPatternPadding();
    invalidateCanvasSizes();

    if (activeGrid && activeGrid.patternIndex !== -1 && lastDrawnRow >= 0) {
        centerRow(activeGrid, lastDrawnRow);
    }
}

// Public: one attribute write — CSS does the cascade via the injected rules.
export function refreshMutedChannelsAttribute() {
    const main = getTrackerMain();
    if (!main) return;
    const muted = playerState.mutedChannels;
    if (muted.size === 0) {
        main.removeAttribute('data-muted');
        return;
    }
    let out = '';
    for (const ch of muted) out += (out ? ' ' : '') + ch;
    main.dataset.muted = out;
}

// 64 = libopenmpt channel ceiling for our formats.
let muteRulesInjected = false;
function ensureChannelMuteRules() {
    if (muteRulesInjected) return;
    muteRulesInjected = true;
    let css = '';
    for (let i = 0; i < 64; i++) {
        css += `.tracker-main[data-muted~="${i}"] [data-channel="${i}"]{opacity:.5;filter:grayscale(80%)}`;
    }
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
}

// ---- header / canvas registration --------------------------------------

function renderHeaders(channels) {
    const header = $('#trackerHeader');
    header.replaceChildren();
    header.style.display = 'none';

    // Synchronous so the next RAF measures the correct per-channel width.
    header.style.gridTemplateColumns = gridTemplate(channels);

    header.append(
        el('button', {
            type: 'button',
            class: 'header-label muteable',
            dataset: { channel: 'all', track: 'mute_all_clicked' },
            title: 'Click to mute or unmute all channels',
            'aria-label': 'Toggle all channels',
            'aria-pressed': 'false',
        }, `<i class="fa-solid fa-grip-lines-vertical header-label-icon" aria-hidden="true"></i>`),
    );

    for (let col = 0; col < channels; col++) {
        const id = `canvas${col}`;
        const button = el('button', {
            type: 'button',
            class: 'channel-cell channel-header muteable',
            dataset: { channel: col, track: 'mute_channel_clicked', trackChannel: col },
            'aria-label': `Toggle mute on channel ${col + 1}`,
            'aria-pressed': 'false',
        }, `
            <span data-col="${col}" class="channel-label">CH${col + 1}</span>
            <div class="canvas-parent">
                <canvas class="visualization-canvas" id="${id}" width="100%" height="100%"></canvas>
            </div>
        `);
        header.append(button);
    }

    header.style.display = 'grid';

    requestAnimationFrame(() => {
        for (let col = 0; col < channels; col++) {
            const canvas = document.getElementById(`canvas${col}`);
            if (canvas) registerCanvas(col, canvas);
        }
    });
}

// ---- pattern grid construction + lifecycle -----------------------------

function createEmptyGrid() {
    const elNode = document.createElement('div');
    elNode.className = 'tracker-grid';
    elNode.style.display = 'none';
    return {
        el: elNode,
        topSpacer: null,
        bottomSpacer: null,
        rows: new Map(),
        patternIndex: -1,
        rowCount: 0,
        topPx: 0,
        bottomPx: 0,
    };
}

function resetGrids(song) {
    cancelPrefetch();
    const container = $('#trackerPatterns');
    gridA = createEmptyGrid();
    gridB = createEmptyGrid();
    activeGrid   = gridA;
    prefetchGrid = gridB;
    container.replaceChildren(gridA.el, gridB.el);

    const cols = gridTemplate(song.channels);
    gridA.el.style.gridTemplateColumns = cols;
    gridB.el.style.gridTemplateColumns = cols;
}

// Synchronous (~5–20 ms typical). innerHTML is ~3× faster than createElement here.
function populateGrid(target, song, patternIndex) {
    const rows = song.patterns[patternIndex];
    if (!rows) return false;
    const numChannels = song.channels;

    const { topPx, bottomPx } = computeRowPaddingPx();

    let html = `<div class="grid-spacer" style="height:${topPx}px"></div>`;
    for (let row = 0; row < rows.length; row++) {
        html += `<div class="row-label" data-row="${row}">${hb(row)}</div>`;
        const rowCells = rows[row];
        for (let col = 0; col < numChannels; col++) {
            html += `<div class="channel-cell" data-channel="${col}" data-row="${row}">${renderNote(rowCells[col])}</div>`;
        }
    }
    html += `<div class="grid-spacer" style="height:${bottomPx}px"></div>`;

    target.el.innerHTML = html;
    target.el.dataset.pattern = patternIndex;
    target.el.style.gridTemplateColumns = gridTemplate(numChannels);

    target.topSpacer    = target.el.firstChild;
    target.bottomSpacer = target.el.lastChild;
    target.topPx        = topPx;
    target.bottomPx     = bottomPx;
    target.patternIndex = patternIndex;
    target.rowCount     = rows.length;

    // Children layout: [topSpacer, ...rows*(N+1), bottomSpacer].
    target.rows.clear();
    const cellsPerRow = numChannels + 1;
    const children = target.el.children;
    for (let row = 0; row < rows.length; row++) {
        const base = 1 + row * cellsPerRow;
        const arr = new Array(cellsPerRow);
        for (let k = 0; k < cellsPerRow; k++) arr[k] = children[base + k];
        target.rows.set(row, arr);
    }
    return true;
}

function swapGrids() {
    const oldActive = activeGrid;
    const newActive = prefetchGrid;
    newActive.el.style.display = 'grid';
    oldActive.el.style.display = 'none';
    activeGrid   = newActive;
    prefetchGrid = oldActive;
}

// Symmetric padding from centerRow's formula. 80px floor for tiny viewports.
function computeRowPaddingPx() {
    const headerH = getTrackerHeader()?.offsetHeight ?? 0;
    const viewportH = getTrackerMain()?.offsetHeight ?? window.innerHeight;
    const offset = scrollOffset || 18;
    const half = Math.max(80, Math.floor((viewportH - headerH) / 2 - 4 - offset / 2));
    return { topPx: half, bottomPx: half };
}

// Idempotent.
function refreshPatternPadding() {
    const { topPx, bottomPx } = computeRowPaddingPx();
    for (const grid of [activeGrid, prefetchGrid]) {
        if (!grid || !grid.topSpacer) continue;
        if (grid.topPx !== topPx) {
            grid.topPx = topPx;
            grid.topSpacer.style.height = topPx + 'px';
        }
        if (grid.bottomPx !== bottomPx) {
            grid.bottomPx = bottomPx;
            grid.bottomSpacer.style.height = bottomPx + 'px';
        }
    }
}

// Three paths: already showing (no-op), prefetched (swap), cold miss (populate).
function showPattern(song, patternIndex, currentRow) {
    if (activeGrid.patternIndex === patternIndex) return;

    if (prefetchGrid.patternIndex === patternIndex) {
        // Hot path — minimum work. Any offsetHeight read would force a
        // layout flush in the playback frame. The needed flush lands in
        // centerRow via the next updateCurrentRow.
        swapGrids();
        return;
    }

    // Cold-miss. Re-measure: computeRowPaddingPx ran against an empty container.
    populateGrid(activeGrid, song, patternIndex);
    activeGrid.el.style.display = 'grid';

    const rowLabel = activeGrid.el.querySelector('.row-label');
    if (rowLabel?.offsetHeight) scrollOffset = rowLabel.offsetHeight;
    refreshPatternPadding();
    centerRow(activeGrid, currentRow);
    syncSampleListHeight();
}

//   y_of_row = headerH + 4 + topPx + R*offset + offset/2
//   scrollTop = y_of_row - (headerH + viewportH) / 2
function centerRow(grid, row) {
    const main = getTrackerMain();
    if (!main || !grid) return;
    const headerH = getTrackerHeader()?.offsetHeight ?? 0;
    const viewportH = main.offsetHeight;
    main.scrollTop = headerH + 4 + grid.topPx
                   + row * scrollOffset + scrollOffset / 2
                   - (headerH + viewportH) / 2;
}

// Cancels any in-flight prefetch first; only the latest schedule wins.
function schedulePrefetch(song, fromOrder, deferrals = 0) {
    cancelPrefetch();
    if (!song || song.totalOrders == null) return;
    const nextOrder = (fromOrder ?? 0) + 1;
    if (nextOrder >= song.totalOrders) return;
    const targetPattern = song.orders[nextOrder];
    if (targetPattern == null) return;
    if (targetPattern < 0 || targetPattern >= song.patterns.length) return;
    if (targetPattern === activeGrid.patternIndex) return;
    if (targetPattern === prefetchGrid.patternIndex) return;

    const run = (deadline) => {
        prefetchIdleHandle = -1;
        // Re-check — world can change between schedule and fire.
        if (!playerState.meta || playerState.meta.song !== song) return;
        if (targetPattern === activeGrid.patternIndex) return;
        if (targetPattern === prefetchGrid.patternIndex) return;

        // Prefer a quiet slot, but don't wait forever: while the rAF loop runs
        // the idle budget peaks near one frame (~16 ms), and a cold miss at
        // the boundary would cost the same build inside a playback frame.
        if (deadline && typeof deadline.timeRemaining === 'function'
            && deadline.timeRemaining() < PREFETCH_MIN_BUDGET_MS
            && deferrals < PREFETCH_MAX_DEFERRALS) {
            schedulePrefetch(song, fromOrder, deferrals + 1);
            return;
        }
        populateGrid(prefetchGrid, song, targetPattern);
    };

    if (typeof requestIdleCallback === 'function') {
        // No `timeout` — prefetch is non-urgent; timeout would promote to high-pri.
        prefetchIdleHandle = requestIdleCallback(run);
    } else {
        // Safari < 16.4 fallback.
        prefetchIdleHandle = setTimeout(
            () => run({ timeRemaining: () => 50, didTimeout: false }),
            50,
        );
    }
}

const PREFETCH_MIN_BUDGET_MS = 8;
const PREFETCH_MAX_DEFERRALS = 4;

function cancelPrefetch() {
    if (prefetchIdleHandle === -1) return;
    if (typeof cancelIdleCallback === 'function') {
        try { cancelIdleCallback(prefetchIdleHandle); } catch { /* not an idle handle */ }
    }
    clearTimeout(prefetchIdleHandle);
    prefetchIdleHandle = -1;
}

// ---- layout ------------------------------------------------------------

function layoutGrids(song) {
    const header = $('#trackerHeader');
    const gridCols = gridTemplate(song.channels);
    if (header.style.gridTemplateColumns !== gridCols) {
        header.style.gridTemplateColumns = gridCols;
    }
    for (const grid of [activeGrid, prefetchGrid]) {
        if (!grid || !grid.el) continue;
        if (grid.el.style.gridTemplateColumns !== gridCols) {
            grid.el.style.gridTemplateColumns = gridCols;
        }
    }

    // Natural width: 20 (row label) + N*(MIN_CHANNEL_WIDTH + 2 gap) + 8 (padding).
    const main = getTrackerMain();
    const naturalWidth = 20 + song.channels * (MIN_CHANNEL_WIDTH + 2) + 8;
    const naturalCss = `${naturalWidth}px`;
    if (main.style.getPropertyValue('--grid-min-width') !== naturalCss) {
        main.style.setProperty('--grid-min-width', naturalCss);
    }

    // max-height = min(viewport - app-chrome, lowest-below-sibling-top - gap).
    const mainRect = main.getBoundingClientRect();
    const top = mainRect.top;
    const bottomChrome = Math.max(8, computeAppBottomChrome());
    const containerBottomChrome = computeContainerBottomChrome(main);
    let lowerBound = window.innerHeight - bottomChrome;

    // Adopt the topmost .app sibling below the tracker as a hard ceiling.
    // 50px clearance filters transient mid-relayout false matches.
    const app = $('.app');
    const trackerContainer = main.closest('.tracker-container');
    if (app) {
        const gap = parseFloat(getComputedStyle(app).rowGap) || 12;
        for (const sibling of app.children) {
            if (sibling === trackerContainer) continue;
            const sRect = sibling.getBoundingClientRect();
            if (sRect.width === 0 || sRect.height === 0) continue;
            const horizontalOverlap =
                sRect.right > mainRect.left && sRect.left < mainRect.right;
            if (horizontalOverlap && sRect.top > top + 50) {
                lowerBound = Math.min(lowerBound, sRect.top - gap);
            }
        }
    }

    // Reserve space for in-container siblings below main (e.g. aurora's
    // samples band). Read by height + gap; on first render main's
    // max-height isn't set yet and the sibling can land far below.
    if (trackerContainer) {
        const tcGap = parseFloat(getComputedStyle(trackerContainer).rowGap) || 12;
        let reservedForBelow = 0;
        for (const sibling of trackerContainer.children) {
            if (sibling === main) continue;
            const sRect = sibling.getBoundingClientRect();
            if (sRect.width === 0 || sRect.height === 0) continue;
            const horizontalOverlap =
                sRect.right > mainRect.left && sRect.left < mainRect.right;
            if (horizontalOverlap && sRect.top > top + 50) {
                reservedForBelow += sRect.height + tcGap;
            }
        }
        lowerBound -= reservedForBelow;
    }

    // -1 floors sub-pixel rounding so densely-framed themes don't grow a hairline scrollbar.
    const raw = lowerBound - top - containerBottomChrome - 1;
    const availableHeight = Math.max(150, Math.floor(raw));
    const next = `${availableHeight}px`;
    if (main.style.maxHeight !== next) {
        main.style.maxHeight = next;
    }

    syncSampleListHeight();
}

// Cached app chrome (padding+border+margin bottom), keyed by computed-style fingerprint.
let cachedAppChrome = { fp: '', value: 0 };
function computeAppBottomChrome() {
    const app = $('.app');
    if (!app) return 0;
    const cs = getComputedStyle(app);
    const fp = `${cs.paddingBottom}|${cs.borderBottomWidth}|${cs.marginBottom}`;
    if (fp === cachedAppChrome.fp) return cachedAppChrome.value;
    const value =
        (parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0) +
        (parseFloat(cs.marginBottom) || 0);
    cachedAppChrome = { fp, value };
    return value;
}

// main.getBoundingClientRect().top is INSIDE the container's padding.
const containerChromeCache = new WeakMap();
function computeContainerBottomChrome(main) {
    const container = main && main.closest('.tracker-container');
    if (!container) return 0;
    const cs = getComputedStyle(container);
    const fp = `${cs.paddingBottom}|${cs.borderBottomWidth}|${cs.marginBottom}`;
    const cached = containerChromeCache.get(container);
    if (cached && cached.fp === fp) return cached.value;
    const value =
        (parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0) +
        (parseFloat(cs.marginBottom) || 0);
    containerChromeCache.set(container, { fp, value });
    return value;
}

function syncSampleListHeight() {
    const main = getTrackerMain();
    const sampleList = $('#sampleList');
    if (!sampleList || !main) return;
    const next = `${main.offsetHeight}px`;
    if (sampleList.style.height !== next) {
        sampleList.style.height = next;
    }
}

// ---- samples -----------------------------------------------------------

function renderSamples(song) {
    const list = $('#sampleList');

    let html = '';
    for (let i = 0; i < song.samples.length; i++) {
        const name = (song.samples[i] || '').replaceAll(' ', '&nbsp;');
        html += `<div class="sample-item" data-sample-id="${i}">${hb(i + 1)} ${name}</div>`;
    }
    list.innerHTML = html;
    list.style.display = 'block';

    sampleItemsById = {};
    const children = list.children;
    for (let i = 0; i < children.length; i++) {
        sampleItemsById[children[i].dataset.sampleId] = children[i];
    }
    channelSampleId = new Array(song.channels).fill(null);
    highlightedSampleIds.clear();
    pendingSampleIds.clear();
}

// ---- current row + sample highlighting ---------------------------------

function updateCurrentRow(pattern, row) {
    if (pattern === lastDrawnPattern && row === lastDrawnRow) return;

    // Previous row may live on either grid — locate by patternIndex.
    if (lastDrawnPattern !== -1 && lastDrawnRow !== -1) {
        const prevGrid = lastDrawnPattern === activeGrid.patternIndex   ? activeGrid
                       : lastDrawnPattern === prefetchGrid.patternIndex ? prefetchGrid
                       : null;
        const prevEls = prevGrid?.rows.get(lastDrawnRow);
        if (prevEls) {
            for (let i = 0; i < prevEls.length; i++) prevEls[i].classList.remove('highlighted-row');
        }
    }

    if (pattern === activeGrid.patternIndex) {
        const els = activeGrid.rows.get(row);
        if (els) {
            for (let i = 0; i < els.length; i++) els[i].classList.add('highlighted-row');
        }
        centerRow(activeGrid, row);
    }

    lastDrawnPattern = pattern;
    lastDrawnRow = row;
}

function updateUsedSamples(song, pos, volumes) {
    const patternRows = song.patterns[pos.pattern];
    if (!patternRows) return;

    pendingSampleIds.clear();
    for (let col = 0; col < song.channels; col++) {
        const vol = volumes[col];
        if (vol.isMuted) {
            channelSampleId[col] = null;
            continue;
        }

        if (pos.pattern >= 0 && pos.row >= 0) {
            const note = patternRows[pos.row]?.[col];
            const sampleId = note && note[1] > 0 ? (note[1] - 1).toString() : null;
            if (sampleId && sampleItemsById[sampleId]) channelSampleId[col] = sampleId;
        }

        const sampleId = channelSampleId[col];
        if (sampleId && vol.maxVolume > 0.05) {
            pendingSampleIds.add(sampleId);
        } else {
            channelSampleId[col] = null;
        }
    }

    for (const id of highlightedSampleIds) {
        if (!pendingSampleIds.has(id)) sampleItemsById[id]?.classList.remove('highlighted');
    }
    for (const id of pendingSampleIds) {
        if (!highlightedSampleIds.has(id)) sampleItemsById[id]?.classList.add('highlighted');
    }

    const swap = highlightedSampleIds;
    highlightedSampleIds = pendingSampleIds;
    pendingSampleIds = swap;
}

// ---- panel toggles -----------------------------------------------------

export function toggleVisualizationsVisible(visible) {
    $$('.canvas-parent').forEach(node => show(node, visible));
    // Defer the reflow to rAF so the click handler returns immediately.
    requestAnimationFrame(relayoutTracker);
}

export function toggleSamplesVisible(visible) {
    // Class on <html> mirrors the inline preboot script for first paint.
    document.documentElement.classList.toggle('samples-hidden', !visible);
    // Only canvas pixel dimensions change; skip full relayout.
    requestAnimationFrame(invalidateCanvasSizes);
}
