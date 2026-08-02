# OSRS Soundboard

A desktop soundboard and music player for Old School RuneScape audio. Tauri v2
shell, React + Vite + TypeScript frontend, Web Audio under the hood.

The app ships **empty**. On first run it reads the file index from the OSRS
Wiki, downloads sound effects and short jingles to your machine, and streams
music on demand. No audio is bundled with the installer or committed to this
repository.

## Install

Windows installers are published on the
[releases page](https://github.com/mikeyd433/ScapeSoundboard/releases/latest)
and linked from [dabingabongo.com/downloads](https://dabingabongo.com/downloads).

Run `OSRS-Soundboard-Setup-x64.exe`. It adds a desktop shortcut and a Start
menu entry — the desktop icon is how you launch it; there is no browser tab
involved. The installer is unsigned, so SmartScreen will warn on first launch:
choose **More info → Run anyway**.

## What it does

**First run.** Reads all four `Category:Audio_files` subcategories through the
MediaWiki API — around 4,700 files. You choose whether to keep sound effects
only, or sound effects plus short jingles, with the real download size shown
before anything is fetched. Downloads run three at a time and skip whatever is
already on disk, so quitting halfway and coming back costs nothing.

Music is not downloaded. 7 GB is not a first-run experience, so tracks stream
from the wiki when you play them.

**Soundboard tab.** A virtualized pad grid of every sound effect plus jingles
under a length threshold. Pads fire on pointer-down and overlap — hammer one
ten times and you get ten voices. Right-click a pad for variant, volume and
pitch. Sound effects are decoded and cached so the first press is not the slow
one.

**Library tab.** A virtualized list of music, jingles and the soundbank, with
a transport bar: play/pause, seek, loop, shuffle, next/previous, crossfaded
between tracks. Variant chips swap the playing source in place.

Both tabs share the master bus, so a music track can run under the soundboard
while you fire effects over it.

**Boards.** Saved pad layouts, 4×4 or 8×8, named and switched with `Alt+1`–`9`.
Slots 1–16 are bound to the number and QWERTY rows, so a board plays from the
keyboard. Add pads by right-clicking any pad on the *All sounds* view. Layouts
are rearranged in an explicit *Edit layout* mode, which keeps arranging and
playing from fighting over the same gesture.

**Sprites.** Sounds are matched to wiki artwork in the spec's four tiers: the
`Template:SFXLine` reverse index first, since the wiki states the sound →
article link explicitly; then filename derivation with every guess verified
against a real article; then article artwork by icon naming convention and a
scored image list; then a generated colour-hashed tile for whatever is left.
Right-click → *Change icon* searches the wiki inline and pins a manual
override. This stage is optional and skippable — it is cosmetic, and a failure
never costs you a working library.

**Drag-out.** Drag a sound into REAPER, Resolve, Explorer or Discord. There is
a grab handle in the corner of each pad and on library rows; *Drag from pad*
turns on the whole-pad gesture, which fires the sound on press and starts the
drag once you move. Files are staged under their pretty display names — nobody
wants `a7f3c2-abyssal-whip.ogg` on their timeline — via hard links, so it costs
no disk and no time. Ctrl-click to select several pads and drag them all at
once. Only clips stored locally can be dragged; streamed music has no file to
give.

**Search.** Always present at the top. `/` or `Ctrl+F` focuses it. A leading
`cat:` token filters category — `cat:jingle level` finds level-up jingles.
Filters for current-only (on by default, which collapses 8-bit reworks and
v1/v2 revisions), length, and favourites. Sound effects also carry their
in-game sound id and config name, so `energydrain` finds its effect.

**Esc** clears a live search if one is running, and otherwise stops every
voice instantly.

## Not built yet

The spec runs to eight phases; this is phases 1–6, with phase 1 trimmed so
music streams rather than filling 7 GB. Deliberately absent:

- **MIDI** (spec phase 7). Web MIDI in a WebView2 host is untested territory
  and there is no way to verify it without hardware.
- **Drag-out format conversion** (spec §8, *Format conversion*). Files are
  handed over in their original format. WAV and MP3 conversion wants an ffmpeg
  sidecar, and shipping an untested transcoder that could quietly corrupt a
  file landing on someone's timeline is worse than not shipping one.
- **Phase 8 stretch goals** — output recording, REAPER track templates, the
  step sequencer.

## Development

```bash
npm install
npm run app:dev      # Tauri dev window with hot reload
npm test             # unit tests for the parsing and board logic
npm run build        # typecheck + vite build (frontend only)
npm run app:build    # full installer for the current platform

cd src-tauri && cargo test --lib   # path-safety and filename tests
```

The tests cover the parts that are subtly wrong-able and impossible to eyeball:
the variant whitelist (`(Dragon Slayer)` is context to keep, `(Fossil Island)`
is a variant to strip, and they are structurally identical), the `SFXLine`
wikitext scraping, board slot maths, and the drag-staging path safety.

On Linux you need the usual Tauri system dependencies (`libgtk-3-dev`,
`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`).

Icons are generated from a vector description rather than checked in from a
design tool:

```bash
node scripts/make-icons.mjs
```

### Releasing

Push a tag and CI builds and publishes the Windows installers:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The installers are uploaded under stable filenames
(`OSRS-Soundboard-Setup-x64.exe`, `OSRS-Soundboard-x64.msi`) so the downloads
page can link to `/releases/latest/download/<name>` and never go stale.

## Notes on the implementation

A few places where this departs from the spec, and why:

- **No ffprobe sidecar.** Durations are only needed for files already on disk,
  and the webview reads metadata off a local file in a millisecond or two.
  Shipping a second binary to learn the same thing was not worth it. Music
  durations come from the wiki when it reports them, and are measured lazily
  when a row scrolls into view otherwise.

- **The music engine probes for CORS first.** Routing an `HTMLAudioElement`
  through `createMediaElementSource` silently outputs *silence* if the media is
  not CORS-clean, and we cannot know in advance whether the wiki sends the
  right headers. So the engine checks once at startup and falls back to driving
  `HTMLAudioElement.volume` directly. Playback and volume work either way; the
  fallback only loses music passing through the shared limiter.

- **URL resolution is synchronous.** Tauri's `join` is an IPC round trip, and a
  pad press must never wait on one. The library root and path separator are
  resolved once at load, and everything after that is string concatenation.

- **Board layouts are rearranged in an explicit edit mode.** The spec wants
  drag-to-reorder on a board and a native file drag off a pad. Those are the
  same gesture on the same element, so rather than guess at the user's intent
  mid-drag, arranging is a mode you turn on.

- **Drag state resets on pointer-down, not pointer-up.** Once the OS drag loop
  takes over, the webview stops receiving pointer events and `pointerup` may
  never arrive. Every fresh press is the reliable place to start clean.

## Distribution

The audio and sprites are Jagex IP — the wiki hosts them with permission, and
the CC BY-NC-SA footer covers wiki text, not game assets. A local app that
downloads its own library on first run keeps clear of redistributing anything.
Do not commit the library folder or push it anywhere.

Wiki requests identify themselves with a descriptive User-Agent pointing at
this repository, make API calls serially, and cap downloads at three
concurrent — Weird Gloop 403s generic user agents, and staying polite is what
keeps this working.
