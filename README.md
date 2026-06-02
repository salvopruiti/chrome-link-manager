# Link Manager

Chrome Manifest V3 extension to save links in a local extension database and manage their state across devices with optional Supabase sync.

## Main features

- Shift+Click on a link: saves the link to the local database instead of opening it.
- URL deduplication: always ignores the `#...` fragment and can ignore configurable query parameters per domain.
- Collapsible in-page bar: list saved links, open, remove, open random, and save all currently open tabs.
- Extension popup: quickly search saved links, open in a new tab, remove, and toggle `seen` / `favorite` states.
- Saved-link state management: links can be marked as seen or favorite from the UI.
- Supabase magic link login and manual synchronization of the links database across devices.

## Structure

- `manifest.json`: MV3 extension configuration.
- `src/background.js`: storage, URL normalization, extension actions, and tabs integration.
- `src/supabase-config.js`: internal Supabase project configuration used by auth and sync.
- `src/auth-callback.html` + `src/auth-callback.js`: magic link callback flow to complete the Supabase session.
- `src/content.js`: Shift+Click interception and in-page mini bar.
- `src/popup.html` + `src/popup.js`: action popup with quick search for saved links.
- `src/options.html` + `src/options.js`: query-rule settings, magic link login, and manual sync.

## Local installation

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the project folder.

## Usage

1. Open the extension options page.
2. Enter your email in the `Account & Sync` section and send the magic link.
3. Open the link received by email to complete login.
4. Use `Sync now` to align the local database with Supabase.
5. Browse a website and use Shift+Click on a link to save it.
6. Open the mini bar in the bottom-right corner to manage links.
7. Mark saved links as seen or favorite where needed.
8. Click the extension icon to quickly search saved links from the popup.

## Technical notes

- Data is stored in `chrome.storage.local`.
- User settings are stored in `chrome.storage.sync`, while auth session and links database remain local.
- For magic link login, add `chrome-extension://<EXTENSION_ID>/src/auth-callback.html` to allowed redirect URLs in Supabase Auth settings.
- The initial Supabase schema for the `links` table and RLS policies is in `supabase/schema.sql`.
- Wildcard rules support the format `*.domain.tld`.
