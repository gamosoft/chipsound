// Samples column: instrument names plus the session playlist.
// Tabs are always on. Toggle I still hides the whole rail.

import { $ } from './dom.js';
import { onPlaylistChange, playlistLength } from './playlist.js';
import { renderPlaylistList } from './playlist-view.js';

let section = null;
let tabsEl = null;
let playlistEl = null;
let pane = 'samples';
let wasMix = false;

export function initSampleRail() {
    section = $('.sample-section');
    tabsEl = $('#railTabs');
    playlistEl = $('#playlistRail');
    if (!section || !tabsEl || !playlistEl) return;

    tabsEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-rail]');
        if (!btn) return;
        showPane(btn.dataset.rail);
    });

    onPlaylistChange(syncRail);
    syncRail();
}

function syncRail() {
    const mix = playlistLength() > 1;
    if (mix && !wasMix) pane = 'playlist';
    wasMix = mix;
    showPane(pane);
}

function showPane(id) {
    pane = id === 'playlist' ? 'playlist' : 'samples';
    const showPlaylist = pane === 'playlist';
    section.classList.toggle('rail-showing-playlist', showPlaylist);
    section.setAttribute('aria-label', showPlaylist ? 'Playlist' : 'Samples');

    for (const b of tabsEl.querySelectorAll('[data-rail]')) {
        const on = b.dataset.rail === pane;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
    }

    if (showPlaylist) {
        renderPlaylistList(playlistEl, {
            showClear: true,
            onCleared: syncRail,
        });
    }
}
