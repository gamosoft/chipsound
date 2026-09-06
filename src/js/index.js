// Entry point. Wires modules together; runs the 60 Hz tick.

import { ChiptuneJsPlayer } from './chiptune3.js';
import { setText } from './dom.js';
import { playerState } from './state.js';
import { prefs } from './prefs.js';
import { toast } from './toast.js';
import {
    renderTracker,
    updateTrackerFrame,
    relayoutTracker,
} from './tracker.js';
import {
    initControls,
    setPlaying,
    setControlsAvailable,
    getCurrentVisualizations,
    flushPendingLoad,
    loadFromUrl,
    refreshSubsongSelector,
    onSongLoaded,
} from './controls.js';
import {
    updateVisualizations,
    clearVisualizations,
    initVisualizations,
} from './viz-engine.js';
import { getChannelVolumes } from './viz-core.js';
import { installKeyboardShortcuts } from './keyboard.js';
import { installHelpEscape } from './help.js';
import { installResizeHandler } from './layout.js';
import { applyTheme, currentTheme, wireThemePicker, prefetchOtherThemes, initThemes } from './themes.js';
import { placeholderMeta } from './placeholder.js';
import { installDiagnostics } from './diagnostics.js';
import { installMediaSession, setMediaSessionMetadata } from './media-session.js';
import { initLibrary, modArchiveDownloadUrl } from './library.js';

let rafId = -1;

function tick() {
    // try/finally so a throw can't tear down the RAF loop.
    try {
        // Hidden tab: rAF still fires (typically throttled to ~1Hz) but no
        // pixel ever reaches the screen. Skipping the body avoids posting
        // draw messages to the worker and updating the tracker DOM for
        // nothing. Audio keeps playing — the worklet is on its own thread.
        if (document.hidden) return;
        const pos = playerState.modpos;
        const song = playerState.meta?.song;
        if (song && pos) {
            const volumes = getChannelVolumes(song, pos.chVol, playerState.mutedChannels);
            updateTrackerFrame(song, pos, volumes);
            updateVisualizations(song, pos.chVol, getCurrentVisualizations());
        }
    } catch (err) {
        console.warn('tick: skipped a frame', err);
    } finally {
        rafId = requestAnimationFrame(tick);
    }
}

function startTicker() {
    if (rafId !== -1) return;
    rafId = requestAnimationFrame(tick);
}

function pauseTicker() {
    if (rafId !== -1) cancelAnimationFrame(rafId);
    rafId = -1;
}

function stopTicker() {
    pauseTicker();
    const song = playerState.meta?.song;
    if (song) clearVisualizations(song, getCurrentVisualizations());
}

function bootstrapPlayer() {
    const player = new ChiptuneJsPlayer();
    playerState.player = player;

    player.onInitialized(() => {
        const vol = prefs.volume;
        if (typeof vol === 'number') player.setVol(vol);

        flushPendingLoad();

        // Direct-link sharing. Two URL forms supported:
        //   ?load=<full URL>     any http(s) URL
        //   ?modarchive=<n>      shortcut, expanded to a Modarchive download URL
        // `load` wins if both are present. Autoplay is suppressed here because
        // the page just loaded with no user gesture: the AudioContext is
        // suspended, so play() would show the Pause icon without producing
        // sound. The first Space / click both unlocks audio and starts playback.
        const params = new URLSearchParams(location.search);
        const loadUrl = params.get('load') || modArchiveDownloadUrl(params.get('modarchive'));
        if (loadUrl) loadFromUrl(loadUrl, { autoPlay: false });
    });

    player.onMetadata(meta => {
        playerState.meta = meta;
        // Clear stale pos — worklet keeps emitting for the OLD module
        // until it processes its 'load' command.
        playerState.modpos = {};
        playerState.pendingJumpOrder = null;
        if (playerState.fileName) setText('#fileName', playerState.fileName);
        renderTracker(meta);
        refreshSubsongSelector(meta.song);
        setControlsAvailable(true);
        setMediaSessionMetadata({ title: meta.title, fileName: playerState.fileName });
        requestAnimationFrame(() => {
            clearVisualizations(meta.song, getCurrentVisualizations());
        });
        onSongLoaded();
    });

    player.onProgress(pos => {
        // See tracker.js#jumpToOrder — filters stale worklet pos between
        // Next/Previous click and async setPattern() completion.
        const pending = playerState.pendingJumpOrder;
        if (pending !== null) {
            if (pos.order !== pending) return;
            playerState.pendingJumpOrder = null;
        }
        playerState.modpos = pos;
    });

    player.onEnded(() => {
        // stop() seeks to 0 and pauses — otherwise next Play would re-end
        // immediately (worklet still flagged playing past the cursor).
        playerState.player.stop();
        setPlaying(false);
        stopTicker();
    });

    player.onError(err => {
        // chiptune3.load() reports 'Load' on fetch failure; 'WorkletLoad' is
        // emitted when audioWorklet.addModule() fails (restrictive browsers /
        // content blockers / embedded webviews); others are playback.
        const reason = err?.type ?? 'unknown';
        const kind = String(reason).toLowerCase();
        if (kind === 'load') {
            const name = playerState.fileName || 'module';
            toast(`Could not load: ${name}`, { variant: 'error', duration: 5000 });
        } else if (kind === 'workletload') {
            toast('Could not load audio engine. Try reloading the page, or check that no extension is blocking it.',
                  { variant: 'error', duration: 8000 });
        } else {
            toast(`Playback error: ${reason}`, { variant: 'error', duration: 5000 });
        }
        setPlaying(false);
        stopTicker();
    });
}

// Capture-phase resume() — arms BEFORE feature listeners and STAYS armed.
// Mobile (especially iOS Safari) routinely interrupts the AudioContext mid-
// session: opening the native file picker, backgrounding the tab, locking the
// device, even some volume / route changes all flip the context back to a
// non-running state. A one-shot unlock would miss those subsequent resumes —
// the user would see Play depress with no audio and no pattern motion (the
// worklet's process() only runs while the context is "running"). resume() is
// idempotent when the context is already running, so the per-event cost is
// effectively a state read.
function installAudioUnlock() {
    const events = ['keydown', 'click', 'touchstart', 'drop'];
    const opts = { capture: true, passive: true };
    const handler = () => {
        const ctx = playerState.player?.context;
        if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    for (const ev of events) document.addEventListener(ev, handler, opts);
}

async function init() {
    installDiagnostics();

    // Start audio early — 1.7 MB worklet download begins now.
    bootstrapPlayer();
    installAudioUnlock();
    installMediaSession();

    // Placeholder BEFORE the discovery awaits so the user sees structure immediately.
    playerState.meta = placeholderMeta();
    renderTracker(playerState.meta);

    await Promise.all([initThemes(), initVisualizations()]);

    initControls({
        onTick: startTicker,
        onIdle: stopTicker,
        onPause: pauseTicker,
        onVizChange: () => {
            if (!playerState.isPlaying) {
                const song = playerState.meta?.song;
                if (song) clearVisualizations(song, getCurrentVisualizations());
            }
        },
    });
    initLibrary();
    installKeyboardShortcuts();
    installHelpEscape();
    installResizeHandler();

    applyTheme(currentTheme());
    wireThemePicker();

    // Paint idle viz frames against the final palette.
    requestAnimationFrame(() => {
        const song = playerState.meta?.song;
        if (song) clearVisualizations(song, getCurrentVisualizations());
    });

    prefetchOtherThemes();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Debug only.
window.__player = playerState;
