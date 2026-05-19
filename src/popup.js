const searchInput = document.getElementById("searchInput");
const filterSeenButton = document.getElementById("filterSeenButton");
const filterFavoriteButton = document.getElementById("filterFavoriteButton");
const resultsNode = document.getElementById("results");
const countNode = document.getElementById("count");
const statusNode = document.getElementById("status");
const syncSummaryNode = document.getElementById("syncSummary");
const quickActionsNode = document.getElementById("quickActions");
const openArchiveButton = document.getElementById("openArchiveButton");

let popupState = {
  entries: [],
  settings: {},
};
let activeTab = null;
let currentPageState = createEmptyCurrentPageState();
let searchQuery = "";
let filterSeenOnly = false;
let filterFavoriteOnly = false;
let pendingAction = null;

init();

searchInput.addEventListener("input", (event) => {
  searchQuery = event.target.value;
  render();
});

filterSeenButton.addEventListener("click", () => {
  filterSeenOnly = !filterSeenOnly;
  render();
});

filterFavoriteButton.addEventListener("click", () => {
  filterFavoriteOnly = !filterFavoriteOnly;
  render();
});

openArchiveButton.addEventListener("click", openArchivePage);

async function init() {
  try {
    const [state, tabs] = await Promise.all([
      sendMessage({ type: "get-state" }),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);

    popupState = state;
    activeTab = tabs[0] || null;
    await refreshCurrentPageState();
    render();
  } catch (error) {
    setStatus(error.message || "Impossibile caricare i link", true);
  }
}

function render() {
  countNode.textContent = String(popupState.entries.length);
  renderSyncSummary();
  renderFilterState();

  renderQuickActions();

  const filteredEntries = filterEntries(searchQuery, popupState.entries);
  const hasActiveSearch = Boolean(
    searchQuery.trim() || filterSeenOnly || filterFavoriteOnly,
  );
  resultsNode.innerHTML = !hasActiveSearch
    ? '<li class="empty">Scrivi nella ricerca per trovare un link salvato</li>'
    : filteredEntries.length
      ? filteredEntries
          .map(
            (entry) => `
              <li class="entry" data-id="${escapeHtml(entry.id)}">
                <button class="open" data-action="open" data-id="${escapeHtml(entry.id)}" title="Apri in nuova scheda">
                  <span class="title">${escapeHtml(entry.title)}</span>
                  <span class="url">${escapeHtml(entry.url)}</span>
                </button>
                <div class="actions">
                  <button class="icon-button${getToggleStateClass("seen", entry.isSeen)}" data-action="toggle-seen" data-id="${escapeHtml(entry.id)}" title="${entry.isSeen ? "Togli visto" : "Segna visto"}" aria-label="${entry.isSeen ? "Togli visto" : "Segna visto"}">
                    ${isPending("toggle-seen", entry.id) ? spinnerMarkup() : iconMarkup(entry.isSeen ? "check-badge" : "check")}
                  </button>
                  <button class="icon-button${getToggleStateClass("favorite", entry.isFavorite)}" data-action="toggle-favorite" data-id="${escapeHtml(entry.id)}" title="${entry.isFavorite ? "Togli favorito" : "Segna favorito"}" aria-label="${entry.isFavorite ? "Togli favorito" : "Segna favorito"}">
                    ${isPending("toggle-favorite", entry.id) ? spinnerMarkup() : iconMarkup(entry.isFavorite ? "star-filled" : "star")}
                  </button>
                  <button class="icon-button" data-action="remove" data-id="${escapeHtml(entry.id)}" title="Rimuovi" aria-label="Rimuovi">
                    ${isPending("remove", entry.id) ? spinnerMarkup() : iconMarkup("trash")}
                  </button>
                </div>
              </li>`,
          )
          .join("")
      : '<li class="empty">Nessun risultato</li>';

  resultsNode.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const id = button.getAttribute("data-id");

      if (!action || !id) {
        return;
      }

      await runAction(
        action,
        async () => {
          switch (action) {
            case "open":
              await sendMessage({
                type: "open-link",
                payload: { id, active: true, openInNewTab: true },
              });
              window.close();
              break;
            case "remove":
              await sendMessage({ type: "remove-link", payload: { id } });
              popupState.entries = popupState.entries.filter(
                (entry) => entry.id !== id,
              );
              syncCurrentPageStateFromEntries({ preserveSnapshot: true });
              setStatus("Link rimosso");
              break;
            case "toggle-seen":
              {
                const result = await sendMessage({
                  type: "toggle-seen",
                  payload: { id },
                });
                if (result.entry) {
                  replaceEntryInPopupState(result.entry);
                }
                syncCurrentPageStateFromEntries({ preserveSnapshot: true });
                setStatus(
                  result.enabled
                    ? "Link segnato come visto"
                    : "Link segnato come non visto",
                );
              }
              break;
            case "toggle-favorite":
              {
                const result = await sendMessage({
                  type: "toggle-favorite",
                  payload: { id },
                });
                if (result.entry) {
                  replaceEntryInPopupState(result.entry);
                }
                syncCurrentPageStateFromEntries({ preserveSnapshot: true });
                setStatus(
                  result.enabled
                    ? "Link aggiunto ai favoriti"
                    : "Link rimosso dai favoriti",
                );
              }
              break;
            default:
              break;
          }
        },
        id,
      );
    });
  });
}

function renderSyncSummary() {
  const sync = popupState.sync || {};

  if (sync.isSyncing) {
    syncSummaryNode.textContent = "Sync in corso";
    return;
  }

  if (sync.pendingCount) {
    const nextFlush = sync.nextFlushAt
      ? ` • flush ${formatDateTime(sync.nextFlushAt)}`
      : "";
    syncSummaryNode.textContent = `${sync.pendingCount} in coda${nextFlush}`;
    return;
  }

  syncSummaryNode.textContent = "Nessuna modifica in coda";
}

function renderFilterState() {
  filterSeenButton.classList.toggle("is-active", filterSeenOnly);
  filterFavoriteButton.classList.toggle("is-active", filterFavoriteOnly);
}

function renderQuickActions() {
  const navigableEntries = getNavigableEntries();
  const { previousEntry, nextEntry } = getCurrentEntryNavigation();
  const currentToggleAction = currentPageState.savedEntry
    ? "remove-current"
    : "save-current";
  const currentToggleIcon = currentPageState.savedEntry ? "trash" : "plus";
  const currentPageExtraActions = currentPageState.savedEntry
    ? `
    <button class="icon-button" type="button" data-action="toggle-seen-current" title="${currentPageState.isSeen ? "Togli visto" : "Segna visto"}" aria-label="${currentPageState.isSeen ? "Togli visto" : "Segna visto"}" ${getDisabledAttrs(isAnyPending())}>
      ${isPending("toggle-seen-current") ? spinnerMarkup() : iconMarkup("check")}
    </button>
    <button class="icon-button" type="button" data-action="toggle-favorite-current" title="${currentPageState.isFavorite ? "Togli favorito" : "Segna favorito"}" aria-label="${currentPageState.isFavorite ? "Togli favorito" : "Segna favorito"}" ${getDisabledAttrs(isAnyPending())}>
      ${isPending("toggle-favorite-current") ? spinnerMarkup() : iconMarkup("star")}
    </button>`
    : "";

  quickActionsNode.innerHTML = `
    <button class="icon-button" type="button" data-action="prev-current" data-id="${escapeHtml(previousEntry?.id || "")}" title="Link precedente" aria-label="Link precedente" ${getDisabledAttrs(!previousEntry || isAnyPending())}>
      ${isPending("prev-current") ? spinnerMarkup() : iconMarkup("chevron-left")}
    </button>
    <button class="icon-button" type="button" data-action="next-current" data-id="${escapeHtml(nextEntry?.id || "")}" title="Link successivo" aria-label="Link successivo" ${getDisabledAttrs(!nextEntry || isAnyPending())}>
      ${isPending("next-current") ? spinnerMarkup() : iconMarkup("chevron-right")}
    </button>
    <button class="icon-button" type="button" data-action="${currentToggleAction}" title="Aggiungi o rimuovi pagina corrente" aria-label="Aggiungi o rimuovi pagina corrente" ${getDisabledAttrs(isAnyPending() || !currentPageState.canSave)}>
      ${isPending(currentToggleAction) ? spinnerMarkup() : iconMarkup(currentToggleIcon)}
    </button>
    ${currentPageExtraActions}
    <button class="icon-button" type="button" data-action="random" title="Apri link casuale" aria-label="Apri link casuale" ${getDisabledAttrs(isAnyPending() || !navigableEntries.length)}>
      ${isPending("random") ? spinnerMarkup() : iconMarkup("shuffle")}
    </button>
  `;

  quickActionsNode.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const id = button.getAttribute("data-id");

      if (!action || button.hasAttribute("disabled")) {
        return;
      }

      await runAction(
        action,
        async () => {
          switch (action) {
            case "prev-current":
            case "next-current":
              if (id) {
                const targetEntry = popupState.entries.find(
                  (entry) => entry.id === id,
                );
                if (targetEntry && typeof activeTab?.id === "number") {
                  await chrome.tabs.update(activeTab.id, {
                    url: targetEntry.url,
                    active: true,
                  });
                  window.close();
                }
              }
              break;
            case "save-current": {
              const result = await sendMessage({
                type: "save-link",
                payload: {
                  url: activeTab?.url,
                  title: activeTab?.title || activeTab?.url,
                  text: "",
                  pageUrl: activeTab?.url,
                },
              });
              setStatus(formatSaveFeedback(result.status));
              if (result.entry) {
                popupState.entries = [
                  result.entry,
                  ...popupState.entries.filter(
                    (entry) => entry.id !== result.entry.id,
                  ),
                ];
                currentPageState.normalizedUrl = result.entry.normalizedUrl;
              }
              syncCurrentPageStateFromEntries();
              break;
            }
            case "remove-current": {
              const result = await sendMessage({
                type: "remove-link-by-url",
                payload: { url: activeTab?.url },
              });
              setStatus(
                result.removed
                  ? "Pagina rimossa dal database"
                  : "Pagina non presente nel database",
              );
              popupState.entries = popupState.entries.filter(
                (entry) =>
                  entry.normalizedUrl !== currentPageState.normalizedUrl,
              );
              syncCurrentPageStateFromEntries({ preserveSnapshot: true });
              break;
            }
            case "bookmark-current": {
              const result = await sendMessage({
                type: "bookmark-link",
                payload: {
                  url: activeTab?.url,
                  title: activeTab?.title || activeTab?.url,
                },
              });
              setStatus(
                result.alreadyBookmarked
                  ? "Pagina gia tra i favoriti"
                  : "Pagina aggiunta ai favoriti",
              );
              if (result.entry) {
                popupState.entries = [
                  result.entry,
                  ...popupState.entries.filter(
                    (entry) => entry.id !== result.entry.id,
                  ),
                ];
                currentPageState.normalizedUrl = result.entry.normalizedUrl;
              }
              syncCurrentPageStateFromEntries({ preserveSnapshot: true });
              break;
            }
            case "toggle-seen-current": {
              if (!currentPageState.savedEntry) {
                break;
              }

              const result = await sendMessage({
                type: "toggle-seen",
                payload: { id: currentPageState.savedEntry.id },
              });
              replaceEntryInPopupState(result.entry);
              syncCurrentPageStateFromEntries({ preserveSnapshot: true });
              setStatus(
                result.enabled
                  ? "Pagina segnata come vista"
                  : "Pagina segnata come non vista",
              );
              break;
            }
            case "toggle-favorite-current": {
              if (!currentPageState.savedEntry) {
                break;
              }

              const result = await sendMessage({
                type: "toggle-favorite",
                payload: { id: currentPageState.savedEntry.id },
              });
              replaceEntryInPopupState(result.entry);
              syncCurrentPageStateFromEntries({ preserveSnapshot: true });
              setStatus(
                result.enabled
                  ? "Pagina aggiunta ai favoriti"
                  : "Pagina rimossa dai favoriti",
              );
              break;
            }
            case "random":
              await sendMessage({
                type: "open-random-link",
                payload: {
                  tabId: activeTab?.id,
                  windowId: activeTab?.windowId,
                },
              });
              window.close();
              break;
            default:
              break;
          }
        },
        id || null,
      );
    });
  });
}

async function runAction(action, callback, targetId = null) {
  try {
    pendingAction = { action, targetId };
    render();
    await callback();
    render();
  } catch (error) {
    setStatus(error.message || "Operazione fallita", true);
  } finally {
    pendingAction = null;
    render();
  }
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

function createEmptyCurrentPageState() {
  return {
    canSave: isSavableUrl(activeTab?.url || ""),
    normalizedUrl: null,
    savedEntry: null,
    isFavorite: false,
    isSeen: false,
    navigationSnapshot: null,
  };
}

async function refreshCurrentPageState(options = {}) {
  if (!isSavableUrl(activeTab?.url || "")) {
    currentPageState = createEmptyCurrentPageState();
    return;
  }

  try {
    const previousSnapshot = currentPageState.navigationSnapshot;
    const nextState = await sendMessage({
      type: "inspect-link",
      payload: { url: activeTab.url },
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

function syncCurrentPageStateFromEntries(options = {}) {
  if (!isSavableUrl(activeTab?.url || "")) {
    currentPageState = createEmptyCurrentPageState();
    return;
  }

  const previousSnapshot = currentPageState.navigationSnapshot;
  const normalizedUrl = currentPageState.normalizedUrl;
  let savedEntry = null;

  if (currentPageState.savedEntry?.id) {
    savedEntry =
      popupState.entries.find(
        (entry) => entry.id === currentPageState.savedEntry.id,
      ) || null;
  }

  if (!savedEntry && normalizedUrl) {
    savedEntry =
      popupState.entries.find(
        (entry) => entry.normalizedUrl === normalizedUrl,
      ) || null;
  }

  currentPageState = {
    ...currentPageState,
    canSave: true,
    normalizedUrl: savedEntry?.normalizedUrl || normalizedUrl || null,
    savedEntry,
    isFavorite: Boolean(savedEntry?.isFavorite),
    isSeen: Boolean(savedEntry?.isSeen),
    navigationSnapshot: savedEntry
      ? createNavigationSnapshot(savedEntry.id)
      : options.preserveSnapshot
        ? previousSnapshot
        : null,
  };
}

function createNavigationSnapshot(entryId) {
  const navigableEntries = getNavigableEntries(entryId);
  const currentIndex = navigableEntries.findIndex(
    (entry) => entry.id === entryId,
  );
  if (currentIndex === -1) {
    return null;
  }

  return {
    previousEntryId: navigableEntries[currentIndex + 1]?.id || null,
    nextEntryId: navigableEntries[currentIndex - 1]?.id || null,
  };
}

function getCurrentEntryNavigation() {
  const navigableEntries = getNavigableEntries(currentPageState.savedEntry?.id);

  if (!currentPageState.navigationSnapshot) {
    return { previousEntry: null, nextEntry: null };
  }

  return {
    previousEntry:
      navigableEntries.find(
        (entry) =>
          entry.id === currentPageState.navigationSnapshot.previousEntryId,
      ) || null,
    nextEntry:
      navigableEntries.find(
        (entry) => entry.id === currentPageState.navigationSnapshot.nextEntryId,
      ) || null,
  };
}

function getNavigableEntries(preservedEntryId = null) {
  return popupState.entries.filter((entry) => {
    if (preservedEntryId && entry.id === preservedEntryId) {
      return true;
    }

    if (popupState.settings.skipSeenInNavigation && entry.isSeen) {
      return false;
    }

    if (popupState.settings.skipFavoriteInNavigation && entry.isFavorite) {
      return false;
    }

    return true;
  });
}

function replaceEntryInPopupState(entry) {
  popupState.entries = popupState.entries.map((item) =>
    item.id === entry.id ? entry : item,
  );
}

function isSavableUrl(url) {
  return /^(https?:|ftp:)/i.test(url);
}

function getDisabledAttrs(disabled) {
  return disabled ? 'disabled aria-disabled="true"' : "";
}

function formatSaveFeedback(status) {
  const feedback = {
    duplicate: "Link gia presente",
    updated: "Link aggiornato",
    saved: "Link salvato",
  };

  return feedback[status] || "Operazione completata";
}

function getToggleStateClass(kind, isActive) {
  if (!isActive) {
    return "";
  }

  return kind === "seen" ? " is-active-seen" : " is-active-favorite";
}

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(value);
  }
}

function filterEntries(query, entries) {
  const normalizedQuery = query.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (filterSeenOnly && entry.isSeen) {
        return false;
      }

      if (filterFavoriteOnly && !entry.isFavorite) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return [entry.title, entry.url, entry.pageUrl]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    })
    .slice(0, 40);
}

function iconMarkup(name) {
  const icons = {
    "chevron-left":
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></span>',
    "chevron-right":
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8.59 16.59 1.41 1.41 6-6-6-6-1.41 1.41L13.17 12z"/></svg></span>',
    plus: '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M11 5h2v14h-2zM5 11h14v2H5z"/></svg></span>',
    check:
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9.55 18.02-5.03-5.03 1.41-1.41 3.62 3.61 8.52-8.51 1.41 1.41-9.93 9.93Z"/></svg></span>',
    "check-badge":
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.75 4 5.7v5.86c0 4.84 3.18 9.35 8 10.69 4.82-1.34 8-5.85 8-10.69V5.7L12 2.75Zm3.57 7.98-4.34 4.34-2.8-2.79 1.41-1.42 1.39 1.39 2.93-2.93 1.41 1.41Z"/></svg></span>',
    shuffle:
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M16 3h5v5h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H16V3ZM4 7h3.59l9 9H20v-2h-2.59l-9-9H4V7Zm9.29 5.29 1.42 1.42L10.41 18H13v2H8v-5h2v1.59l3.29-3.3ZM19 19v-1.59l-2.29-2.3 1.42-1.42 2.87 2.88V14h2v5h-5Z"/></svg></span>',
    star: '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"/></svg></span>',
    "star-filled":
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 2 2.81 6.63 7.19.61-5.46 4.73 1.64 7.03L12 17.27 5.82 21l1.64-7.03L2 9.24l7.19-.61L12 2Z"/></svg></span>',
    trash:
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v8H8V9Zm6 0h2v8h-2V9ZM6 9h12l-1 11H7L6 9Z"/></svg></span>',
  };

  return icons[name] || "";
}

function spinnerMarkup() {
  return '<span class="spinner" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" opacity="0.25"></circle><path d="M20 12a8 8 0 0 0-8-8"></path></svg></span>';
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? "#f3a7a7" : "rgba(244, 239, 230, 0.72)";
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

async function openArchivePage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/links.html") });
  window.close();
}
