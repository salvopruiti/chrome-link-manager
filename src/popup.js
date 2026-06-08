const searchInput = document.getElementById("searchInput");
const filterSeenButton = document.getElementById("filterSeenButton");
const filterFavoriteButton = document.getElementById("filterFavoriteButton");
const resultsNode = document.getElementById("results");
const countNode = document.getElementById("count");
const statusNode = document.getElementById("status");
const syncSummaryNode = document.getElementById("syncSummary");
const quickActionsNode = document.getElementById("quickActions");
const openArchiveButton = document.getElementById("openArchiveButton");
const pageViewNode = document.getElementById("pageView");
const listViewNode = document.getElementById("listView");
const pageQuickActionsNode = document.getElementById("pageQuickActions");
const pageTitleInput = document.getElementById("pageTitleInput");
const pageUrlInput = document.getElementById("pageUrlInput");
const pagePageUrlInput = document.getElementById("pagePageUrlInput");
const pageIsSeen = document.getElementById("pageIsSeen");
const pageIsFavorite = document.getElementById("pageIsFavorite");
const pageUpdateButton = document.getElementById("pageUpdateButton");
const pageRemoveButton = document.getElementById("pageRemoveButton");
const backToListButton = document.getElementById("backToListButton");
const headerBrand = document.getElementById("headerBrand");
const headerSearch = document.getElementById("headerSearch");
const pageTagField = document.getElementById("pageTagField");
const pageTagChips = document.getElementById("pageTagChips");
const pageTagSuggestions = document.getElementById("pageTagSuggestions");

let pageTagCurrentTags = [];
let pageTagOnChange = null;

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
let userExplicitListView = false;

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function initPageTagInput() {
  function getTags() {
    return [...pageTagCurrentTags]
  }

  function setTags(tags) {
    pageTagCurrentTags = Array.isArray(tags) ? tags.filter(Boolean) : []
    renderPageTagChips()
  }

  function renderPageTagChips() {
    pageTagChips.innerHTML = pageTagCurrentTags
      .map(
        (tag) =>
          `<span class="tag-chip">${escapeHtml(tag)}<button type="button" data-page-tag-remove="${escapeHtml(tag)}" aria-label="${t("remove_tag")}"><svg viewBox="0 0 24 24"><path d="M18.3 5.71 16.59 4 12 8.59 7.41 4 5.71 5.71 10.59 10.6 5.7 15.49l1.41 1.41L12 12l4.89 4.9 1.41-1.41-4.89-4.89 4.89-4.89Z"/></svg></button></span>`,
      )
      .join("")
  }

  pageTagField.addEventListener("input", () => {
    const value = pageTagField.value.trim()
    if (!value) {
      pageTagSuggestions.classList.remove("is-visible")
      return
    }
    const existing = new Set(pageTagCurrentTags.map((t) => t.toLowerCase()))
    const allTags = new Set(
      popupState.entries.flatMap((e) => (Array.isArray(e.tags) ? e.tags : [])),
    )
    const suggestions = [...allTags].filter(
      (tag) =>
        tag.toLowerCase().includes(value.toLowerCase()) &&
        !existing.has(tag.toLowerCase()),
    )
    pageTagSuggestions.innerHTML = suggestions
      .map((s) => `<div class="tag-suggestions-item" data-page-tag-suggestion="${escapeHtml(s)}">${escapeHtml(s)}</div>`)
      .join("")
    pageTagSuggestions.classList.toggle("is-visible", suggestions.length > 0)
  })

  pageTagField.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      const value = pageTagField.value.trim().replace(/,/g, "")
      if (value && !pageTagCurrentTags.map((t) => t.toLowerCase()).includes(value.toLowerCase())) {
        pageTagCurrentTags.push(value)
        renderPageTagChips()
      }
      pageTagField.value = ""
      pageTagSuggestions.classList.remove("is-visible")
    }
  })

  pageTagSuggestions.addEventListener("click", (event) => {
    const item = event.target.closest("[data-page-tag-suggestion]")
    if (!item) return
    const tag = item.getAttribute("data-page-tag-suggestion")
    if (tag && !pageTagCurrentTags.map((t) => t.toLowerCase()).includes(tag.toLowerCase())) {
      pageTagCurrentTags.push(tag)
      renderPageTagChips()
    }
    pageTagField.value = ""
    pageTagSuggestions.classList.remove("is-visible")
    pageTagField.focus()
  })

  pageTagChips.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-page-tag-remove]")
    if (!btn) return
    const tag = btn.getAttribute("data-page-tag-remove")
    pageTagCurrentTags = pageTagCurrentTags.filter((t) => t !== tag)
    renderPageTagChips()
    pageTagField.focus()
  })

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#pageTagInput")) {
      pageTagSuggestions.classList.remove("is-visible")
    }
  })

  return { getTags, setTags }
}

const pageTagInput = initPageTagInput()

init();

/* ── List view events ── */

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

/* ── Page view events ── */

pageUpdateButton.addEventListener("click", handlePageUpdate);
pageRemoveButton.addEventListener("click", handlePageRemove);
backToListButton.addEventListener("click", showListView);

/* ── Init ── */

async function init() {
  try {
    applyStaticI18n();
    const [state, tabs] = await Promise.all([
      sendMessage({ type: "get-state" }),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);

    popupState = state;
    activeTab = tabs[0] || null;
    await refreshCurrentPageState();

    if (currentPageState.savedEntry) {
      showPageView(currentPageState.savedEntry);
    } else {
      showListView();
    }

    if (state.auth?.isAuthenticated) {
      void refreshPopupStateFromSync();
    }
  } catch (error) {
    setStatus(error.message || t("unable_load_links"), true);
  }
}

function showPageView(entry) {
  userExplicitListView = false;
  pageViewNode.classList.add("is-visible");
  listViewNode.classList.remove("is-visible");
  updateHeaderForView("page");
  countNode.textContent = String(popupState.entries.length);
  populatePageView(entry);
  renderPageQuickActions();
  renderSyncSummary();
}

function showListView() {
  userExplicitListView = true;
  pageViewNode.classList.remove("is-visible");
  listViewNode.classList.add("is-visible");
  updateHeaderForView("list");
  render();
}

function updateHeaderForView(view) {
  const isPage = view === "page";
  headerBrand.classList.toggle("is-hidden", !isPage);
  headerSearch.classList.toggle("is-visible", !isPage);
}

function populatePageView(entry) {
  pageTitleInput.value = entry.title || "";
  pageUrlInput.value = entry.url || "";
  pagePageUrlInput.value = entry.pageUrl || "";
  pageIsSeen.checked = Boolean(entry.isSeen);
  pageIsFavorite.checked = Boolean(entry.isFavorite);
  pageTagInput.setTags(entry.tags);
}

function renderPageQuickActions() {
  const navigableEntries = getNavigableEntries();
  const { previousEntry, nextEntry } = getCurrentEntryNavigation();

  pageQuickActionsNode.innerHTML = `
    <button class="icon-button" type="button" data-action="prev-current" data-id="${escapeHtml(previousEntry?.id || "")}" title="${t("previous_link")}" aria-label="${t("previous_link")}" ${getDisabledAttrs(!previousEntry || isAnyPending())}>
      ${isPending("prev-current") ? spinnerMarkup() : iconMarkup("chevron-left")}
    </button>
    <button class="icon-button" type="button" data-action="next-current" data-id="${escapeHtml(nextEntry?.id || "")}" title="${t("next_link")}" aria-label="${t("next_link")}" ${getDisabledAttrs(!nextEntry || isAnyPending())}>
      ${isPending("next-current") ? spinnerMarkup() : iconMarkup("chevron-right")}
    </button>
    <button class="icon-button" type="button" data-action="random" title="${t("open_random_link")}" aria-label="${t("open_random_link")}" ${getDisabledAttrs(isAnyPending() || !navigableEntries.length)}>
      ${isPending("random") ? spinnerMarkup() : iconMarkup("shuffle")}
    </button>
  `;

  pageQuickActionsNode.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const id = button.getAttribute("data-id");

      if (!action || button.hasAttribute("disabled")) return;

      await runAction(action, async () => {
        switch (action) {
          case "prev-current":
          case "next-current":
            if (id) {
              const targetEntry = popupState.entries.find((e) => e.id === id);
              if (targetEntry && typeof activeTab?.id === "number") {
                await chrome.tabs.update(activeTab.id, {
                  url: targetEntry.url,
                  active: true,
                });
                window.close();
              }
            }
            break;
          case "random":
            await sendMessage({
              type: "open-random-link",
              payload: { tabId: activeTab?.id, windowId: activeTab?.windowId },
            });
            window.close();
            break;
        }
      }, id || null);
    });
  });
}

async function handlePageUpdate() {
  if (!currentPageState.savedEntry) return;

  const payload = {
    id: currentPageState.savedEntry.id,
    url: pageUrlInput.value.trim(),
    title: pageTitleInput.value.trim(),
    pageUrl: pagePageUrlInput.value.trim(),
    isSeen: pageIsSeen.checked,
    isFavorite: pageIsFavorite.checked,
    tags: pageTagInput.getTags(),
  };

  if (!payload.url) {
    setStatus(t("enter_valid_url"), true);
    pageUrlInput.focus();
    return;
  }

  try {
    pageUpdateButton.disabled = true;
    pageUpdateButton.textContent = t("saving_short");
    const result = await sendMessage({ type: "update-link", payload });
    replaceEntryInPopupState(result.entry);
    currentPageState.savedEntry = result.entry;
    currentPageState.isSeen = result.entry.isSeen;
    currentPageState.isFavorite = result.entry.isFavorite;
    populatePageView(result.entry);
    setStatus(t("link_updated"));
  } catch (error) {
    setStatus(error.message || t("error_saving_link"), true);
  } finally {
    pageUpdateButton.disabled = false;
    pageUpdateButton.textContent = t("save_changes");
  }
}

async function handlePageRemove() {
  if (!currentPageState.savedEntry) return;

  try {
    pageRemoveButton.disabled = true;
    pageRemoveButton.textContent = t("removing_short");
    const result = await sendMessage({
      type: "remove-link-by-url",
      payload: { url: activeTab?.url },
    });
    popupState.entries = popupState.entries.filter(
      (entry) => entry.normalizedUrl !== currentPageState.normalizedUrl,
    );
    currentPageState = createEmptyCurrentPageState();
    setStatus(
      result.removed ? t("page_removed_database") : t("page_not_in_database"),
    );
    showListView();
  } catch (error) {
    setStatus(error.message || t("operation_failed"), true);
  } finally {
    pageRemoveButton.disabled = false;
    pageRemoveButton.textContent = t("remove");
  }
}

/* ── List view ── */

function render() {
  renderSyncSummary();
  renderFilterState();

  const filteredEntries = filterEntries(searchQuery, popupState.entries);
  const hasActiveSearch = Boolean(
    searchQuery.trim() || filterSeenOnly || filterFavoriteOnly,
  );

  if (listViewNode.classList.contains("is-visible")) {
    countNode.textContent = String(popupState.entries.length);
    renderQuickActions();
  }

  resultsNode.innerHTML = filteredEntries.length
      ? filteredEntries
          .map(
            (entry) => `
              <li class="entry" data-id="${escapeHtml(entry.id)}">
                <button class="open" data-action="open" data-id="${escapeHtml(entry.id)}" title="${t("open_in_new_tab")}">
                  <span class="title">${escapeHtml(entry.title)}</span>
                  <span class="url">${escapeHtml(entry.url)}</span>
                </button>
                <div class="actions">
                  <button class="icon-button${getToggleStateClass("seen", entry.isSeen)}" data-action="toggle-seen" data-id="${escapeHtml(entry.id)}" title="${entry.isSeen ? t("unmark_seen") : t("mark_seen")}" aria-label="${entry.isSeen ? t("unmark_seen") : t("mark_seen")}">
                    ${isPending("toggle-seen", entry.id) ? spinnerMarkup() : iconMarkup(entry.isSeen ? "check-badge" : "check")}
                  </button>
                  <button class="icon-button${getToggleStateClass("favorite", entry.isFavorite)}" data-action="toggle-favorite" data-id="${escapeHtml(entry.id)}" title="${entry.isFavorite ? t("unmark_favorite") : t("mark_favorite")}" aria-label="${entry.isFavorite ? t("unmark_favorite") : t("mark_favorite")}">
                    ${isPending("toggle-favorite", entry.id) ? spinnerMarkup() : iconMarkup(entry.isFavorite ? "star-filled" : "star")}
                  </button>
                  <button class="icon-button" data-action="remove" data-id="${escapeHtml(entry.id)}" title="${t("remove")}" aria-label="${t("remove")}">
                    ${isPending("remove", entry.id) ? spinnerMarkup() : iconMarkup("trash")}
                  </button>
                </div>
              </li>`,
          )
          .join("")
      : `<li class="empty">${escapeHtml(t("no_results"))}</li>`;

  resultsNode.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const id = button.getAttribute("data-id");

      if (!action || !id) return;

      await runAction(action, async () => {
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
            setStatus(t("link_removed"));
            break;
          case "toggle-seen": {
            const seenResult = await sendMessage({
              type: "toggle-seen",
              payload: { id },
            });
            if (seenResult.entry) replaceEntryInPopupState(seenResult.entry);
            syncCurrentPageStateFromEntries({ preserveSnapshot: true });
            setStatus(
              seenResult.enabled
                ? t("link_marked_seen")
                : t("link_marked_unseen"),
            );
            break;
          }
          case "toggle-favorite": {
            const favResult = await sendMessage({
              type: "toggle-favorite",
              payload: { id },
            });
            if (favResult.entry) replaceEntryInPopupState(favResult.entry);
            syncCurrentPageStateFromEntries({ preserveSnapshot: true });
            setStatus(
              favResult.enabled
                ? t("link_added_favorites")
                : t("link_removed_favorites"),
            );
            break;
          }
        }
      }, id);
    });
  });
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
    <button class="icon-button" type="button" data-action="toggle-seen-current" title="${currentPageState.isSeen ? t("unmark_seen") : t("mark_seen")}" aria-label="${currentPageState.isSeen ? t("unmark_seen") : t("mark_seen")}" ${getDisabledAttrs(isAnyPending())}>
      ${isPending("toggle-seen-current") ? spinnerMarkup() : iconMarkup("check")}
    </button>
    <button class="icon-button" type="button" data-action="toggle-favorite-current" title="${currentPageState.isFavorite ? t("unmark_favorite") : t("mark_favorite")}" aria-label="${currentPageState.isFavorite ? t("unmark_favorite") : t("mark_favorite")}" ${getDisabledAttrs(isAnyPending())}>
      ${isPending("toggle-favorite-current") ? spinnerMarkup() : iconMarkup("star")}
    </button>`
    : "";

  quickActionsNode.innerHTML = `
    <button class="icon-button" type="button" data-action="prev-current" data-id="${escapeHtml(previousEntry?.id || "")}" title="${t("previous_link")}" aria-label="${t("previous_link")}" ${getDisabledAttrs(!previousEntry || isAnyPending())}>
      ${isPending("prev-current") ? spinnerMarkup() : iconMarkup("chevron-left")}
    </button>
    <button class="icon-button" type="button" data-action="next-current" data-id="${escapeHtml(nextEntry?.id || "")}" title="${t("next_link")}" aria-label="${t("next_link")}" ${getDisabledAttrs(!nextEntry || isAnyPending())}>
      ${isPending("next-current") ? spinnerMarkup() : iconMarkup("chevron-right")}
    </button>
    <button class="icon-button" type="button" data-action="${currentToggleAction}" title="${t("toggle_current_page")}" aria-label="${t("toggle_current_page")}" ${getDisabledAttrs(isAnyPending() || !currentPageState.canSave)}>
      ${isPending(currentToggleAction) ? spinnerMarkup() : iconMarkup(currentToggleIcon)}
    </button>
    ${currentPageExtraActions}
    ${currentPageState.savedEntry ? `
    <button class="icon-button" type="button" data-action="view-page" title="${t("edit_link_title")}" aria-label="${t("edit_link_title")}" ${getDisabledAttrs(isAnyPending())}>
      ${isPending("view-page") ? spinnerMarkup() : iconMarkup("edit")}
    </button>` : ""}
    <button class="icon-button" type="button" data-action="random" title="${t("open_random_link")}" aria-label="${t("open_random_link")}" ${getDisabledAttrs(isAnyPending() || !navigableEntries.length)}>
      ${isPending("random") ? spinnerMarkup() : iconMarkup("shuffle")}
    </button>
  `;

  quickActionsNode.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const id = button.getAttribute("data-id");

      if (!action || button.hasAttribute("disabled")) return;

      await runAction(action, async () => {
        switch (action) {
          case "prev-current":
          case "next-current":
            if (id) {
              const targetEntry = popupState.entries.find((e) => e.id === id);
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
            const saveResult = await sendMessage({
              type: "save-link",
              payload: {
                url: activeTab?.url,
                title: activeTab?.title || activeTab?.url,
                text: "",
                pageUrl: activeTab?.url,
              },
            });
            setStatus(formatSaveFeedback(saveResult.status));
            if (saveResult.entry) {
              popupState.entries = [
                saveResult.entry,
                ...popupState.entries.filter(
                  (entry) => entry.id !== saveResult.entry.id,
                ),
              ];
              currentPageState.normalizedUrl = saveResult.entry.normalizedUrl;
            }
            syncCurrentPageStateFromEntries();
            break;
          }
          case "remove-current": {
            const removeResult = await sendMessage({
              type: "remove-link-by-url",
              payload: { url: activeTab?.url },
            });
            setStatus(
              removeResult.removed
                ? t("page_removed_database")
                : t("page_not_in_database"),
            );
            popupState.entries = popupState.entries.filter(
              (entry) =>
                entry.normalizedUrl !== currentPageState.normalizedUrl,
            );
            syncCurrentPageStateFromEntries({ preserveSnapshot: true });
            break;
          }
          case "toggle-seen-current": {
            if (!currentPageState.savedEntry) break;
            const seenResult = await sendMessage({
              type: "toggle-seen",
              payload: { id: currentPageState.savedEntry.id },
            });
            replaceEntryInPopupState(seenResult.entry);
            syncCurrentPageStateFromEntries({ preserveSnapshot: true });
            setStatus(
              seenResult.enabled
                ? t("page_marked_seen")
                : t("page_marked_unseen"),
            );
            break;
          }
          case "toggle-favorite-current": {
            if (!currentPageState.savedEntry) break;
            const favResult = await sendMessage({
              type: "toggle-favorite",
              payload: { id: currentPageState.savedEntry.id },
            });
              replaceEntryInPopupState(favResult.entry);
            syncCurrentPageStateFromEntries({ preserveSnapshot: true });
            setStatus(
              favResult.enabled
                ? t("link_added_favorites")
                : t("link_removed_favorites"),
            );
            break;
          }
          case "view-page":
            if (currentPageState.savedEntry) {
              showPageView(currentPageState.savedEntry);
            }
            break;
          case "random":
            await sendMessage({
              type: "open-random-link",
              payload: { tabId: activeTab?.id, windowId: activeTab?.windowId },
            });
            window.close();
            break;
        }
      }, id || null);
    });
  });
}

/* ── Shared ── */

async function refreshPopupStateFromSync() {
  try {
    await sendMessage({ type: "sync-supabase" });
    popupState = await sendMessage({ type: "get-state" });
    await refreshCurrentPageState();

    if (currentPageState.savedEntry && !userExplicitListView) {
      showPageView(currentPageState.savedEntry);
    } else {
      showListView();
    }
  } catch {
    // Keep the already rendered local state if background sync fails.
  }
}

function renderSyncSummary() {
  const sync = popupState.sync || {};
  if (sync.isSyncing) {
    syncSummaryNode.textContent = t("sync_in_progress");
    return;
  }
  if (sync.pendingCount) {
    const nextFlush = sync.nextFlushAt
      ? t("flush_at", [formatDateTime(sync.nextFlushAt)])
      : "";
    syncSummaryNode.textContent = t("pending_queue_with_flush", [
      String(sync.pendingCount),
      nextFlush,
    ]);
    return;
  }
  syncSummaryNode.textContent = t("no_changes_queued");
}

function renderFilterState() {
  filterSeenButton.classList.toggle("is-active", filterSeenOnly);
  filterFavoriteButton.classList.toggle("is-active", filterFavoriteOnly);
}

async function runAction(action, callback, targetId = null) {
  try {
    pendingAction = { action, targetId };
    render();
    await callback();
    render();
  } catch (error) {
    setStatus(error.message || t("operation_failed"), true);
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
  if (currentIndex === -1) return null;

  return {
    previousEntryId: navigableEntries[currentIndex + 1]?.id || null,
    nextEntryId: navigableEntries[currentIndex - 1]?.id || null,
  };
}

function getCurrentEntryNavigation() {
  const navigableEntries = getNavigableEntries(
    currentPageState.savedEntry?.id,
  );
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
    if (preservedEntryId && entry.id === preservedEntryId) return true;
    if (popupState.settings.skipSeenInNavigation && entry.isSeen) return false;
    if (popupState.settings.skipFavoriteInNavigation && entry.isFavorite) return false;
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
    duplicate: t("link_already_present"),
    updated: t("link_updated"),
    saved: t("link_saved"),
  };
  return feedback[status] || t("operation_completed");
}

function getToggleStateClass(kind, isActive) {
  if (!isActive) return "";
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
      if (filterSeenOnly && entry.isSeen) return false;
      if (filterFavoriteOnly && !entry.isFavorite) return false;
      if (!normalizedQuery) return true;
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
    edit: '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm14.71-9.04a1.003 1.003 0 0 0 0-1.42l-2.5-2.5a1.003 1.003 0 0 0-1.42 0l-1.96 1.96 3.75 3.75 2.13-1.79Z"/></svg></span>',
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

function applyStaticI18n() {
  const uiLang = chrome.i18n.getUILanguage();
  document.documentElement.lang = uiLang?.startsWith("it") ? "it" : "en";

  document.documentElement.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key) return;
    node.textContent = t(key);
  });

  document.documentElement
    .querySelectorAll("[data-i18n-placeholder]")
    .forEach((node) => {
      const key = node.getAttribute("data-i18n-placeholder");
      if (!key) return;
      node.setAttribute("placeholder", t(key));
    });

  document.documentElement
    .querySelectorAll("[data-i18n-aria-label]")
    .forEach((node) => {
      const key = node.getAttribute("data-i18n-aria-label");
      if (!key) return;
      node.setAttribute("aria-label", t(key));
    });
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
