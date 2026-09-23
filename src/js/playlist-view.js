// Shared playlist rows for Load and the samples-rail Playlist tab.
// The mix itself lives in playlist.js; this module only paints it.

import { jumpTo, playlistSnapshot, clearUpcoming } from './playlist.js';

export function playlistListItems({ onJump } = {}) {
    const snap = playlistSnapshot();
    return {
        snap,
        items: snap.items.map((r, i) => ({
            title: r.title,
            subtitle: r.current ? 'Now playing' : (i === snap.index + 1 ? 'Up next' : ''),
            meta: String(i + 1),
            current: r.current,
            onClick: () => {
                onJump?.(i, r);
                if (!r.current) jumpTo(i);
            },
        })),
    };
}

export function renderPlaylistList(container, { onJump, showClear, onCleared } = {}) {
    const { snap, items } = playlistListItems({ onJump });
    container.replaceChildren();

    const ul = document.createElement('ul');
    ul.className = 'playlist-list';
    if (!items.length) {
        const li = document.createElement('li');
        li.className = 'playlist-empty';
        li.textContent = 'Playlist is empty.';
        ul.appendChild(li);
        container.appendChild(ul);
        return;
    }

    for (const it of items) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'playlist-item' + (it.current ? ' now-playing' : '');
        btn.innerHTML = '<span class="playlist-item-index"></span><span class="playlist-item-title"></span>';
        btn.querySelector('.playlist-item-index').textContent = it.meta.padStart(2, '0');
        btn.querySelector('.playlist-item-title').textContent = it.title;
        if (it.subtitle) btn.title = it.subtitle;
        btn.addEventListener('click', it.onClick);
        li.appendChild(btn);
        ul.appendChild(li);
    }
    container.appendChild(ul);

    if (showClear && snap.items.length > 1) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'rail-clear';
        clear.title = 'Keep this track, drop the rest';
        clear.textContent = 'Clear upcoming';
        clear.addEventListener('click', () => {
            clearUpcoming();
            onCleared?.();
        });
        container.appendChild(clear);
    }
}
