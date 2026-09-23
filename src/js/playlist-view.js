// Playlist rows for the samples-rail Playlist tab.
// The mix itself lives in playlist.js; this module only paints it.

import { jumpTo, playlistSnapshot, clearPlaylist, removeAt } from './playlist.js';

export function renderPlaylistList(container, { onJump, showClear, onCleared } = {}) {
    const snap = playlistSnapshot();
    const prevScroll = container.querySelector('.playlist-list')?.scrollTop ?? 0;
    container.replaceChildren();

    const ul = document.createElement('ul');
    ul.className = 'playlist-list';
    if (!snap.items.length) {
        const li = document.createElement('li');
        li.className = 'playlist-empty';
        li.textContent = 'Playlist is empty.';
        ul.appendChild(li);
        container.appendChild(ul);
        return;
    }

    snap.items.forEach((r, i) => {
        const li = document.createElement('li');
        li.className = 'playlist-row';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'playlist-item' + (r.current ? ' now-playing' : '');
        btn.innerHTML = '<span class="playlist-item-index"></span><span class="playlist-item-title"></span>';
        btn.querySelector('.playlist-item-index').textContent = String(i + 1).padStart(2, '0');
        btn.querySelector('.playlist-item-title').textContent = r.title;
        btn.title = r.current ? 'Now playing' : (i === snap.index + 1 ? 'Up next' : r.title);
        btn.addEventListener('click', () => {
            onJump?.(i, r);
            if (!r.current) jumpTo(i);
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'playlist-remove';
        remove.title = 'Remove from playlist';
        remove.setAttribute('aria-label', `Remove ${r.title}`);
        remove.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
        remove.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            removeAt(i);
            onCleared?.();
        });

        li.append(btn, remove);
        ul.appendChild(li);
    });
    container.appendChild(ul);

    if (showClear && snap.items.length) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'rail-clear';
        clear.title = 'Stop and empty the playlist';
        clear.textContent = 'Clear playlist';
        clear.addEventListener('click', () => {
            clearPlaylist();
            onCleared?.();
        });
        container.appendChild(clear);
    }

    ul.scrollTop = prevScroll;
    keepRowInView(ul, ul.querySelector('.now-playing')?.closest('.playlist-row'));
}

function keepRowInView(scroller, row) {
    if (!scroller || !row) return;
    const s = scroller.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < s.top) scroller.scrollTop -= s.top - r.top;
    else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom;
}
