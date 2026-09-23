// In-memory playlist. Mixer Loop (repeatCount) stays per-module —
// libopenmpt consumes it, and onEnded only fires after that finishes.
// This module answers "what plays after that."
//
// Items are `{ url, name }` or `{ file, name }`. Nothing is persisted;
// File objects would not survive a refresh anyway.

import { $ } from './dom.js';
import { playerState } from './state.js';
import { loadFile, loadFromUrl, setPlaying } from './controls.js';

const items = [];
let index = -1;
// True while a playlist load is in flight (fetch / FileReader / waiting on
// metadata). onEnded must not also advance — the old song can still finish
// while the next buffer is on its way.
let busy = false;

export function playlistBusy() {
    return busy;
}

export function releasePlaylistBusy() {
    busy = false;
}

export function playlistLength() {
    return items.length;
}

const listeners = [];

export function onPlaylistChange(fn) {
    listeners.push(fn);
}

function emit() {
    syncSkipButtons(items.length > 1);
    for (const fn of listeners) fn();
}

function syncSkipButtons(hasMix) {
    const prev = $('#previous');
    const next = $('#next');
    if (prev) {
        prev.title = hasMix ? 'Previous track (Shift+←)' : 'Previous order (←)';
        prev.setAttribute('aria-label', hasMix ? 'Previous track (Shift+Left)' : 'Previous order (Left)');
    }
    if (next) {
        next.title = hasMix ? 'Next track (Shift+→)' : 'Next order (→)';
        next.setAttribute('aria-label', hasMix ? 'Next track (Shift+Right)' : 'Next order (Right)');
    }
}

function current() {
    return index >= 0 && index < items.length ? items[index] : null;
}

async function loadCurrent({ autoPlay }) {
    const item = current();
    if (!item) return 'fail';
    if (item.file) {
        loadFile(item.file, { autoPlay });
        return 'ok';
    }
    if (item.url) {
        const result = await loadFromUrl(item.url, { autoPlay, name: item.name || null });
        if (result === 'ok' && playerState.fileName) {
            item.name = playerState.fileName;
            emit();
        }
        return result;
    }
    return 'fail';
}

// Walk from `index` in `direction` until a load sticks, or we run out.
async function loadFromHere({ autoPlay, direction = 1 }) {
    busy = true;
    while (index >= 0 && index < items.length) {
        const result = await loadCurrent({ autoPlay });
        if (result === 'ok') return true; // busy until metadata
        if (result === 'aborted') return 'aborted'; // the load that aborted us owns busy
        index += direction;
        emit();
    }
    if (items.length) {
        index = Math.max(0, Math.min(index, items.length - 1));
        emit();
    } else {
        index = -1;
        emit();
    }
    busy = false;
    return false;
}

async function loadFromHereOrStop(opts) {
    const result = await loadFromHere(opts);
    if (result === true) return true;
    if (result !== 'aborted') setPlaying(false);
    return false;
}

export async function playList(newItems, { autoPlay = true } = {}) {
    const next = (newItems || []).filter(Boolean);
    items.length = 0;
    if (!next.length) {
        index = -1;
        emit();
        return false;
    }
    items.push(...next);
    index = 0;
    emit();
    return loadFromHereOrStop({ autoPlay, direction: 1 });
}

export function playNow(item, opts) {
    return playList(item ? [item] : [], opts);
}

export function addToPlaylist(newItems) {
    const next = (newItems || []).filter(Boolean);
    if (!next.length) return 0;
    const startedEmpty = index < 0;
    items.push(...next);
    if (index < 0) index = 0;
    emit();
    if (startedEmpty) void loadFromHereOrStop({ autoPlay: true, direction: 1 });
    return next.length;
}

export async function advance({ autoPlay = true } = {}) {
    if (index + 1 >= items.length) return false;
    index += 1;
    emit();
    return loadFromHereOrStop({ autoPlay, direction: 1 });
}

export async function jumpTo(i) {
    if (i < 0 || i >= items.length) return false;
    if (i === index) return true;
    index = i;
    emit();
    const autoPlay = playerState.isPlaying || playerState.isPaused;
    playerState.player?.stop();
    return loadFromHereOrStop({ autoPlay, direction: 1 });
}

export function clearUpcoming() {
    if (index < 0 || !items.length) {
        items.length = 0;
        index = -1;
        emit();
        return;
    }
    const keep = items[index];
    items.length = 0;
    items.push(keep);
    index = 0;
    emit();
}

export function playlistSnapshot() {
    return {
        index,
        items: items.map((item, i) => ({
            title: item.name || item.file?.name || 'Module',
            current: i === index,
        })),
    };
}

export async function skipTrack(delta) {
    if (!delta || items.length < 2) return false;
    const next = index + delta;
    if (next < 0 || next >= items.length) return false;
    index = next;
    emit();
    const autoPlay = playerState.isPlaying || playerState.isPaused;
    playerState.player?.stop();
    return loadFromHereOrStop({ autoPlay, direction: delta > 0 ? 1 : -1 });
}
