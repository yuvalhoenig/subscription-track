# SubTrack for macOS

Electron shell around the same React UI the web app uses, plus the native
integrations that only make sense on the desktop.

## What the desktop build adds

| Feature | How it works |
| --- | --- |
| **Menu bar item** | Monthly spend beside the clock, with the next five renewals in the dropdown. Works with no window open. |
| **Dock badge** | Counts renewals due within three days. |
| **Native notifications** | Fired for renewals and expiring trials, at most once per subscription per date. Clicking one opens the calendar. |
| **Offline mode** | Successful reads are cached to disk; writes made offline are queued and replayed in order on reconnect or on wake from sleep. |
| **Voice input** | Apple's `SFSpeechRecognizer` via a small Swift helper, with `requiresOnDeviceRecognition` set so audio never leaves the machine. Falls back to the Web Speech API if the Xcode command line tools are absent. |
| **Mail.app integration** | AppleScript asks the running Mail app for recent receipt-like messages. No mail credentials are ever held by SubTrack, and macOS gates it behind an Automation consent prompt. |
| **Session persistence** | Tokens are stored by the main process, so the app stays signed in across launches. |

## Running in development

```bash
# Terminal 1 — API
npm run dev:server

# Terminal 2 — renderer (Vite, with hot reload)
npm run dev:web

# Terminal 3 — Electron, pointed at the Vite dev server
npm run dev:desktop
```

`SUBTRACK_API_URL` and `SUBTRACK_WEB_URL` override the defaults
(`http://localhost:4000` and `http://localhost:5173`).

## Packaging

```bash
npm run build:desktop          # from the repo root
```

That builds the web bundle, copies it into `Resources/renderer`, and
produces a universal `.dmg` and `.zip` in `packages/desktop/release/`.

**Must be run on macOS.** electron-builder needs macOS tooling to create a
`.dmg`, sign, and notarise. Building on Linux or Windows will fail at the
packaging step.

### Signing and notarisation

Unsigned builds work locally. For distribution, set these before building
and electron-builder will sign and notarise:

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
```

## Security posture

The renderer displays AI-generated text, so it is treated as untrusted:

- `contextIsolation: true`, `nodeIntegration: false` — the page has no
  access to Node.
- Native capability is exposed only through the named functions in
  `src/preload.cjs`. The renderer cannot name an arbitrary IPC channel.
- Navigation away from the app's own origin is blocked; external links open
  in the default browser.

## Architecture

```
src/
├── main.js       window, tray, dock, notifications, IPC, polling
├── preload.cjs   the narrow window.subtrack bridge (CommonJS by necessity)
├── config.js     environment-resolved settings
├── store.js      atomic on-disk store: session, cache, offline queue
├── api.js        main-process API client with cache fallback and replay
├── menu.js       application menu
├── tray.js       menu bar item
├── speech.js     SFSpeechRecognizer via a lazily compiled Swift helper
└── mail.js       Mail.app reading over AppleScript
```
