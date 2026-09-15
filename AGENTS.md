# Link Manager — AGENTS.md

## Project Overview
Chrome MV3 extension that saves, manages, and navigates links. Users capture links via Shift+Click, browse them in a floating content bar, and sync across devices via Supabase.

- **Version:** see `manifest.json` (kept in sync by semantic-release)
- **Repo:** `github.com:salvopruiti/chrome-link-manager.git`
- **Release workflow:** semantic-release with conventional commits (`fix:`, `feat:`, `chore:`, `perf:`)

## Tech Stack
- Plain JavaScript (ES modules), no framework
- Chrome Extension Manifest V3 (service worker + content script)
- Supabase (auth + database) via `@supabase/supabase-js`
- semantic-release for changelog/versioning

## Project Structure
```
├── src/
│   ├── background.js          # Service worker: storage, sync, messaging hub
│   ├── content.js             # Content script: floating bar, shift-click capture
│   ├── supabase-client.js     # Supabase queries (upsert, delete, fetch)
│   ├── supabase-config.js     # Supabase client init (anon key + URL)
│   ├── options.html / .js     # Settings page (sticky save bar, multi-col layout)
│   ├── links.html / .js       # Archive page (search, filter, paginate, CRUD)
│   ├── popup.html / .js       # Extension popup
│   ├── auth-callback.html / .js # Magic-link auth redirect handler
├── _locales/
│   ├── en/messages.json       # English i18n strings
│   ├── it/messages.json       # Italian i18n strings
├── supabase/schema.sql        # Full DB schema (links table, indexes, RLS)
├── manifest.json              # Extension manifest (MV3)
├── .releaserc.json            # semantic-release config
├── scripts/update-manifest-version.mjs # Version bump script
├── package-extension.ps1      # Builds dist/link-manager-v<version>.zip (PowerShell)
├── icons/                     # Extension icons
├── screenshots/               # Chrome Web Store listing assets (SVG source + PNG)
├── dist/                      # Packed extension artifacts
```

## Database (Supabase)
- **Table `links`**: `id` (uuid PK), `user_id`, `url`, `normalized_url`, `title`, `page_url`, `is_seen`, `seen_at`, `is_favorite`, `favorited_at`, `created_at`, `updated_at`, `revision_id`, `pending_upsert`, `pending_delete`, `remote_deleted`, `last_sync_revision`
- Unique index: `(user_id, normalized_url)` — links are deduplicated by normalized URL per user
- RLS policies enforce user isolation

## Key Architecture Decisions
- **State flow:** All state lives in `background.js` (chrome.storage.local). Pages request state via `chrome.runtime.sendMessage({type:"get-state"})`. Mutations go through the service worker.
- **Message passing:** Every page uses `sendMessage()` → returns `{ok, result/error}` via callback. No `chrome.storage.onChanged` listeners on pages.
- **Sync:** Supabase sync is manual (button) or periodic (alarm). Queue of upserts/deletes flushed in batch. Mutex protects queue from race conditions.
- **broadcastState:** On state change, `chrome.tabs.query({active:true, lastFocusedWindow:true})` sends `state-updated` only to the active tab (not all tabs).
- **URL normalization:** Hostname + pathname lowercase, trailing slash stripped, sorted search params (minus configured ignore params). Done client-side in `content.js`.
- **i18n:** All user-facing strings via `chrome.i18n.getMessage(key)`. Pages use `data-i18n` attributes replaced at runtime + `t()` helper.
- **Visibility auto-refresh:** Both options.html and links.html listen to `visibilitychange` → re-fetch state.

## Conventions
- **Code style:** No comments. No trailing semicolons. Single quotes for strings. 2-space indentation.
- **CSS:** Custom properties (dark theme), `--bg`, `--panel`, `--ink`, `--muted`, `--accent`, `--accent-grad`, `--border`, `--panel-border`, `--input-bg`, `--error`.
- **UI theme:** Dark gradient (`#18243f` → `#0b1324`), glass-effect panels (`rgba(255,255,255,0.06)` borders), orange accent (`#d9771f` → `#f2bb69`).
- **Buttons:** Primary = orange gradient, Secondary = translucent white, Warn = red. Disabled state `opacity: 0.3; pointer-events: none`.
- **Commits:** Conventional commit format (`type(scope): message`). `fix:` for patches, `feat:` for features, `chore:` for infra.
- **Branching:** Feature branches from `main`, merged via fast-forward.

## Pages & Key Files
| Page | File(s) | Purpose |
|------|---------|---------|
| Options | `options.html`, `options.js` | All settings: import bookmarks, bar visibility, URL rules, sync account |
| Archive | `links.html`, `links.js` | Full link list with search/filter/pagination/CRUD, query string state |
| Floating bar | `content.js` | Shown on pages where links exist for current domain |
| Popup | `popup.html`, `popup.js` | Quick capture via extension toolbar icon |
| Auth callback | `auth-callback.html`, `auth-callback.js` | Handles Supabase magic-link redirect |

## Key Behaviors
- **Archive query string:** State persisted in URL: `?q=&page=&unseen=1&seen=1&fav=1`. Read on init, written on every render.
- **Sync buttons:** Disabled when not authenticated. "Confronta e correggi" shows diff and optionally fixes.
- **Modal:** Inline form within archive. Errors shown inside modal (`#modalStatus`) not behind overlay. Title truncated with ellipsis.
- **Settings save:** Sticky bottom bar always visible. Settings saved independently of sync auth.
- **Badge rendering:** Archive table shows "Visto" and "Favorito" pill badges on relevant rows.
- **Random link shortcut:** `Ctrl+Shift+9` (`Cmd+Shift+9` on Mac) opens a random navigable link from any page via the `open-random-link` command handled in the service worker.

## Build / Test / Lint
- **No build step** — plain JS loaded directly by Chrome
- **No tests** — manually tested
- **Pack extension:** `.\package-extension.ps1` (PowerShell, Windows)
- **Release:** `npx semantic-release` (requires GH token)
- **Supabase DB:** Apply `supabase/schema.sql` via Supabase SQL editor

## Current State
- Latest tag: managed by semantic-release; see `CHANGELOG.md`
- Branch: `main`
- All core features stable. No open issues.
