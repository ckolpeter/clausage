# Clausage — project guide for Claude Code

Unofficial, open-source floating desktop widget (Electron) that shows **Claude subscription usage limits**: the 5-hour session window, the weekly limit, per-model limits when present, reset countdowns, and more. Windows / macOS / Linux. MIT. Repo: https://github.com/ckolpeter/clausage

Personal environment notes and current status are in `CLAUDE.local.md` (gitignored) — read it too.

## Layout

| Path | What |
|---|---|
| `src/main.js` | Main process: windows, tray, fetching, refresh loop, notifications, IPC, settings |
| `src/usage.js` | **Pure** parsing/prediction (`normalize`, `addEta`, `planOf`, `hasUsage`, `spendOf`). No Electron imports — unit-tested |
| `src/history.js` | Local usage history (8 days, `<userData>/history.json`), recent-rate calc, CSV export |
| `src/code-stats.js` | Claude Code token stats per model from `~/.claude/projects/**/*.jsonl` |
| `src/updater.js` / `src/version.js` | Auto-update (electron-updater on Win installer / AppImage; GitHub API link elsewhere) |
| `src/fullscreen.js` | Windows full-screen detection via one long-lived hidden PowerShell (user32) |
| `src/preload.js` | contextBridge — the only API renderers can call |
| `src/widget.*`, `src/settings.*`, `src/history.html` + `history-view.js` | Renderer UIs (plain HTML/JS, no framework) |
| `src/locales/*.json` | 10 languages: en, zh-TW, zh-CN, ja, ko, es, fr, de, pt-BR, ru |
| `test/` | `node --test` unit tests + `smoke.test.js` (runs real `main.js` against `test/fake-electron.js`) |
| `scripts/fix-electron.ps1` | Repairs a broken Electron install on Windows (see pitfalls) |
| `docs/ROADMAP.md` | Plan and done-list |

## Data sources (both undocumented — may change any time)

- **claude.ai (default):** user signs in inside the app (session partition `persist:claude`; extra accounts get `persist:claude-acct-*`). `GET /api/organizations` → pick org → `GET /api/organizations/{org}/usage`. Uses `session.fetch`, falling back to a hidden claude.ai page (`executeJavaScript` fetch) if Cloudflare blocks it.
  - Only orgs whose `capabilities` include `chat` have usage; API-console orgs 403 → skip them (not an auth error).
  - Free plan: every field is null; detect via capabilities lacking `claude_pro`/`claude_max` → `err.freePlan`. Pro shows `rate_limit_tier: default_claude_ai` too, so don't use tier alone.
  - Response has the newer `limits` array (`kind`: `session` / `weekly_all` / scoped…, `percent`, `resets_at`, `scope`), `seven_day_breakdown` (per-product share), `spend` / `extra_usage`, plus legacy `five_hour` / `seven_day` / `seven_day_*`. `usage.js` prefers `limits`, fills gaps from legacy, dedupes. Real sample: `test/fixtures/usage-pro.json`.
- **Claude Code credentials (optional):** `~/.claude/.credentials.json` (macOS Keychain `Claude Code-credentials`) → `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`.
- When run from source, raw responses are dumped to `debug/` (gitignored; contains email/org IDs — never commit). Disabled under `CLAUSAGE_TEST`.

## Conventions

- Privacy: requests go only to claude.ai / api.anthropic.com / GitHub (updates). No telemetry. Never log tokens/cookies.
- Keep `contextIsolation: true`, `sandbox: true`; renderers use `textContent`/`esc()` for any data; `innerHTML` only for our own locale strings.
- Polling default 120 s, min 30 s. Failures retry with backoff 15/30/60 s; offline uses `net.isOnline()`.
- Every user-facing string goes through i18n. **Add new keys to all 10 locale files** with identical `{placeholders}` and `<b>` tags — `test/misc.test.js` enforces this. Errors carry i18n keys (`AppError(key, vars)`), not text.
- All notifications go through `notify()` so quiet hours apply.
- Platform differences are expected: macOS shows the tray number as menu-bar text (`tray.setTitle`), Windows/Linux draw it into the icon. Tests must not assume one behaviour — use `SIM_PLATFORM=darwin|win32` in the smoke runner.

## Commands

```bash
npm start              # run from source
npm test               # unit + smoke tests (no GUI/Electron binary needed)
npm run dist:win:local # Windows build reusing node_modules/electron/dist (no Electron download)
npm run dist:win | dist:mac | dist:linux
```

Release: `npm version x.y.z && git push --follow-tags` → GitHub Actions builds all 3 platforms and creates a **draft** Release → publish it manually.

## Known pitfalls

- **Lockfile:** after changing dependencies, run `npm install` and commit `package-lock.json`; CI uses `npm ci` and fails on any mismatch.
- **npm 11 `allowScripts`:** install scripts are blocked unless listed in `package.json` → `allowScripts` (electron, electron-winstaller). If Electron's binary is missing, that's why.
- **Electron on Node 26 (Windows):** Electron's postinstall unzip can stop silently after the first file (`dist/locales/pl.pak` only) → run `scripts/fix-electron.ps1`.
- **Slow GitHub downloads:** use `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.
- **PowerShell** splits `-c.foo=bar` at the dot — put electron-builder overrides in npm scripts, not on the command line.
- **Single instance:** `npm start` exits silently (prints a message) if Clausage is already running — quit it from the tray or `taskkill /IM electron.exe /F`.
- `npm start` dies with its terminal; for daily use install the built app. "Launch at login" only makes sense in the installed build.
- Linux `.deb` needs `author.email` / `linux.maintainer` with an email (we use `ckolpeter@users.noreply.github.com`).
- macOS builds are unsigned (no Apple Developer account yet) → can't self-update; updater falls back to a release link.
- Name: keep **Clausage**. `ccusage` is an unrelated, popular project (ryoppippi/ccusage) — don't rename to it.
