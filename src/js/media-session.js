// Bridge to navigator.mediaSession so OS shell surfaces drive playback —
// lockscreen, notification shade, Bluetooth headset / car-display buttons,
// the system's media key handlers. Delegates back to the existing button
// clicks so the click-handler path stays the single source of truth (no
// duplicated state transitions, no risk of OS commands and on-page commands
// diverging).
//
// Silent no-op on browsers without MediaSession (older Safari, very old
// Chromium webviews). Each setActionHandler is try/wrapped because the spec
// allows browsers to throw on unsupported action names.

import { $ } from './dom.js';
import { skipTrack, queueLength } from './queue.js';

const HAS_MEDIA_SESSION = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
const HAS_METADATA_CTOR = typeof MediaMetadata !== 'undefined';

function safeSetAction(name, fn) {
    try {
        navigator.mediaSession.setActionHandler(name, fn);
    } catch { /* unsupported action — fine */ }
}

export function installMediaSession() {
    if (!HAS_MEDIA_SESSION) return;
    // Forwarding to .click() instead of calling player methods directly keeps
    // the three-way play/pause/unpause logic and the gated guards (e.g.
    // "Load a module first" toast) in one place.
    safeSetAction('play',          () => $('#play')?.click());
    safeSetAction('pause',         () => $('#play')?.click());
    safeSetAction('stop',          () => $('#stop')?.click());
    // Headset next/prev skip playlist tracks when a mix is armed; otherwise they
    // keep today's order-skip (the on-page ←/→ buttons).
    safeSetAction('previoustrack', () => {
        if (queueLength() > 1) skipTrack(-1);
        else $('#previous')?.click();
    });
    safeSetAction('nexttrack',     () => {
        if (queueLength() > 1) skipTrack(+1);
        else $('#next')?.click();
    });
}

export function setMediaSessionMetadata({ title, fileName } = {}) {
    if (!HAS_MEDIA_SESSION || !HAS_METADATA_CTOR) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title:  title || fileName || 'Chipsound',
            artist: 'Chipsound',
            album:  fileName || '',
        });
    } catch { /* ignore — never block playback for a cosmetic surface */ }
}

// state: 'playing' | 'paused' | 'none'
export function setMediaSessionPlaybackState(state) {
    if (!HAS_MEDIA_SESSION) return;
    try {
        navigator.mediaSession.playbackState = state;
    } catch { /* ignore */ }
}
