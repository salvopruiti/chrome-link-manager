# [1.2.0](https://github.com/salvopruiti/chrome-link-manager/compare/v1.1.2...v1.2.0) (2026-06-05)


### Features

* implement tracking and syncing of redirected URLs in tabs ([467bb06](https://github.com/salvopruiti/chrome-link-manager/commit/467bb060f4b27b96600c23010f86baa507f3b709))

## [1.1.2](https://github.com/salvopruiti/chrome-link-manager/compare/v1.1.1...v1.1.2) (2026-06-03)


### Bug Fixes

* correct Italian translations and improve message retrieval in background script ([aab2bbf](https://github.com/salvopruiti/chrome-link-manager/commit/aab2bbf4cc41579cd8bd173822482bde7cf7f3db))

## [1.1.1](https://github.com/salvopruiti/chrome-link-manager/compare/v1.1.0...v1.1.1) (2026-06-03)


### Bug Fixes

* correct property name for viewed date in current page status ([0b53af3](https://github.com/salvopruiti/chrome-link-manager/commit/0b53af3d0d98630ca3b3982f29abdf35d5a68be4))

# [1.1.0](https://github.com/salvopruiti/chrome-link-manager/compare/v1.0.0...v1.1.0) (2026-06-02)


### Features

* add sync fix functionality and update UI for sync operations ([fb784fd](https://github.com/salvopruiti/chrome-link-manager/commit/fb784fd669de1ec79065e129e44a77158013f01a))

# 1.0.0 (2026-06-02)


### Features

* add semantic-release configuration and GitHub Actions workflow ([72ed716](https://github.com/salvopruiti/chrome-link-manager/commit/72ed7165b9c4a1d56c87e4ec8e3224c155ad3809))

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
