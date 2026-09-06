// Best-effort localStorage with JSON encoding — returns defaults when unavailable.

const KEY_PREFIX = 'modplayer.';

function read(name, fallback) {
    try {
        const raw = localStorage.getItem(KEY_PREFIX + name);
        if (raw === null) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function write(name, value) {
    try {
        localStorage.setItem(KEY_PREFIX + name, JSON.stringify(value));
    } catch {
        /* ignore */
    }
}

export const prefs = {
    get vizId() { return read('vizId', null); },
    set vizId(value) { write('vizId', value); },

    get showVisualizations() { return read('showVisualizations', true); },
    set showVisualizations(value) { write('showVisualizations', value); },

    get showSamples() { return read('showSamples', true); },
    set showSamples(value) { write('showSamples', value); },

    get volume() { return read('volume', 100); },
    set volume(value) { write('volume', value); },

    get theme() { return read('theme', 'clusters'); },
    set theme(value) { write('theme', value); },

    // Samples pane width in px; null = fit to content.
    get samplesWidth() { return read('samplesWidth', null); },
    set samplesWidth(value) { write('samplesWidth', value); },
};
