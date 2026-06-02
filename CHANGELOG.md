# Changelog

This file collects the main project changes, grouped by version based on the git history.

## 0.4.1 - 2026-06-02

- Translated `README.md` to English and aligned wording across sections.
- Updated documentation to remove the Chrome bookmarks promotion flow.
- Documented saved-link state management (`seen` and `favorite`) in popup/usage notes.

## 0.4.0 - 2026-06-02

- Global persistence of the bar state in `chrome.storage.local`, with fallback and migration from the previous per-site save in `localStorage`.
- In-page bar: the quick row remains visible in reduced mode, is hidden only when the panel is open, and the back/forward buttons are also available in the `Current page` box.
- Fixed the bar toggle to force a full rerender when switching between open and closed states.

## 0.3.1 - 2026-05-29

- Added synchronization diagnostics and persistent toasts.
- Refinements and manifest version updates for release `0.3.1`.

## 0.3.0 - 2026-05-19

- Refactored the Supabase integration and improved incremental synchronization.
- New options for automatically closing duplicate tabs and already-seen links.
- Added the HTML archive page and the new web interface for link management.
- Updated the click-capture UI and state refresh when the window returns to focus.

## 0.2.0 - 2026-05-19

- Added Supabase authentication with magic link and incremental synchronization.
- Local saving of the bookmark folder and improved message handling and random link opening.
- Added contextual actions, toast feedback, and bar states in the content script.
- Added global query rules to ignore, navigation with current-page snapshot, and click-capture toggle.
- Introduced popups with quick actions, saved-link search, and header layout refinements.
- Added the extension packaging script and set up the initial project foundation.
