// Library modal (B / Load button) — tabbed lists of modules to load without
// leaving the player. "Open file…" at the top of the dialog hits the hidden
// file input (same as L). Tabs are plain objects so more can be added
// (playlists, an API browser, …) with registerLibraryTab():
//
//   { id, label, icon, render(body, api) }   registerLibraryTab(tab, { before: 'url' })
//   api.load(url, { name })  fetch + play a module and close the modal
//   api.list(items)          helper: render [{ title, subtitle, url, meta }]
//
// Built-in tabs: Curated (the chipsound.com picks), Recent (URL history),
// Local (a same-origin directory listing, e.g. ./tracks/), and URL
// (any http(s) URL or a Mod Archive id / link).

import { $, isTypingTarget } from './dom.js';
import { prefs } from './prefs.js';
import { playerState } from './state.js';
import { loadFile, loadFromUrl } from './controls.js';
import { toast } from './toast.js';
import { createModal } from './modal.js';

export function modArchiveDownloadUrl(id) {
    if (!id || !/^\d+$/.test(String(id))) return null;
    return `https://api.modarchive.org/downloads.php?moduleid=${id}`;
}

// The six sample tracks from the chipsound.com landing page.
export const CURATED = [
    { title: 'UnreaL ][',          artist: 'Purple Motion', file: '2nd_pm.s3m',     modarchive: 212083 },
    { title: 'Insideout',          artist: 'Purple Motion', file: 'inside_out.s3m', modarchive: 212701 },
    { title: 'Minimum Velocity',   artist: 'Purple Motion', file: 'minimum.s3m',    modarchive: 48357 },
    { title: 'Crystal Dragon',     artist: 'Skaven',        file: 'crystald.s3m',   modarchive: 39987 },
    { title: 'Aquaphobia',         artist: 'Purple Motion', file: 'aqua.s3m',       modarchive: 32382 },
    { title: 'Catch that goblin!!', artist: 'Skaven',       file: 'ctgoblin.s3m',   modarchive: 34654 },
];

// Everything libopenmpt is likely to open; used to filter directory listings.
const MODULE_EXT = /\.(mod|s3m|xm|it|mptm|669|amf|ams|dbm|digi|dmf|dsm|far|gdm|imf|j2b|mdl|med|mo3|mt2|mtm|okt|plm|psm|ptm|sfx|stm|ult|umx|wow|mdz|s3z|xmz|itz)$/i;
const RECENT_MAX = 25;

let bodyEl = null;
let tabBarEl = null;
let activeTab = null;
const tabs = [];

// The dialog shell (overlay, card, Esc, focus handling) comes from modal.js;
// this module only supplies the tab bar and tab panels.
const modal = createModal({
    id: 'libraryOverlay',
    title: '<i class="fa-solid fa-compact-disc" aria-hidden="true"></i> Load',
    className: 'modal-library',
    width: 'min(680px, 92vw)',
    build(body) {
        const openFile = document.createElement('button');
        openFile.type = 'button';
        openFile.className = 'library-action library-open-file';
        openFile.title = 'Open a module from this device (L)';
        openFile.innerHTML = '<i class="fa-solid fa-folder-open" aria-hidden="true"></i> <span class="btn-label">Open file…</span>';
        openFile.addEventListener('click', () => $('#files').click());

        tabBarEl = document.createElement('div');
        tabBarEl.className = 'library-tabs';
        tabBarEl.setAttribute('role', 'tablist');
        bodyEl = document.createElement('div');
        bodyEl.className = 'library-body';
        body.append(openFile, tabBarEl, bodyEl);
        renderTabBar();
    },
    onOpen(m) {
        m.el?.querySelector('.library-open-file')?.focus({ preventScroll: true });
    },
});

// Add a tab. `before` is the id of an existing tab to insert in front of
// (default: append after the built-ins).
export function registerLibraryTab(tab, { before = null } = {}) {
    const at = before ? tabs.findIndex(t => t.id === before) : -1;
    if (at >= 0) tabs.splice(at, 0, tab); else tabs.push(tab);
    if (tabBarEl) renderTabBar();
}

// ---------- recent history ----------
// URL loads persist a fetchable href. Picker / drag-drop use a `local:` key and
// keep the File in memory for this tab so Recent can replay it until refresh.

const LOCAL_RECENT = 'local:';
const sessionFiles = new Map(); // local: key → File

function isLocalRecent(url) { return String(url || '').startsWith(LOCAL_RECENT); }

export function recordRecent({ url, name, file }) {
    if (!url) return;
    if (file) sessionFiles.set(url, file);
    const list = (prefs.recent || []).filter(r => r.url !== url);
    list.unshift({ url, name: name || url, at: Date.now() });
    prefs.recent = list.slice(0, RECENT_MAX);
}

function clearRecent() {
    sessionFiles.clear();
    prefs.recent = [];
}

function playRecent(r) {
    const file = sessionFiles.get(r.url);
    if (file) {
        closeLibrary();
        loadFile(file);
        return;
    }
    if (isLocalRecent(r.url)) {
        toast('That file is not kept after a refresh. Open file… or drop it again.', { variant: 'info', duration: 4000 });
        return;
    }
    api.load(r.url, { name: r.name });
}

// ---------- helpers for tabs ----------

const api = {
    load(url, { name } = {}) {
        closeLibrary();
        loadFromUrl(url, { autoPlay: true, name });
    },
    list(items, { empty = 'Nothing here yet.' } = {}) {
        const ul = document.createElement('ul');
        ul.className = 'library-list';
        if (!items.length) {
            const li = document.createElement('li');
            li.className = 'library-empty';
            li.textContent = empty;
            ul.appendChild(li);
            return ul;
        }
        for (const it of items) {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'library-item' + (it.kind === 'dir' ? ' library-dir' : '');
            if (it.url && playerState.fileName && it.name === playerState.fileName) btn.classList.add('now-playing');
            btn.innerHTML = `<i class="fa-solid ${it.kind === 'dir' ? 'fa-folder' : 'fa-play'}" aria-hidden="true"></i>
                <span class="library-item-title"></span><span class="library-item-sub"></span><span class="library-item-meta"></span>`;
            btn.querySelector('.library-item-title').textContent = it.title;
            btn.querySelector('.library-item-sub').textContent = it.subtitle || '';
            btn.querySelector('.library-item-meta').textContent = it.meta || '';
            btn.addEventListener('click', () => it.onClick ? it.onClick() : api.load(it.url, { name: it.name }));
            li.appendChild(btn);
            ul.appendChild(li);
        }
        return ul;
    },
};

// ---------- built-in tabs ----------

const curatedTab = {
    id: 'curated', label: 'Curated', icon: 'fa-star',
    render(body) {
        const p = document.createElement('p');
        p.className = 'library-blurb';
        p.innerHTML = 'Sample tracks picked for <a href="https://chipsound.com" target="_blank" rel="noopener">chipsound.com</a>, streamed from <a href="https://modarchive.org" target="_blank" rel="noopener">The Mod Archive</a>.';
        body.appendChild(p);
        body.appendChild(api.list(CURATED.map(c => ({
            title: c.title, subtitle: c.artist, meta: c.file.split('.').pop().toUpperCase(),
            url: modArchiveDownloadUrl(c.modarchive), name: c.file,
        }))));
    },
};

const recentTab = {
    id: 'recent', label: 'Recent', icon: 'fa-clock-rotate-left',
    render(body) {
        const items = (prefs.recent || []).map(r => ({
            title: r.name,
            subtitle: isLocalRecent(r.url) ? 'This device' : hostOf(r.url),
            meta: relTime(r.at),
            url: r.url,
            name: r.name,
            onClick: () => playRecent(r),
        }));
        body.appendChild(api.list(items, { empty: 'Modules you open — file, drop, URL, or these tabs — show up here.' }));
        if (items.length) {
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'library-action library-clear';
            clear.innerHTML = '<span class="btn-label">Clear history</span>';
            clear.addEventListener('click', () => { clearRecent(); showTab('recent'); });
            body.appendChild(clear);
        }
    },
};

const localTab = {
    id: 'local', label: 'Local', icon: 'fa-folder-open',
    async render(body) {
        const base = prefs.libraryPath || './tracks/';
        const form = document.createElement('form');
        form.className = 'library-path';
        form.innerHTML = `<label>Folder <input type="text" class="retro-select" name="path" spellcheck="false" autocomplete="off"></label>
            <button type="submit" class="library-action library-action-icon" title="Open"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`;
        const input = form.querySelector('input');
        input.value = base;
        form.addEventListener('submit', e => { e.preventDefault(); prefs.libraryPath = normalizeDir(input.value); showTab('local'); });
        body.appendChild(form);

        const hint = document.createElement('p');
        hint.className = 'library-blurb';
        hint.textContent = 'Browses a directory listing served next to the player (same origin). Serve your modules folder as ./tracks/ and it shows up here.';
        body.appendChild(hint);

        const holder = document.createElement('div');
        holder.className = 'library-listing';
        holder.textContent = 'Loading…';
        body.appendChild(holder);

        const resetLink = () => {
            if (base === './tracks/') return null;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'library-action library-clear';
            b.textContent = 'Back to ./tracks/';
            b.addEventListener('click', () => { prefs.libraryPath = './tracks/'; showTab('local'); });
            return b;
        };
        let entries;
        try {
            entries = await listDirectory(base);
        } catch (err) {
            holder.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'library-error';
            p.textContent = `Could not list ${base}: ${err.message}`;
            holder.appendChild(p);
            const r = resetLink(); if (r) holder.appendChild(r);
            return;
        }
        const items = [];
        // Only offer ".." when the parent is itself a browsable folder (the
        // player root serves index.html, not a listing).
        const up = parentDir(base);
        if (up !== './' && up !== '/') {
            items.push({ kind: 'dir', title: '..', subtitle: 'up', onClick: () => { prefs.libraryPath = up; showTab('local'); } });
        }
        for (const d of entries.dirs) {
            items.push({ kind: 'dir', title: d, onClick: () => { prefs.libraryPath = base + d + '/'; showTab('local'); } });
        }
        for (const f of entries.files) {
            items.push({ title: f, meta: f.split('.').pop().toUpperCase(), url: base + encodeURIComponent(f), name: f });
        }
        holder.innerHTML = '';
        holder.appendChild(api.list(items, { empty: 'No modules in this folder.' }));
        if (!entries.files.length) { const r = resetLink(); if (r) holder.appendChild(r); }
    },
};

const urlTab = {
    id: 'url', label: 'URL', icon: 'fa-link',
    render(body) {
        const form = document.createElement('form');
        form.className = 'library-url';
        form.innerHTML = `<label>Module URL or Mod Archive id
                <input type="text" class="retro-select" name="url" placeholder="https://… or 212083 or modarchive.org/…?query=212083" spellcheck="false" autocomplete="off"></label>
            <button type="submit" class="library-action">Load</button>
            <p class="library-blurb">Any http(s) URL the server allows cross-origin, a Mod Archive module id, or a Mod Archive page / download link.</p>`;
        form.addEventListener('submit', e => {
            e.preventDefault();
            const raw = form.elements.url.value.trim();
            const url = resolveUserUrl(raw);
            if (!url) { form.querySelector('input').setCustomValidity('Enter a URL or a numeric Mod Archive id'); form.reportValidity(); return; }
            api.load(url);
        });
        form.querySelector('input').addEventListener('input', e => e.target.setCustomValidity(''));
        body.appendChild(form);
        setTimeout(() => form.querySelector('input').focus(), 0);
    },
};

export function resolveUserUrl(raw) {
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return modArchiveDownloadUrl(raw);
    // Absolute http(s) URLs, or paths relative to the player (./tracks/x.mod).
    if (!/^(https?:\/\/|\/|\.\.?\/)/i.test(raw)) return null;
    let u;
    try { u = new URL(raw, location.href); } catch { return null; }
    if (/modarchive\.org$/i.test(u.hostname)) {
        const id = u.searchParams.get('moduleid') || u.searchParams.get('query') || u.searchParams.get('modarchive');
        if (id && /^\d+$/.test(id)) return modArchiveDownloadUrl(id);
    }
    return /^https?:$/.test(u.protocol) ? u.href : null;
}

// ---------- directory listings (python http.server, Caddy browse, nginx, Apache) ----------

async function listDirectory(path) {
    const res = await fetch(path, { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const dirs = new Set(), files = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
        let href = a.getAttribute('href') || '';
        if (/^(\?|#|\.\.|\/$|https?:)/.test(href) || href === '../' || href === './') continue;
        href = href.split('?')[0].split('#')[0];
        const isDir = href.endsWith('/');
        const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop());
        if (!name || name === '..') continue;
        if (isDir) dirs.add(name);
        else if (MODULE_EXT.test(name)) files.add(name);
    }
    const sort = s => [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    return { dirs: sort(dirs), files: sort(files) };
}

function normalizeDir(p) {
    p = (p || './tracks/').trim();
    if (!p.endsWith('/')) p += '/';
    if (!/^(\.\/|\/|https?:)/.test(p)) p = './' + p;
    return p;
}
function parentDir(p) {
    const parts = p.replace(/\/$/, '').split('/');
    parts.pop();
    const out = parts.join('/') + '/';
    return out === '/' || out === './' ? './' : out;
}
function hostOf(url) { try { return new URL(url, location.href).hostname; } catch { return ''; } }
function relTime(t) {
    const d = Date.now() - t;
    if (d < 60e3) return 'just now';
    if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`;
    if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`;
    return `${Math.round(d / 86400e3)} d ago`;
}

// ---------- modal ----------

function renderTabBar() {
    tabBarEl.innerHTML = '';
    for (const t of tabs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'library-tab';
        b.setAttribute('role', 'tab');
        b.dataset.tab = t.id;
        b.innerHTML = `<i class="fa-solid ${t.icon || 'fa-list'}" aria-hidden="true"></i> <span>${t.label}</span>`;
        b.addEventListener('click', () => showTab(t.id));
        tabBarEl.appendChild(b);
    }
}

export async function showTab(id) {
    const tab = tabs.find(t => t.id === id) || tabs[0];
    if (!tab) return;
    activeTab = tab.id;
    prefs.libraryTab = tab.id;
    for (const b of tabBarEl.querySelectorAll('.library-tab')) {
        const on = b.dataset.tab === tab.id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        // The modal focuses the first control on open; keep focus on the active tab.
        if (on && document.activeElement?.classList.contains('library-tab')) b.focus({ preventScroll: true });
    }
    bodyEl.innerHTML = '';
    bodyEl.scrollTop = 0;
    const scratch = document.createElement('div');
    scratch.className = 'library-tab-panel';
    bodyEl.appendChild(scratch);
    await tab.render(scratch, api);
}

export function openLibrary(tabId) {
    modal.open();
    showTab(tabId || prefs.libraryTab || 'curated');
}

export function closeLibrary() { modal.close(); }

export function toggleLibrary() {
    if (modal.isOpen()) closeLibrary(); else openLibrary();
}

export function isLibraryOpen() { return modal.isOpen(); }

export function initLibrary() {
    for (const t of [curatedTab, recentTab, localTab, urlTab]) if (!tabs.includes(t)) tabs.push(t);
    $('#load')?.addEventListener('click', () => toggleLibrary());
    // Esc is handled by the modal primitive; ←/→ switch tabs. Global shortcuts
    // are off while a dialog is open, so B closes and L still opens a file.
    document.addEventListener('keydown', e => {
        if (modal.isOpen() && !isTypingTarget(e.target) && e.code === 'KeyB') {
            e.preventDefault();
            modal.close();
            return;
        }
        if (modal.isOpen() && !isTypingTarget(e.target) && e.code === 'KeyL') {
            e.preventDefault();
            $('#files').click();
            return;
        }
        if (modal.isOpen() && !isTypingTarget(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            const i = tabs.findIndex(t => t.id === activeTab);
            const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            e.preventDefault();
            showTab(tabs[n].id);
        }
    });
}
