# Chipsound

[![GitHub Stars](https://img.shields.io/github/stars/gamosoft/chipsound)](https://github.com/gamosoft/chipsound/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Vanilla JS](https://img.shields.io/badge/JS-vanilla-yellow)

<p align="center">
  <img src="src/images/favicon.svg" alt="Chipsound" width="256">
</p>

## What is Chipsound?

A lightweight in-browser player for the tracker music formats that powered the demoscene, the Amiga, and a generation of PC games (`.mod`, `.s3m`, `.xm`, `.it`). Open a URL or drop a module on the page and it plays. No install, no upload, no account. Everything runs client-side, every color is CSS, every visualization is real-time.

Under the hood: Chipsound doesn't decode anything itself. [libopenmpt](https://lib.openmpt.org/libopenmpt/) (compiled to WebAssembly via [Chiptune.js](https://github.com/DrSnuggles/chiptune)) does the audio, and this project reads the playback state — channel volumes, current order/row, instrument data — to draw the pattern view, the off-thread per-channel visualizations, the mute/solo overlays, and the subsong picker. Add to that the themes, shareable `?load=<url>` links, keyboard shortcuts, and the performance work to keep everything running without glitching the audio.

<p align="center">
  <img src="docs/images/theme-skinplayer.jpg" alt="Skinplayer theme" title="Skinplayer" width="24%">
  <img src="docs/images/theme-mixtape.jpg" alt="Mixtape theme" title="Mixtape" width="24%">
  <img src="docs/images/theme-crt-green.jpg" alt="CRT Green theme" title="CRT Green" width="24%">
  <img src="docs/images/theme-field-journal.jpg" alt="Field Journal theme" title="Field Journal" width="24%">
  <br>
  <img src="docs/images/theme-foundry.jpg" alt="Foundry theme" title="Foundry" width="24%">
  <img src="docs/images/theme-newspaper.jpg" alt="Newspaper theme" title="Newspaper" width="24%">
  <img src="docs/images/theme-pocket.jpg" alt="Pocket theme" title="Pocket" width="24%">
  <img src="docs/images/theme-subway.jpg" alt="Subway theme" title="Subway" width="24%">
</p>

## Who is it for?

- Demoscene fans revisiting Future Crew, Purple Motion, Skaven, Necros, and the rest of the crew
- Retro gamers who remember when MS-DOS games shipped a `.s3m` soundtrack on the install disk
- Tracker music collectors with a folder of `.mod` files that just need to play in one tab
- Mobile listeners who want a tracker player that doesn't need an app store
- Developers looking for a zero-dependency, themeable, embeddable player they can host themselves

<p align="center">
  <a href="https://chipsound.com"><img src="docs/images/website-button.svg" alt="chipsound.com" height="44"></a>
  &nbsp;
  <a href="https://chipsound.com/player.html"><img src="docs/images/player-button.svg" alt="Launch the player" height="44"></a>
  &nbsp;
  <a href="https://ko-fi.com/gamosoft"><img src="docs/images/support-button.svg" alt="Support on Ko-fi" height="44"></a>
</p>

<p align="center">
  <strong>No module handy?</strong> Jump straight into a sample track:<br>
  <a href="https://chipsound.com/player.html?modarchive=212083">▶ UnreaL ][</a> ·
  <a href="https://chipsound.com/player.html?modarchive=212701">▶ Insideout</a> ·
  <a href="https://chipsound.com/player.html?modarchive=48357">▶ Minimum Velocity</a> ·
  <a href="https://chipsound.com/player.html?modarchive=39987">▶ Crystal Dragon</a> ·
  <a href="https://chipsound.com/player.html?modarchive=32382">▶ Aquaphobia</a> ·
  <a href="https://chipsound.com/player.html?modarchive=34654">▶ Catch that goblin!!</a>
</p>

## Why Chipsound?

| | Chipsound | Other Players |
|---|-----------|----------------|
| Install | None — open the URL | Download + install, often Windows-only |
| Formats | MOD, S3M, XM, IT | Often format-specific |
| Mobile | Touch + responsive | Rarely |
| Themes | Fully themeable via CSS | Usually fixed |
| Visualizations | Real-time, per-channel | Limited or none |
| Privacy | All client-side | Varies |
| Cost | Free | Free or paid |
| Open-source | MIT | Mixed |

Other things worth mentioning:

- Plays anything libopenmpt can decode (MOD, S3M, XM, IT and their variants)
- Drag a module onto the page and it auto-plays
- Press `T` to cycle themes, `V` to cycle visualizations
- Click a channel header to mute it; Ctrl-click to solo
- Subsong picker for modules that ship multiple subsongs
- Press `M` for the Mixer: live stereo separation, Amiga resampler, interpolation, volume ramping, tempo, pitch (semitones), gain and loop settings, all applied by libopenmpt on the fly and remembered between sessions. Drag for coarse and hold `Shift` at any point for fine, use the wheel or arrow keys to nudge, click a value to type it, double-click to reset
- Render the loaded module to a WAV, FLAC or Opus file with the current mixer settings and channel mutes (Mixer → Render to file)
- `?` opens the full keyboard shortcut list

## Quick start

**Try it now:** [chipsound.com/player.html](https://chipsound.com/player.html) to jump straight to the player.

Drop a `.mod`, `.s3m`, `.xm`, or `.it` file on the page and it plays. Tens of thousands of free tracker modules are at [The Mod Archive](https://modarchive.org).

### Run it locally

The app is pure static HTML/CSS/JS in [`src/`](src/). Browsers require `AudioWorklet`s to be served over HTTP from `localhost` (not `file://`), so pick any static server:

```bash
# Python 3
cd src && python -m http.server 8765

# Node + npx
npx http-server src -p 8765 -c-1

# Docker + Caddy
docker build -t chipsound . && docker run --rm -p 8765:80 chipsound
```

Then open <http://localhost:8765/>.

> Want to open it from another device (phone, tablet, second computer)? You'll need [HTTPS](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/audioWorklet), put the server behind a reverse proxy or a tunnel.

> Python's server caches aggressively. Hard-reload with `Ctrl + Shift + R`, or use `npx http-server -c-1` which sets `Cache-Control: no-store`.

> **Themes & visualizations are auto-discovered from directory listings.** On startup the player fetches `./css/themes/` and `./js/visualizations/` and parses the HTML index to find all `*.css` / `*.js` files. The three servers above all enable directory listings by default. If you deploy behind a static host that disables them (some CDNs, GitHub Pages with a hand-rolled config, certain nginx setups), the picker will fall back to a single built-in theme + visualization. Either enable directory listing for those two folders, or fork in a static manifest.

### Load a module by URL

The player accepts a `?load=<url>` query parameter pointing to any HTTP(S) URL:

```text
https://chipsound.com/player.html?load=./tracks/awesome.s3m
https://chipsound.com/player.html?load=https://example.com/cool.mod
https://chipsound.com/player.html?load=https%3A%2F%2Fapi.modarchive.org%2Fdownloads.php%3Fmoduleid%3D212083
```

For The Mod Archive — the most common source for tracker music — there's a shorter form: `?modarchive=N` expands internally to the same `downloads.php?moduleid=N` URL, no percent-encoding needed:

```text
https://chipsound.com/player.html?modarchive=212083
```

> **Loading from The Mod Archive.** Modarchive's `downloads.php` endpoint sends the right CORS headers and works directly, but the `?` inside the inner URL must be percent-encoded (`%3F`), otherwise the outer query parser splits the URL in two:


## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `P` | Play / Pause |
| `S` | Stop |
| `L` | Open file… |
| `←` / `→` | Previous / next order |
| `E` | Toggle effects (visualizations on/off) |
| `V` / `Shift` + `V` | Cycle visualization forward / backward |
| `I` | Toggle samples panel |
| `M` | Toggle mixer (playback parameters + render to file) |
| `T` / `Shift` + `T` | Cycle theme forward / backward |
| `?` | Show this help |
| `Esc` | Close this help |
| Click header | Toggle channel mute |
| Ctrl + Click header | Solo channel (mute others) |
| Click grip icon in header | Toggle ALL channels |
| Drop file | Load and auto-play |

## Privacy & telemetry

The repository source is telemetry-free. There's no analytics module, no Google Analytics snippet, and no JavaScript anywhere in the source that reads the `data-track="..."` HTML markers used throughout the codebase (you'll see them on the playbar buttons, the dynamically-rendered channel headers, and on landing-page CTAs). Those are inert HTML attributes — browsers ignore them unless a click listener is explicitly registered to read them, and the source code never registers one.

Google Analytics 4 only runs on the public site at [chipsound.com](https://chipsound.com): both the loader script and the single delegated listener that reads `data-track` are injected at deploy time by [`.github/workflows/pages.yml`](.github/workflows/pages.yml), and the injected snippet itself checks `location.hostname` before firing anything. Self-hosted deployments (Docker, Caddy, `python -m http.server`, anything you run yourself) fire zero requests to Google — easy to verify in DevTools → Network.

One exception, opt-in by action: the first **FLAC** export in a session downloads the FLAC encoder (libflac.js, pinned version, ~240 KB) from jsDelivr. Nothing is sent besides the ordinary request; WAV and Opus exports need no download at all.

## License

[MIT-licensed](LICENSE) — free to use, modify, fork, embed, and redistribute. Copyright © 2026 Gamosoft.

The MIT license covers first-party code only. Bundled third-party components keep their own licenses:

- **libopenmpt** — BSD-3-Clause. See [`docs/third-party/libopenmpt-LICENSE.txt`](docs/third-party/libopenmpt-LICENSE.txt).
- **Chiptune.js** — MIT. See [`docs/third-party/chiptune-js-LICENSE.txt`](docs/third-party/chiptune-js-LICENSE.txt).
- **Font Awesome Free 6.5.1** — Icons CC BY 4.0, fonts SIL OFL 1.1, code MIT. See [`docs/third-party/font-awesome-LICENSE.txt`](docs/third-party/font-awesome-LICENSE.txt).
- **libflac.js** — MIT wrapper around BSD-3-Clause libFLAC; fetched from jsDelivr on first FLAC export, not bundled. See [`docs/third-party/libflac-js-LICENSE.txt`](docs/third-party/libflac-js-LICENSE.txt).

Full notice summary in [`NOTICE`](NOTICE).

## Credits

Chipsound is a UI shell on top of other open-source work:

- **[libopenmpt](https://lib.openmpt.org/libopenmpt/)** — the OpenMPT team's reference decoder, compiled to WebAssembly.
- **[Chiptune.js](https://github.com/DrSnuggles/chiptune)** — the WebAudio wrapper around libopenmpt by DrSnuggles (and originally [chiptune2.js](https://github.com/deskjet/chiptune2.js) by deskjet).
- **[Font Awesome](https://fontawesome.com)** — the icon set used throughout the UI.
- **[libflac.js](https://github.com/mmig/libflac.js)** — FLAC encoder for the render-to-file feature. Opus export uses the browser's own encoder via WebCodecs.
