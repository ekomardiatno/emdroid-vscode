# EMDroid

[![check](https://github.com/ekomardiatno/emdroid-vscode/actions/workflows/check.yml/badge.svg)](https://github.com/ekomardiatno/emdroid-vscode/actions/workflows/check.yml)

Mirror and control a connected Android device **inside a VS Code editor tab** —
including when VS Code is running in a browser.

`scrcpy` and every launcher-style extension open a **native OS window**. That is
fine locally and useless when you are driving VS Code from a browser on another
machine: the window opens on the machine running the editor server, which you
cannot see. EMDroid decodes H.264 **in the webview**, so the picture arrives
wherever the editor UI is, and the same build works in desktop VS Code and in
[code-server](https://github.com/coder/code-server).

> **Status: not published, and not yet run against hardware.** Phases 0 and 1
> are code-complete with 127 passing unit tests, but the two end-to-end gates —
> a live mirror on a device, and the proxy path in a real browser — have not been
> walked through yet. The low-latency scrcpy source (phase 2) is designed but not
> written. See [Roadmap](#roadmap).

---

## Features

- **Live mirror in an editor tab** — splittable and movable beside your code,
  with `retainContextWhenHidden` so switching to the Explorer does not tear down
  the stream.
- **Touch, scroll and keyboard input** back to the device, with an optional
  "show taps" overlay while mirroring.
- **Device list** in the activity bar, with inline mirror / screenshot /
  reconnect actions, driven by `adb track-devices` rather than polling.
- **Screenshot to a file** anywhere the editor can write.
- **Rotation follows the device** — the stream re-configures and touch stays
  aligned.
- **Degraded mode, automatically.** If the webview reports it cannot decode
  H.264, the session swaps itself to `screencap` stills **in the same tab** — no
  setting, no reopened panel. Input stays fully functional.
- **No orphaned recorders.** The on-device `screenrecord` holds the hardware
  encoder, so it is reaped before start and after stop; closing the tab stops it.

## Requirements

- `adb` — auto-detected from `PATH`, `ANDROID_HOME` / `ANDROID_SDK_ROOT`, then
  the platform default SDK location. Override with `emdroid.adbPath`.
- An Android device with **USB debugging** enabled and the host authorised.
  `screenrecord --output-format=h264` needs **SDK 24+**; below that EMDroid uses
  stills.
- VS Code **1.90+** or code-server built on it.
- For the video path, a webview with [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
  (`VideoDecoder`). Desktop VS Code always has it; in a browser it depends on the
  browser. **No configuration needed either way** — the webview measures what it
  can decode and the host switches to stills if the answer is "nothing", keeping
  the same tab. `emdroid.source` forces the choice if you want to.

## Usage

Open the **EMDroid** view in the activity bar, then use the inline actions on a
device, or the command palette:

| Command | What it does |
| --- | --- |
| `EMDroid: Mirror Device` | Opens the mirror panel for a device. |
| `EMDroid: Take Screenshot` | Captures one PNG and asks where to save it. |
| `EMDroid: Reconnect Device` | Closes the session and re-reads the device list. |
| `EMDroid: Refresh Devices` | Re-runs `adb devices -l`. |
| `EMDroid: Show Diagnostics` | Reveals the output channel and logs the resolved adb path, `VSCODE_PROXY_URI`, `appHost` and `uiKind`. **Start here when something does not work.** |
| `EMDroid: Run Transport Spike (fixture loop)` | Replays a committed H.264 fixture through the real transport with **no device and no adb**. |

That last one is the diagnostic worth knowing about. When nothing paints, it
tells you in one step whether the problem is the transport (WebSocket, proxy,
framing, decoder) or the capture — which otherwise look identical.

With one device attached, commands act on it without asking. With several you
get a quick pick; EMDroid never guesses, and always passes `-s <serial>` rather
than adb's `-d`.

### Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `emdroid.adbPath` | *(auto)* | Machine-scoped, so a cloned repo's `.vscode/settings.json` cannot point it at an arbitrary executable. |
| `emdroid.scrcpyServerPath` | *(bundled)* | Machine-scoped. Phase 2. |
| `emdroid.maxWidth` | `720` | Longest edge of the mirrored video. Lower is faster. |
| `emdroid.bitRate` | `8M` | Passed to the on-device encoder. |
| `emdroid.source` | `auto` | `auto` \| `screenrecord` \| `still`. |
| `emdroid.showTouches` | `false` | Reads the device's current value and restores it afterwards. |
| `emdroid.logLevel` | `info` | `error` … `trace`. |

## Known limits of the current (screenrecord) source

Stated plainly, because they are the reason phase 2 exists:

- **Latency is ~1–2 s.** `screenrecord` buffers, and nothing on the host can
  undo that.
- **One finger.** `input motionevent` takes no pointer id, so pinch and
  two-finger gestures cannot be expressed. Non-primary pointers are dropped
  rather than merged, which would otherwise make the cursor jump between fingers.
- **No modifier keys on named keys.** `input keyevent` has no meta argument.
  Printable characters arrive as text, so only shortcuts built on named keys are
  lost.
- **Flings and long-press timing are approximate.** Each `input` call is a fresh
  `app_process` stamping its own `uptimeMillis`, so a drag's moves do not look
  like continuations of their down to anything measuring velocity. Taps and drags
  land.
- **Stills really are ~0.4 fps**, not the 1–2 fps you might assume: `screencap -p`
  measured 2.3 MB in 2.6 s on the reference device, and `screencap -j` is not
  supported there. The honest description is "controllable stills".

## How it works

```
 device ── adb exec-out screenrecord ──► host: Annex B demuxer ──► access units
                                                                      │
                                        ws://127.0.0.1:<ephemeral>/s/<token>
                                                                      │
                                          asExternalUri ──► /proxy/<port>/ (code-server)
                                                                      │
 webview ◄── 16-byte header + AU ──► VideoDecoder ──► canvas ──► pointer/key events
```

Three decisions shape everything else:

**Frames cannot travel over `postMessage`**, which JSON-serialises — so they go
over a loopback WebSocket surfaced with `vscode.env.asExternalUri`. That one API
is a no-op on desktop (you get `http://127.0.0.1:PORT/…` back) and maps to
code-server's `/proxy/{port}/` path in the browser, which is what makes a single
build work in both. The server binds `127.0.0.1` only and every upgrade carries
a per-session token.

**Demuxing happens in the host, not the webview.** `FrameSource` emits whole
access units, so swapping `screenrecord` for the scrcpy server later changes one
factory and nothing the webview can see.

**Coordinates cross into the host normalised 0..1 in stream space**, never
pixels. The sink multiplies by the current display size, so neither the webview
nor the session knows that rotation exists.

The status bar shows measured fps and tap round-trip
(`EMDroid: SM-G996B · 28 fps · tap 240 ms`) — visible numbers are how you tell
whether a faster source is worth it.

### Layout

```
src/
├── common/          # no node, no DOM; imported by both bundles
│   ├── h264/{annexb,sps}.ts
│   └── {protocol,keys,log}.ts
├── host/            # extension host (CJS)
│   ├── adb/         # path resolution, client, device + display watchers, parsers
│   ├── source/      # FrameSource/InputSink, screenrecord/, still/, fixture/
│   ├── transport/   # StreamServer, ExternalUri, Token
│   ├── session/     # MirrorSession, SessionManager
│   └── ui/          # MirrorPanel, DeviceTreeProvider, html, errors, statusBar
└── webview/         # browser (ESM): decode/, render/, input/
```

Two esbuild bundles, and three tsconfigs that enforce the separation at
type-check time: host code cannot see `DOM`, webview code cannot see `node:*`,
and `src/common` structurally cannot reach either side. Exactly one runtime
dependency, `ws`.

## Development

```bash
npm install
npm run check     # typecheck (×3 projects) + unit tests + build
npm run watch     # incremental build; F5 in VS Code attaches to it
```

Press <kbd>F5</kbd> for an Extension Development Host. Tests are plain
`node --test` over TypeScript sources using Node's native type stripping, so
they need **Node 22.18+** (developed on 24.22); the extension itself only needs
Node 20, which is what the editor ships.

```bash
npm test                                    # all
node --test --import ./test/stub/register.mjs test/unit/annexb.test.ts
```

127 tests cover the Annex B splitting, the SPS-derived codec string, the adb
output parsers, pointer mapping, shell quoting and a full fixture session end to
end — including the token guard, the binary framing and byte-identical access
unit delivery. Every input is **real output measured from a real device**, not
invented: parsing adb means parsing a human-readable format with no contract,
and pinning the exact strings is the only defence against drift.

Two things the unit suite cannot prove, because they do not exist outside a
browser: `asExternalUri` under code-server's proxy, and the WebCodecs decoder.
Those are the manual gates — run the transport spike in desktop VS Code *and* in
a real browser against your code-server host.

### Notes for anyone extending this

- **Every `VideoFrame` must be `close()`d.** Chromium's decoder stalls
  permanently after a handful of leaked frames.
- **Do not pass `description` to `VideoDecoder.configure()`.** Omitting it
  selects Annex B mode; providing it switches to AVCC and the stream fails.
- **The codec string is parsed from SPS at runtime.** It varies with capture
  size — `avc1.640020` at 540×1200, `avc1.64002A` larger. Hardcoding fails.
- **Two concurrent `screenrecord` processes fight over the one hardware
  encoder**, so all start/stop/restart work is serialised, and a stall freezes
  the last frame rather than clearing the canvas.
- **`exec-out`, never `shell`, for binary output.** A pty rewrites every `\n` in
  a PNG and the file is quietly corrupt.
- **Never `spawn` with `shell: true`.** Serials and sizes would be injection
  vectors.

## Roadmap

- **Phase 0 — transport spike.** Complete. Fixture → `StreamServer` →
  `asExternalUri` → webview → canvas, with no adb involved.
- **Phase 1 — `screenrecord` + gesture input.** Complete. Includes the
  `screencap` still fallback.
- **Phase 2 — scrcpy-server protocol.** Push the server jar, launch it via
  `app_process`, read its 12-byte framed packets and drive input over its
  control socket. Targets ~50 ms and real multi-touch drag. Swaps the
  `FrameSource`/`InputSink` pair and nothing else.

## Licence

MIT — see [LICENSE](LICENSE). Third-party components, including the Apache-2.0
licensed `scrcpy-server` used by the planned low-latency source, are credited in
[NOTICE](NOTICE).
