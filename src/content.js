const ROOT_ID = "link-manager-root";
const STYLE_ID = "link-manager-style";
const BAR_MODE_STORAGE_KEY = "link-manager-bar-mode";

let extensionState = {
  entries: [],
  settings: {
    captureWithShift: true,
    captureAllClicks: false,
    bookmarkFolderTitle: "Link Manager",
  },
};

let initialized = false;
let barMode = "closed";
let searchQuery = "";
let currentPageState = createEmptyCurrentPageState();
let pendingAction = null;

bootstrap();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state-updated") {
    extensionState = message.payload;
    void refreshCurrentPageState({ preserveSnapshot: true }).then(renderBar);
    return;
  }

  if (message?.type === "show-toast") {
    flashMessage(
      message.payload?.text || "Operazione completata",
      Boolean(message.payload?.isError),
    );
  }
});

async function bootstrap() {
  if (initialized || !isHtmlDocument()) {
    return;
  }

  initialized = true;
  barMode = loadBarMode();
  installStyles();
  document.addEventListener("click", handleDocumentClick, true);

  try {
    const response = await sendMessage({ type: "get-state" });
    extensionState = response;
    await refreshCurrentPageState();
  } catch {
    return;
  }

  waitForBody(renderBar);
}

function isHtmlDocument() {
  return document.documentElement?.nodeName === "HTML";
}

function waitForBody(callback) {
  if (document.body) {
    callback();
    return;
  }

  const observer = new MutationObserver(() => {
    if (!document.body) {
      return;
    }

    observer.disconnect();
    callback();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

async function handleDocumentClick(event) {
  if (event.defaultPrevented || !shouldCaptureClick(event)) {
    return;
  }

  const anchor =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor) {
    return;
  }

  const url = anchor.href;
  if (!isSavableUrl(url)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  try {
    const result = await sendMessage({
      type: "save-link",
      payload: {
        url,
        title: anchor.getAttribute("title") || anchor.textContent || url,
        text: anchor.textContent || "",
        pageUrl: window.location.href,
      },
    });

    const feedback = {
      duplicate: "Link gia presente",
      bookmarked: "Link gia nei preferiti",
      saved: "Link salvato",
    };

    flashMessage(feedback[result.status] || "Operazione completata");
  } catch (error) {
    flashMessage(error.message || "Errore salvataggio", true);
  }
}

function shouldCaptureClick(event) {
  if (extensionState.settings.captureAllClicks) {
    return true;
  }

  if (
    !extensionState.settings.captureWithShift ||
    !event.shiftKey ||
    event.defaultPrevented
  ) {
    return;
  }

  return true;
}

function isSavableUrl(url) {
  return /^(https?:|ftp:)/i.test(url);
}

function createEmptyCurrentPageState() {
  return {
    canSave: isSavableUrl(window.location.href),
    savedEntry: null,
    isBookmarked: false,
    navigationSnapshot: null,
  };
}

async function refreshCurrentPageState(options = {}) {
  if (!isSavableUrl(window.location.href)) {
    currentPageState = createEmptyCurrentPageState();
    return;
  }

  try {
    const previousSnapshot = currentPageState.navigationSnapshot;
    const nextState = await sendMessage({
      type: "inspect-link",
      payload: { url: window.location.href },
    });

    currentPageState = {
      ...nextState,
      navigationSnapshot: nextState.savedEntry
        ? createNavigationSnapshot(nextState.savedEntry.id)
        : options.preserveSnapshot
          ? previousSnapshot
          : null,
    };
  } catch {
    currentPageState = createEmptyCurrentPageState();
  }
}

async function refreshBarState() {
  const state = await sendMessage({ type: "get-state" });
  extensionState = state;
  await refreshCurrentPageState();
  renderBar();
}

function syncCurrentPageStateFromEntries() {
  if (!isSavableUrl(window.location.href)) {
    currentPageState = createEmptyCurrentPageState();
    return;
  }

  const normalizedUrl = normalizeForCurrentSettings(window.location.href);
  currentPageState = {
    ...currentPageState,
    canSave: true,
    savedEntry:
      extensionState.entries.find(
        (entry) => entry.normalizedUrl === normalizedUrl,
      ) || null,
    navigationSnapshot: currentPageState.navigationSnapshot,
  };
}

function normalizeForCurrentSettings(url) {
  return normalizeUrlForUi(url, extensionState.settings.siteRules || {});
}

function removeEntryFromLocalState(entryId) {
  extensionState = {
    ...extensionState,
    entries: extensionState.entries.filter((entry) => entry.id !== entryId),
  };
  syncCurrentPageStateFromEntries();
}

function addEntryToLocalState(entry) {
  extensionState = {
    ...extensionState,
    entries: [
      entry,
      ...extensionState.entries.filter((item) => item.id !== entry.id),
    ],
  };
  syncCurrentPageStateFromEntries();
}

function setCurrentPageBookmarked(isBookmarked) {
  currentPageState = {
    ...currentPageState,
    isBookmarked,
  };
}

function setCurrentPageNavigationSnapshot(entryId) {
  currentPageState = {
    ...currentPageState,
    navigationSnapshot: createNavigationSnapshot(entryId),
  };
}

function createNavigationSnapshot(entryId) {
  const currentIndex = extensionState.entries.findIndex(
    (entry) => entry.id === entryId,
  );

  if (currentIndex === -1) {
    return null;
  }

  return {
    previousEntryId: extensionState.entries[currentIndex + 1]?.id || null,
    nextEntryId: extensionState.entries[currentIndex - 1]?.id || null,
  };
}

function getCurrentEntryNavigation() {
  if (!currentPageState.navigationSnapshot) {
    return { previousEntry: null, nextEntry: null };
  }

  return {
    previousEntry:
      extensionState.entries.find(
        (entry) => entry.id === currentPageState.navigationSnapshot.previousEntryId,
      ) || null,
    nextEntry:
      extensionState.entries.find(
        (entry) => entry.id === currentPageState.navigationSnapshot.nextEntryId,
      ) || null,
  };
}

function setPendingState(action, targetId = null) {
  pendingAction = { action, targetId };
}

function loadBarMode() {
  try {
    const storedMode = window.localStorage.getItem(BAR_MODE_STORAGE_KEY);
    return ["open", "closed", "icon"].includes(storedMode)
      ? storedMode
      : "closed";
  } catch {
    return "closed";
  }
}

function setBarMode(nextMode) {
  barMode = nextMode;

  try {
    window.localStorage.setItem(BAR_MODE_STORAGE_KEY, nextMode);
  } catch {
    // Ignore persistence errors.
  }
}

function clearPendingState() {
  pendingAction = null;
}

function isPending(action, targetId = null) {
  return Boolean(
    pendingAction &&
    pendingAction.action === action &&
    pendingAction.targetId === targetId,
  );
}

function isAnyPending() {
  return Boolean(pendingAction);
}

function renderBar() {
  if (!document.body) {
    return;
  }

  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
  }

  placeRoot(root);

  const previousSearchInput = root.querySelector(".lm-search-input");
  const shouldRestoreSearchFocus =
    previousSearchInput && document.activeElement === previousSearchInput;
  const searchSelectionStart = shouldRestoreSearchFocus
    ? previousSearchInput.selectionStart
    : null;
  const searchSelectionEnd = shouldRestoreSearchFocus
    ? previousSearchInput.selectionEnd
    : null;

  const filteredEntries = filterEntries(searchQuery, extensionState.entries);
  const busy = isAnyPending();
  const { previousEntry, nextEntry } = getCurrentEntryNavigation();
  const currentPageTitle =
    document.title?.trim() || window.location.hostname || window.location.href;
  const currentPageStatus = currentPageState.isBookmarked
    ? "Nei preferiti"
    : currentPageState.savedEntry
      ? "Nel database"
      : "Non salvata";
  const currentToggleAction = currentPageState.savedEntry
    ? "remove-current"
    : "save-current";
  const currentToggleLabel = currentPageState.savedEntry
    ? "Rimuovi"
    : "Aggiungi";
  const currentToggleIcon = currentPageState.savedEntry ? "trash" : "plus";
  const captureToggleLabel = extensionState.settings.captureAllClicks
    ? "Click automatico attivo"
    : "Salva tutti i click";
  const isIconMode = barMode === "icon";
  const isPanelOpen = barMode === "open";
  const resultsMarkup = !searchQuery.trim()
    ? '<li class="lm-empty">Scrivi nella ricerca per trovare un link salvato</li>'
    : filteredEntries.length
      ? filteredEntries
          .map(
            (entry) => `
              <li class="lm-entry" data-id="${escapeHtml(entry.id)}">
                <button class="lm-entry-open" data-action="open" data-id="${escapeHtml(entry.id)}" title="Apri link">
                  <span class="lm-entry-title">${escapeHtml(entry.title)}</span>
                  <span class="lm-entry-url">${escapeHtml(entry.url)}</span>
                </button>
                <div class="lm-entry-actions">
                  <button class="lm-icon-button" data-action="promote" data-id="${escapeHtml(entry.id)}" title="Aggiungi ai preferiti" aria-label="Aggiungi ai preferiti" ${getDisabledAttrs(busy)}>${isPending("promote", entry.id) ? spinnerMarkup() : iconMarkup("star")}</button>
                  <button class="lm-icon-button" data-action="remove" data-id="${escapeHtml(entry.id)}" title="Rimuovi" aria-label="Rimuovi" ${getDisabledAttrs(busy)}>${isPending("remove", entry.id) ? spinnerMarkup() : iconMarkup("trash")}</button>
                </div>
              </li>`,
          )
          .join("")
      : '<li class="lm-empty">Nessun risultato</li>';

  root.innerHTML = isIconMode
    ? `
    <div class="lm-shell lm-shell-icon ${busy ? "is-busy" : ""}">
      <button class="lm-icon-launcher" type="button" data-action="expand-from-icon" title="Apri Link Manager" aria-label="Apri Link Manager">
        ${iconMarkup("bolt")}
        <span class="lm-toggle-count">${extensionState.entries.length}</span>
      </button>
    </div>
  `
    : `
    <div class="lm-shell ${extensionState.entries.length ? "has-entries" : ""} ${busy ? "is-busy" : ""}">
      <div class="lm-topline">
      <button class="lm-toggle" type="button" data-action="toggle">
        <span class="lm-toggle-copy">${iconMarkup("bolt")} Link Manager</span>
        <span class="lm-toggle-count">${extensionState.entries.length}</span>
      </button>
      <div class="lm-top-actions">
        <button class="lm-minimize ${extensionState.settings.captureAllClicks ? "is-active" : ""}" type="button" data-action="toggle-capture-all" title="${captureToggleLabel}" aria-label="${captureToggleLabel}">
          ${iconMarkup("capture")}
        </button>
        <button class="lm-minimize" type="button" data-action="minimize-to-icon" title="Riduci a icona" aria-label="Riduci a icona">
          ${iconMarkup("minimize")}
        </button>
      </div>
      </div>
      <div class="lm-quick-actions">
        <button class="lm-icon-button" type="button" data-action="prev-current" data-id="${escapeHtml(previousEntry?.id || "")}" title="Link precedente" aria-label="Link precedente" ${getDisabledAttrs(busy || !previousEntry)}>${isPending("prev-current") ? spinnerMarkup() : iconMarkup("chevron-left")}</button>
        <button class="lm-icon-button" type="button" data-action="next-current" data-id="${escapeHtml(nextEntry?.id || "")}" title="Link successivo" aria-label="Link successivo" ${getDisabledAttrs(busy || !nextEntry)}>${isPending("next-current") ? spinnerMarkup() : iconMarkup("chevron-right")}</button>
        <button class="lm-icon-button" type="button" data-action="${currentToggleAction}" title="${currentToggleLabel} link corrente" aria-label="${currentToggleLabel} link corrente" ${getDisabledAttrs(busy || !currentPageState.canSave || (!currentPageState.savedEntry && currentPageState.isBookmarked))}>${isPending(currentToggleAction) ? spinnerMarkup() : iconMarkup(currentToggleIcon)}</button>
        <button class="lm-icon-button" type="button" data-action="bookmark-current" title="Aggiungi pagina corrente ai preferiti" aria-label="Aggiungi pagina corrente ai preferiti" ${getDisabledAttrs(busy || !currentPageState.canSave || currentPageState.isBookmarked)}>${isPending("bookmark-current") ? spinnerMarkup() : iconMarkup("star")}</button>
        <button class="lm-icon-button" type="button" data-action="random" title="Apri link casuale" aria-label="Apri link casuale" ${getDisabledAttrs(busy)}>${isPending("random") ? spinnerMarkup() : iconMarkup("shuffle")}</button>
      </div>
      <section class="lm-panel" data-collapsed="${String(!isPanelOpen)}">
        <header class="lm-toolbar">
          <strong>${iconMarkup("bolt")} ${extensionState.settings.captureAllClicks ? "Salvataggio click attivo" : "Salvati con Shift+Click"}</strong>
          <div class="lm-toolbar-actions">
            <button class="lm-icon-button ${extensionState.settings.captureAllClicks ? "is-active" : ""}" type="button" data-action="toggle-capture-all" title="${captureToggleLabel}" aria-label="${captureToggleLabel}" ${getDisabledAttrs(busy)}>${isPending("toggle-capture-all") ? spinnerMarkup() : iconMarkup("capture")}</button>
            <button class="lm-icon-button" type="button" data-action="save-open-tabs" title="Salva tutte le schede" aria-label="Salva tutte le schede" ${getDisabledAttrs(busy)}>${isPending("save-open-tabs") ? spinnerMarkup() : iconMarkup("tabs")}</button>
            <button class="lm-icon-button" type="button" data-action="random" title="Apri link casuale" aria-label="Apri link casuale" ${getDisabledAttrs(busy)}>${isPending("random") ? spinnerMarkup() : iconMarkup("shuffle")}</button>
            <button class="lm-icon-button" type="button" data-action="refresh" title="Aggiorna" aria-label="Aggiorna" ${getDisabledAttrs(busy)}>${isPending("refresh") ? spinnerMarkup() : iconMarkup("refresh")}</button>
          </div>
        </header>
        <section class="lm-current-card">
          <div class="lm-current-copy">
            <span class="lm-kicker">Pagina corrente</span>
            <strong title="${escapeHtml(currentPageTitle)}">${escapeHtml(currentPageTitle)}</strong>
            <span class="lm-current-status">${escapeHtml(currentPageStatus)}</span>
          </div>
          <div class="lm-current-actions">
            <button class="lm-action-button" type="button" data-action="${currentToggleAction}" ${getDisabledAttrs(busy || !currentPageState.canSave || (!currentPageState.savedEntry && currentPageState.isBookmarked))}>
              ${isPending(currentToggleAction) ? spinnerMarkup() : iconMarkup(currentToggleIcon)}
              <span>${currentToggleLabel}</span>
            </button>
            <button class="lm-action-button" type="button" data-action="bookmark-current" ${getDisabledAttrs(busy || !currentPageState.canSave || currentPageState.isBookmarked)}>
              ${isPending("bookmark-current") ? spinnerMarkup() : iconMarkup("star")}
              <span>Preferiti</span>
            </button>
          </div>
        </section>
        <div class="lm-search-shell">
          <label class="lm-search" aria-label="Cerca link salvati">
            <span class="lm-search-icon">${iconMarkup("search")}</span>
            <input class="lm-search-input" type="search" placeholder="Cerca nei link salvati" value="${escapeHtml(searchQuery)}">
          </label>
        </div>
        <ul class="lm-list">${resultsMarkup}</ul>
      </section>
    </div>
  `;

  attachUiHandlers(root);

  if (shouldRestoreSearchFocus) {
    const nextSearchInput = root.querySelector(".lm-search-input");
    nextSearchInput?.focus({ preventScroll: true });
    if (
      nextSearchInput &&
      searchSelectionStart !== null &&
      searchSelectionEnd !== null
    ) {
      nextSearchInput.setSelectionRange(
        searchSelectionStart,
        searchSelectionEnd,
      );
    }
  }
}

function attachUiHandlers(root) {
  const panel = root.querySelector(".lm-panel");
  const toggle = root.querySelector(".lm-toggle");
  const searchInput = root.querySelector(".lm-search-input");
  const minimize = root.querySelector('[data-action="minimize-to-icon"]');
  const iconLauncher = root.querySelector(".lm-icon-launcher");

  toggle?.addEventListener("click", () => {
    setBarMode(barMode === "open" ? "closed" : "open");
    panel?.setAttribute("data-collapsed", String(barMode !== "open"));
  });

  minimize?.addEventListener("click", () => {
    setBarMode("icon");
    renderBar();
  });

  iconLauncher?.addEventListener("click", () => {
    setBarMode("closed");
    renderBar();
  });

  searchInput?.addEventListener("input", (event) => {
    searchQuery = event.target.value;
    renderBar();
  });

  root.querySelectorAll("[data-action]").forEach((button) => {
    if (
      ["toggle", "minimize-to-icon", "expand-from-icon"].includes(
        button.getAttribute("data-action"),
      )
    ) {
      return;
    }

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.getAttribute("data-action");
      const id = button.getAttribute("data-id");

      if (button.hasAttribute("disabled")) {
        return;
      }

      setPendingState(action, id || null);
      renderBar();

      try {
        switch (action) {
          case "prev-current":
            if (id) {
              const targetEntry = extensionState.entries.find(
                (entry) => entry.id === id,
              );
              if (targetEntry) {
                window.location.href = targetEntry.url;
                return;
              }
            }
            break;
          case "next-current":
            if (id) {
              const targetEntry = extensionState.entries.find(
                (entry) => entry.id === id,
              );
              if (targetEntry) {
                window.location.href = targetEntry.url;
                return;
              }
            }
            break;
          case "save-current": {
            const result = await sendMessage({
              type: "save-link",
              payload: {
                url: window.location.href,
                title: document.title || window.location.href,
                text: "",
                pageUrl: window.location.href,
              },
            });
            flashMessage(formatSaveFeedback(result.status));
            if (result.entry) {
              addEntryToLocalState(result.entry);
              setCurrentPageNavigationSnapshot(result.entry.id);
            }
            renderBar();
            break;
          }
          case "bookmark-current": {
            const result = await sendMessage({
              type: "bookmark-link",
              payload: {
                url: window.location.href,
                title: document.title || window.location.href,
              },
            });
            flashMessage(
              result.alreadyBookmarked
                ? "Pagina gia nei preferiti"
                : "Pagina aggiunta ai preferiti",
            );
            setCurrentPageBookmarked(true);
            if (currentPageState.savedEntry) {
              removeEntryFromLocalState(currentPageState.savedEntry.id);
            }
            renderBar();
            break;
          }
          case "remove-current": {
            const result = await sendMessage({
              type: "remove-link-by-url",
              payload: { url: window.location.href },
            });
            flashMessage(
              result.removed
                ? "Pagina rimossa dal database"
                : "Pagina non presente nel database",
            );
            if (currentPageState.savedEntry) {
              removeEntryFromLocalState(currentPageState.savedEntry.id);
              renderBar();
            }
            break;
          }
          case "open":
            await sendMessage({
              type: "open-link",
              payload: { id, active: true },
            });
            break;
          case "remove":
            await sendMessage({ type: "remove-link", payload: { id } });
            removeEntryFromLocalState(id);
            renderBar();
            break;
          case "promote":
            await sendMessage({ type: "promote-link", payload: { id } });
            flashMessage("Link spostato nei preferiti");
            removeEntryFromLocalState(id);
            renderBar();
            break;
          case "save-open-tabs": {
            const result = await sendMessage({ type: "save-open-tabs" });
            flashMessage(formatBatchSaveMessage(result));
            break;
          }
          case "toggle-capture-all": {
            const nextValue = !extensionState.settings.captureAllClicks;
            extensionState.settings = await sendMessage({
              type: "update-settings",
              payload: { captureAllClicks: nextValue },
            });
            flashMessage(
              nextValue
                ? "Salvataggio automatico link attivato"
                : "Salvataggio automatico link disattivato",
            );
            break;
          }
          case "random":
            await sendMessage({ type: "open-random-link" });
            break;
          case "refresh": {
            await refreshBarState();
            break;
          }
          default:
            break;
        }
      } catch (error) {
        flashMessage(error.message || "Operazione fallita", true);
      } finally {
        clearPendingState();
        renderBar();
      }
    });
  });
}

function placeRoot(root) {
  if (
    root.parentElement !== document.body ||
    document.body.lastChild !== root
  ) {
    document.body.appendChild(root);
  }
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      all: initial;
      display: block;
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      font-family: "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.4;
      color: #f4efe6;
      direction: ltr;
      text-align: left;
      text-size-adjust: none;
    }

    #${ROOT_ID},
    #${ROOT_ID} * {
      box-sizing: border-box;
    }

    #${ROOT_ID} .lm-shell {
      width: min(360px, calc(100vw - 32px));
      max-width: min(360px, calc(100vw - 32px));
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(14, 23, 44, 0.35);
      background: linear-gradient(180deg, #18243f 0%, #0b1324 100%);
      border: 1px solid rgba(255, 255, 255, 0.12);
      backdrop-filter: blur(10px);
      position: relative;
    }

    #${ROOT_ID} .lm-shell.lm-shell-icon {
      width: auto;
      max-width: none;
      border-radius: 999px;
      overflow: visible;
      background: transparent;
      border: 0;
      backdrop-filter: none;
      box-shadow: none;
    }

    #${ROOT_ID} .lm-shell.is-busy {
      box-shadow: 0 24px 60px rgba(14, 23, 44, 0.45);
    }

    #${ROOT_ID} button {
      appearance: none;
      border: 0;
      cursor: pointer;
      font: inherit;
      line-height: 1.2;
    }

    #${ROOT_ID} .lm-topline {
      display: flex;
      align-items: stretch;
      position: relative;
      background: linear-gradient(90deg, #d9771f 0%, #f2bb69 100%);
    }

    #${ROOT_ID} .lm-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex: 1;
      min-width: 0;
      padding: 12px 16px;
      text-align: left;
      background: transparent;
      color: #24170b;
      font-weight: 700;
    }

    #${ROOT_ID} .lm-top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px 8px 12px;
      background: linear-gradient(90deg, rgba(36, 23, 11, 0.04) 0%, rgba(36, 23, 11, 0.1) 100%);
      border-left: 1px solid rgba(36, 23, 11, 0.12);
    }

    #${ROOT_ID} .lm-minimize {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border-radius: 999px;
      background: rgba(255, 248, 236, 0.78);
      color: #1d140b;
      flex: 0 0 auto;
      box-shadow: inset 0 0 0 1px rgba(36, 23, 11, 0.12);
    }

    #${ROOT_ID} .lm-minimize.is-active,
    #${ROOT_ID} .lm-toolbar-actions .lm-icon-button.is-active {
      background: rgba(255, 245, 227, 0.96);
      box-shadow: inset 0 0 0 1px rgba(36, 23, 11, 0.18);
    }

    #${ROOT_ID} .lm-top-actions .lm-icon,
    #${ROOT_ID} .lm-top-actions .lm-icon svg {
      width: 18px;
      height: 18px;
    }

    #${ROOT_ID} .lm-top-actions .lm-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
    }

    #${ROOT_ID} .lm-top-actions button:hover {
      background: rgba(255, 250, 241, 0.94);
    }

    #${ROOT_ID} .lm-icon-launcher {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-width: 56px;
      height: 56px;
      padding: 0 14px;
      border-radius: 999px;
      background: linear-gradient(135deg, #e67e22 0%, #f0b35a 100%);
      color: #24170b;
      box-shadow: 0 24px 60px rgba(14, 23, 44, 0.35);
      font-weight: 700;
    }

    #${ROOT_ID} .lm-toggle-copy {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      white-space: nowrap;
    }

    #${ROOT_ID} .lm-toggle-count {
      min-width: 28px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(36, 23, 11, 0.16);
      text-align: center;
    }

    #${ROOT_ID} .lm-panel[data-collapsed="true"] {
      display: none;
    }

    #${ROOT_ID} .lm-quick-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px;
      background: rgba(5, 10, 20, 0.28);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    #${ROOT_ID} .lm-quick-actions .lm-icon-button {
      padding: 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
      color: #f4efe6;
      flex: 0 0 auto;
    }

    #${ROOT_ID} .lm-toolbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    #${ROOT_ID} .lm-toolbar strong {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    #${ROOT_ID} .lm-toolbar-actions,
    #${ROOT_ID} .lm-entry-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    #${ROOT_ID} .lm-toolbar-actions {
      justify-content: flex-end;
      margin-left: auto;
    }

    #${ROOT_ID} .lm-toolbar-actions button,
    #${ROOT_ID} .lm-entry-actions button {
      padding: 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
      color: #f4efe6;
    }

    #${ROOT_ID} .lm-icon,
    #${ROOT_ID} .lm-icon svg {
      display: block;
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    #${ROOT_ID} .lm-icon-button,
    #${ROOT_ID} .lm-action-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    #${ROOT_ID} .lm-action-button {
      padding: 9px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.1);
      color: #f4efe6;
    }

    #${ROOT_ID} button[disabled] {
      opacity: 0.45;
      cursor: progress;
    }

    #${ROOT_ID} .lm-spinner,
    #${ROOT_ID} .lm-spinner svg {
      display: block;
      width: 16px;
      height: 16px;
    }

    #${ROOT_ID} .lm-spinner svg {
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      animation: lm-spin 0.9s linear infinite;
    }

    #${ROOT_ID} .lm-current-card {
      display: grid;
      gap: 12px;
      margin: 12px 16px 10px;
      padding: 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    #${ROOT_ID} .lm-current-copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    #${ROOT_ID} .lm-kicker {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.68;
    }

    #${ROOT_ID} .lm-current-copy strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .lm-current-status {
      font-size: 12px;
      color: #f0b35a;
    }

    #${ROOT_ID} .lm-current-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    #${ROOT_ID} .lm-search-shell {
      padding: 0 16px 12px;
    }

    #${ROOT_ID} .lm-search {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    #${ROOT_ID} .lm-search-input {
      all: unset;
      flex: 1;
      min-width: 0;
      color: #f4efe6;
      font: inherit;
    }

    #${ROOT_ID} .lm-search-input::placeholder {
      color: rgba(244, 239, 230, 0.55);
    }

    #${ROOT_ID} .lm-list {
      list-style: none;
      margin: 0;
      padding: 0 8px 8px;
      max-height: min(42vh, 320px);
      overflow: auto;
    }

    #${ROOT_ID} .lm-entry,
    #${ROOT_ID} .lm-empty {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      padding: 8px;
      border-radius: 12px;
      margin-bottom: 8px;
      background: rgba(255, 255, 255, 0.06);
    }

    #${ROOT_ID} .lm-entry-open {
      display: grid;
      gap: 3px;
      flex: 1;
      min-width: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #${ROOT_ID} .lm-entry-title,
    #${ROOT_ID} .lm-entry-url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .lm-entry-url {
      opacity: 0.66;
      font-size: 12px;
    }

    #${ROOT_ID} .lm-entry-actions {
      flex-shrink: 0;
    }

    #${ROOT_ID} .lm-empty {
      justify-content: center;
      opacity: 0.75;
    }

    #${ROOT_ID} .lm-toast {
      margin-top: 8px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(230, 126, 34, 0.95);
      color: #24170b;
      font-size: 13px;
      animation: lm-fade 2.4s ease forwards;
    }

    #${ROOT_ID} .lm-toast.is-error {
      background: rgba(227, 84, 84, 0.95);
      color: #fff;
    }

    @keyframes lm-fade {
      0%, 80% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(8px); }
    }

    @keyframes lm-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;

  document.documentElement.appendChild(style);
}

function filterEntries(query, entries) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return entries
    .filter((entry) =>
      [entry.title, entry.url, entry.pageUrl]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    )
    .slice(0, 40);
}

function formatSaveFeedback(status) {
  const feedback = {
    duplicate: "Link gia presente",
    bookmarked: "Link gia nei preferiti",
    saved: "Link salvato",
  };

  return feedback[status] || "Operazione completata";
}

function getDisabledAttrs(disabled) {
  return disabled ? 'disabled aria-disabled="true"' : "";
}

function iconMarkup(name) {
  const icons = {
    bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 5 14h5l-1 8 8-12h-5l1-8Z"/></svg>',
    capture:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 7.5h2.1l1.2-1.7c.22-.31.58-.5.96-.5h2.6c.38 0 .74.19.96.5l1.2 1.7h2.1A2.4 2.4 0 0 1 21 9.9v6.6a2.4 2.4 0 0 1-2.4 2.4H5.4A2.4 2.4 0 0 1 3 16.5V9.9a2.4 2.4 0 0 1 2.4-2.4Zm5.1 2.3a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Zm0 1.8a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z"/></svg>',
    minimize:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8.25h12a.75.75 0 0 1 0 1.5H6a.75.75 0 0 1 0-1.5Zm3 5.5h9a.75.75 0 0 1 0 1.5H9a.75.75 0 0 1 0-1.5Z"/></svg>',
    "chevron-left":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>',
    "chevron-right":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.59 16.59 1.41 1.41 6-6-6-6-1.41 1.41L13.17 12z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z"/></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a5 5 0 1 1-4.9 6h-2.02A7 7 0 1 0 17.65 6.35Z"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 0 3.87 10.58l4.27 4.28 1.42-1.42-4.28-4.27A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>',
    shuffle:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H16V3ZM4 7h3.59l9 9H20v-2h-2.59l-9-9H4V7Zm9.29 5.29 1.42 1.42L10.41 18H13v2H8v-5h2v1.59l3.29-3.3ZM19 19v-1.59l-2.29-2.3 1.42-1.42 2.87 2.88V14h2v5h-5Z"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"/></svg>',
    tabs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h12v10H4zM2 3h16v14H2zM8 9h14v12H8zm2 2v8h10v-8H10Z"/></svg>',
    trash:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v8H8V9Zm6 0h2v8h-2V9ZM6 9h12l-1 11H7L6 9Z"/></svg>',
  };

  return `<span class="lm-icon">${icons[name] || ""}</span>`;
}

function spinnerMarkup() {
  return '<span class="lm-spinner" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" opacity="0.25"></circle><path d="M20 12a8 8 0 0 0-8-8"></path></svg></span>';
}

function flashMessage(text, isError = false) {
  const root = document.getElementById(ROOT_ID);
  if (!root) {
    return;
  }

  const existingToast = root.querySelector(".lm-toast");
  existingToast?.remove();

  const toast = document.createElement("div");
  toast.className = `lm-toast${isError ? " is-error" : ""}`;
  toast.textContent = text;
  root.appendChild(toast);

  window.setTimeout(() => toast.remove(), 2400);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Unknown error"));
        return;
      }

      resolve(response.result);
    });
  });
}

function formatBatchSaveMessage(result) {
  if (!result?.totalCount) {
    return "Nessuna scheda compatibile trovata";
  }

  const parts = [];
  if (result.savedCount) {
    parts.push(`${result.savedCount} salvate`);
  }
  if (result.duplicateCount) {
    parts.push(`${result.duplicateCount} gia presenti`);
  }
  if (result.bookmarkedCount) {
    parts.push(`${result.bookmarkedCount} gia nei preferiti`);
  }

  return parts.length ? parts.join(" • ") : "Nessuna nuova scheda da salvare";
}

function normalizeUrlForUi(input, siteRules = {}) {
  const url = new URL(input);
  url.hash = "";

  const ignoredParams = resolveIgnoredParamsForUi(url.hostname, siteRules);
  for (const param of ignoredParams) {
    url.searchParams.delete(param);
  }

  url.search = sortSearchParamsForUi(url.searchParams).toString();

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

function resolveIgnoredParamsForUi(hostname, siteRules) {
  const normalizedHostname = hostname.toLowerCase();
  const directRules = siteRules[normalizedHostname] || [];
  const wildcardRules = Object.entries(siteRules)
    .filter(([ruleHostname]) => ruleHostname.startsWith("*."))
    .filter(
      ([ruleHostname]) =>
        normalizedHostname === ruleHostname.slice(2) ||
        normalizedHostname.endsWith(`.${ruleHostname.slice(2)}`),
    )
    .flatMap(([, params]) => params);

  return [...new Set([...directRules, ...wildcardRules])];
}

function sortSearchParamsForUi(searchParams) {
  const sorted = new URLSearchParams();
  const pairs = [...searchParams.entries()].sort(
    ([aKey, aValue], [bKey, bValue]) => {
      if (aKey === bKey) {
        return aValue.localeCompare(bValue);
      }

      return aKey.localeCompare(bKey);
    },
  );

  for (const [key, value] of pairs) {
    sorted.append(key, value);
  }

  return sorted;
}
