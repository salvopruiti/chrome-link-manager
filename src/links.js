function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

const archiveSearchInput = document.getElementById("archiveSearch");
const archiveUrlInput = document.getElementById("archiveUrl");
const archiveTitleInput = document.getElementById("archiveTitle");
const archivePageUrlInput = document.getElementById("archivePageUrl");
const archiveIsSeenInput = document.getElementById("archiveIsSeen");
const archiveIsFavoriteInput = document.getElementById("archiveIsFavorite");
const archiveSaveButton = document.getElementById("archiveSaveButton");
const archiveCancelButton = document.getElementById("archiveCancelButton");
const archiveResetButton = document.getElementById("archiveResetButton");
const openCreateModalButton = document.getElementById("openCreateModalButton");
const archiveModalNode = document.getElementById("archiveModal");
const archiveModalCloseButton = document.getElementById(
  "archiveModalCloseButton",
);
const archiveFormMetaNode = document.getElementById("archiveFormMeta");
const archiveListNode = document.getElementById("archiveList");
const statusNode = document.getElementById("status");
const syncHintNode = document.getElementById("syncHint");
const refreshButton = document.getElementById("refreshButton");
const openOptionsButton = document.getElementById("openOptionsButton");
const filterUnseenButton = document.getElementById("filterUnseenButton");
const filterSeenButton = document.getElementById("filterSeenButton");
const filterFavoriteButton = document.getElementById("filterFavoriteButton");
const paginationInfoNode = document.getElementById("paginationInfo");
const prevPageButton = document.getElementById("prevPageButton");
const nextPageButton = document.getElementById("nextPageButton");
const firstPageButton = document.getElementById("firstPageButton");
const lastPageButton = document.getElementById("lastPageButton");
const modalStatusNode = document.getElementById("modalStatus");

const ITEMS_PER_PAGE = 100;

const archiveState = {
  entries: [],
  searchQuery: "",
  editingId: null,
  currentPage: 1,
  totalPages: 1,
  filters: {
    unseenOnly: false,
    seenOnly: false,
    favoriteOnly: false,
  },
};

archiveSearchInput.addEventListener("input", handleArchiveSearch);
archiveSaveButton.addEventListener("click", submitArchiveForm);
archiveCancelButton.addEventListener("click", handleArchiveCancel);
archiveResetButton.addEventListener("click", openCreateModal);
openCreateModalButton.addEventListener("click", openCreateModal);
archiveModalCloseButton.addEventListener("click", closeArchiveModal);
archiveModalNode.addEventListener("click", handleModalBackdropClick);
archiveListNode.addEventListener("click", handleArchiveListClick);
refreshButton.addEventListener("click", refreshState);
openOptionsButton.addEventListener("click", openOptionsPage);
filterUnseenButton.addEventListener("click", () =>
  toggleQuickFilter("unseenOnly"),
);
filterSeenButton.addEventListener("click", () => toggleQuickFilter("seenOnly"));
filterFavoriteButton.addEventListener("click", () =>
  toggleQuickFilter("favoriteOnly"),
);
prevPageButton.addEventListener("click", () => changePage(-1));
nextPageButton.addEventListener("click", () => changePage(1));
firstPageButton.addEventListener("click", () => changePage(-Infinity));
lastPageButton.addEventListener("click", () => changePage(Infinity));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshState();
  }
});

readQueryParams();
archiveSearchInput.value = archiveState.searchQuery;

void init();

async function init() {
  try {
    await refreshState();
    resetArchiveForm();
    closeArchiveModal();
  } catch (error) {
    setStatus(error.message || t("unable_load_links"), true);
  }
}

function readQueryParams() {
  const params = new URLSearchParams(location.search);
  archiveState.searchQuery = params.get("q") || "";
  const page = parseInt(params.get("page"), 10);
  if (page > 0) archiveState.currentPage = page;
  if (params.get("unseen") === "1") {
    archiveState.filters.unseenOnly = true;
    archiveState.filters.seenOnly = false;
  }
  if (params.get("seen") === "1") {
    archiveState.filters.seenOnly = true;
    archiveState.filters.unseenOnly = false;
  }
  if (params.get("fav") === "1") archiveState.filters.favoriteOnly = true;
}

function writeQueryParams() {
  const p = new URLSearchParams();
  if (archiveState.searchQuery.trim()) p.set("q", archiveState.searchQuery.trim());
  if (archiveState.currentPage > 1) p.set("page", String(archiveState.currentPage));
  if (archiveState.filters.unseenOnly) p.set("unseen", "1");
  if (archiveState.filters.seenOnly) p.set("seen", "1");
  if (archiveState.filters.favoriteOnly) p.set("fav", "1");
  const qs = p.toString();
  history.replaceState(null, "", qs ? "?" + qs : location.pathname);
}

async function refreshState() {
  const state = await sendMessage({ type: "get-state" });
  archiveState.entries = Array.isArray(state.entries) ? state.entries : [];
  renderSyncHint(state.sync || {});
  renderArchiveList();
}

function handleArchiveSearch(event) {
  archiveState.searchQuery = event.target.value || "";
  archiveState.currentPage = 1;
  renderArchiveList();
}

function getFilteredArchiveEntries() {
  const normalizedQuery = archiveState.searchQuery.trim().toLowerCase();

  return archiveState.entries.filter(
    (entry) =>
      matchesQuickFilters(entry) &&
      (!normalizedQuery ||
        [entry.title, entry.url, entry.pageUrl]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedQuery))),
  );
}

function renderArchiveList() {
  const filteredEntries = getFilteredArchiveEntries();
  const totalPages = Math.max(
    1,
    Math.ceil(filteredEntries.length / ITEMS_PER_PAGE),
  );
  archiveState.currentPage = Math.min(archiveState.currentPage, totalPages);
  archiveState.totalPages = totalPages;
  const pageStart = (archiveState.currentPage - 1) * ITEMS_PER_PAGE;
  const visibleEntries = filteredEntries.slice(
    pageStart,
    pageStart + ITEMS_PER_PAGE,
  );
  const pageEnd = pageStart + visibleEntries.length;

  renderQuickFilters();
  renderPagination(filteredEntries.length, pageStart, pageEnd, totalPages);

  if (!visibleEntries.length) {
    archiveListNode.innerHTML = `<div class="empty">${escapeHtml(
      archiveState.searchQuery.trim()
        ? t("no_search_results")
        : t("no_links_saved_yet"),
    )}</div>`;
    return;
  }

  archiveListNode.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>${t("title_label")}</th>       
          <th>${t("date_label")}</th>   
          <th>${t("actions_label")}</th>
        </tr>
      </thead>
      <tbody>
        ${visibleEntries.map((entry) => renderTableRow(entry)).join("")}
      </tbody>
    </table>`;
  writeQueryParams();
}

function renderTableRow(entry) {
  const badges = [];

  if (entry.isSeen) {
    badges.push(`<span class="badge seen">${t("seen_badge")}</span>`);
  }

  if (entry.isFavorite) {
    badges.push(`<span class="badge favorite">${t("favorite_badge")}</span>`);
  }

  return `
    <tr data-id="${escapeHtml(entry.id)}">
      <td><div class="cell-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</div>
      <div class="cell-url" title="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</div>
      ${badges.length ? `<div class="badge-row">${badges.join("")}</div>` : ""}</td>
      <td><div class="cell-date">${formatDateTime(entry.createdAt)}</div></td>
      <td>
        <div class="row-actions">
          <button type="button" class="secondary icon-button" data-action="open" data-id="${escapeHtml(entry.id)}" title="${t("open_in_new_tab")}" aria-label="${t("open_in_new_tab")}">${iconMarkup("chevron-right")}</button>
          <button type="button" class="secondary icon-button" data-action="edit" data-id="${escapeHtml(entry.id)}" title="${t("edit_link_title")}" aria-label="${t("edit_link_title")}">${iconMarkup("edit")}</button>
          <button type="button" class="secondary icon-button${getToggleStateClass("seen", entry.isSeen)}" data-action="toggle-seen" data-id="${escapeHtml(entry.id)}" title="${entry.isSeen ? t("unmark_seen") : t("mark_seen")}" aria-label="${entry.isSeen ? t("unmark_seen") : t("mark_seen")}">${iconMarkup(entry.isSeen ? "check-badge" : "check")}</button>
          <button type="button" class="secondary icon-button${getToggleStateClass("favorite", entry.isFavorite)}" data-action="toggle-favorite" data-id="${escapeHtml(entry.id)}" title="${entry.isFavorite ? t("unmark_favorite") : t("mark_favorite")}" aria-label="${entry.isFavorite ? t("unmark_favorite") : t("mark_favorite")}">${iconMarkup(entry.isFavorite ? "star-filled" : "star")}</button>
          <button type="button" class="warn icon-button" data-action="delete" data-id="${escapeHtml(entry.id)}" title="${t("remove")}" aria-label="${t("remove")}">${iconMarkup("trash")}</button>
        </div>
      </td>
    </tr>`;
}

function matchesQuickFilters(entry) {
  if (archiveState.filters.unseenOnly && entry.isSeen) {
    return false;
  }

  if (archiveState.filters.seenOnly && !entry.isSeen) {
    return false;
  }

  if (archiveState.filters.favoriteOnly && !entry.isFavorite) {
    return false;
  }

  return true;
}

function toggleQuickFilter(filterKey) {
  if (filterKey === "unseenOnly") {
    archiveState.filters.unseenOnly = !archiveState.filters.unseenOnly;
    if (archiveState.filters.unseenOnly) {
      archiveState.filters.seenOnly = false;
    }
  } else if (filterKey === "seenOnly") {
    archiveState.filters.seenOnly = !archiveState.filters.seenOnly;
    if (archiveState.filters.seenOnly) {
      archiveState.filters.unseenOnly = false;
    }
  } else if (filterKey === "favoriteOnly") {
    archiveState.filters.favoriteOnly = !archiveState.filters.favoriteOnly;
  }

  archiveState.currentPage = 1;
  renderArchiveList();
}

function renderQuickFilters() {
  filterUnseenButton.classList.toggle(
    "is-active",
    archiveState.filters.unseenOnly,
  );
  filterSeenButton.classList.toggle("is-active", archiveState.filters.seenOnly);
  filterFavoriteButton.classList.toggle(
    "is-active",
    archiveState.filters.favoriteOnly,
  );
}

function populateArchiveForm(entry) {
  archiveState.editingId = entry.id;
  archiveUrlInput.value = entry.url || "";
  archiveTitleInput.value = entry.title || "";
  archivePageUrlInput.value = entry.pageUrl || "";
  archiveIsSeenInput.checked = Boolean(entry.isSeen);
  archiveIsFavoriteInput.checked = Boolean(entry.isFavorite);
  archiveSaveButton.textContent = t("save_changes");
  openArchiveModal();
  archiveFormMetaNode.textContent = t("edit_link_title");
}

function syncEditingEntry(entry) {
  if (archiveState.editingId !== entry.id) {
    return;
  }

  populateArchiveForm(entry);
}

function resetArchiveForm() {
  archiveState.editingId = null;
  archiveUrlInput.value = "";
  archiveTitleInput.value = "";
  archivePageUrlInput.value = "";
  archiveIsSeenInput.checked = false;
  archiveIsFavoriteInput.checked = false;
  archiveSaveButton.textContent = t("add_link");
  archiveFormMetaNode.textContent = t("add_manually_hint");
}

function openCreateModal() {
  resetArchiveForm();
  openArchiveModal();
  archiveUrlInput.focus();
}

function openArchiveModal() {
  archiveModalNode.classList.add("is-open");
  archiveModalNode.setAttribute("aria-hidden", "false");
  clearModalStatus();
}

function closeArchiveModal() {
  archiveModalNode.classList.remove("is-open");
  archiveModalNode.setAttribute("aria-hidden", "true");
}

function handleArchiveCancel() {
  resetArchiveForm();
  closeArchiveModal();
}

function handleModalBackdropClick(event) {
  if (event.target !== archiveModalNode) {
    return;
  }

  closeArchiveModal();
}

async function submitArchiveForm() {
  const payload = {
    url: archiveUrlInput.value.trim(),
    title: archiveTitleInput.value.trim(),
    pageUrl: archivePageUrlInput.value.trim(),
    isSeen: archiveIsSeenInput.checked,
    isFavorite: archiveIsFavoriteInput.checked,
  };

  if (!payload.url) {
    setModalStatus(t("enter_valid_url"), true);
    archiveUrlInput.focus();
    return;
  }

  try {
    setButtonBusy(
      archiveSaveButton,
      true,
      archiveState.editingId ? t("saving_short") : t("adding_short"),
    );

    if (archiveState.editingId) {
      await sendMessage({
        type: "update-link",
        payload: {
          id: archiveState.editingId,
          ...payload,
        },
      });
    } else {
      await sendMessage({
        type: "save-link",
        payload,
      });
    }

    await refreshState();
    resetArchiveForm();
    closeArchiveModal();
    setStatus(
      archiveState.editingId ? t("link_updated") : t("link_added"),
    );
  } catch (error) {
    setModalStatus(error.message || t("error_saving_link"), true);
  } finally {
    setButtonBusy(archiveSaveButton, false);
  }
}

async function handleArchiveListClick(event) {
  const button = event.target.closest("[data-action]");

  if (!button) {
    return;
  }

  const action = button.getAttribute("data-action");
  const id = button.getAttribute("data-id");

  if (!action || !id) {
    return;
  }

  const entry = archiveState.entries.find((item) => item.id === id);
  if (!entry) {
    return;
  }

  if (action === "open") {
    try {
      await sendMessage({
        type: "open-link",
        payload: { id, active: true, openInNewTab: true },
      });
      setStatus(t("link_opened_new_tab"));
    } catch (error) {
      setStatus(error.message || t("error_opening_link"), true);
    }
    return;
  }

  if (action === "edit") {
    populateArchiveForm(entry);
    archiveUrlInput.focus();
    return;
  }

  if (action === "toggle-seen") {
    const optimisticEntry = createOptimisticEntry(entry, "isSeen", "seenAt");
    replaceEntryInState(optimisticEntry);
    syncEditingEntry(optimisticEntry);
    renderArchiveList();

    try {
      const result = await sendMessage({
        type: "toggle-seen",
        payload: { id },
      });
      replaceEntryInState(result.entry);
      syncEditingEntry(result.entry);
      renderArchiveList();
      setStatus(
        result.enabled
          ? t("link_marked_seen")
          : t("link_marked_unseen"),
      );
    } catch (error) {
      await refreshState();
      setStatus(error.message || t("error_updating_status"), true);
    }
    return;
  }

  if (action === "toggle-favorite") {
    const optimisticEntry = createOptimisticEntry(
      entry,
      "isFavorite",
      "favoritedAt",
    );
    replaceEntryInState(optimisticEntry);
    syncEditingEntry(optimisticEntry);
    renderArchiveList();

    try {
      const result = await sendMessage({
        type: "toggle-favorite",
        payload: { id },
      });
      replaceEntryInState(result.entry);
      syncEditingEntry(result.entry);
      renderArchiveList();
      setStatus(
        result.enabled
          ? t("link_added_favorites")
          : t("link_removed_favorites"),
      );
    } catch (error) {
      await refreshState();
      setStatus(error.message || t("error_updating_status"), true);
    }
    return;
  }

  if (action !== "delete") {
    return;
  }

  try {
    removeEntryFromState(id);
    renderArchiveList();
    await sendMessage({ type: "remove-link", payload: { id } });
    if (archiveState.editingId === id) {
      resetArchiveForm();
      closeArchiveModal();
    }
    setStatus(t("link_deleted"));
  } catch (error) {
    await refreshState();
    setStatus(error.message || t("error_deleting_link"), true);
  }
}

function replaceEntryInState(entry) {
  archiveState.entries = archiveState.entries.map((item) =>
    item.id === entry.id ? entry : item,
  );
}

function removeEntryFromState(entryId) {
  archiveState.entries = archiveState.entries.filter(
    (entry) => entry.id !== entryId,
  );
}

function createOptimisticEntry(entry, flagKey, timestampKey) {
  const nextFlagValue = !entry[flagKey];

  return {
    ...entry,
    [flagKey]: nextFlagValue,
    [timestampKey]: nextFlagValue
      ? entry[timestampKey] || new Date().toISOString()
      : null,
  };
}

function renderPagination(totalItems, pageStart, pageEnd, totalPages) {
  if (!totalItems) {
    paginationInfoNode.textContent = t("no_results");
    prevPageButton.disabled = true;
    firstPageButton.disabled = true;
    lastPageButton.disabled = true;
    nextPageButton.disabled = true;
    return;
  }

  paginationInfoNode.textContent = `${pageStart + 1}-${pageEnd} di ${totalItems}`;
  firstPageButton.disabled = archiveState.currentPage <= 1;
  prevPageButton.disabled = archiveState.currentPage <= 1;
  nextPageButton.disabled = archiveState.currentPage >= totalPages;
  lastPageButton.disabled = archiveState.currentPage >= totalPages;
}

function changePage(delta) {
  const filteredEntries = getFilteredArchiveEntries();
  const totalPages = Math.max(
    1,
    Math.ceil(filteredEntries.length / ITEMS_PER_PAGE),
  );
  archiveState.totalPages = totalPages;
  archiveState.currentPage = Math.min(
    totalPages,
    Math.max(1, archiveState.currentPage + delta),
  );
  renderArchiveList();
}

function getToggleStateClass(kind, isActive) {
  if (!isActive) {
    return "";
  }

  return kind === "seen" ? " is-active-seen" : " is-active-favorite";
}

function iconMarkup(name) {
  const icons = {
    check:
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9.55 18.02-5.03-5.03 1.41-1.41 3.62 3.61 8.52-8.51 1.41 1.41-9.93 9.93Z"/></svg></span>',
    "check-badge":
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.75 4 5.7v5.86c0 4.84 3.18 9.35 8 10.69 4.82-1.34 8-5.85 8-10.69V5.7L12 2.75Zm3.57 7.98-4.34 4.34-2.8-2.79 1.41-1.42 1.39 1.39 2.93-2.93 1.41 1.41Z"/></svg></span>',
    star: '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"/></svg></span>',
    "star-filled":
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 2 2.81 6.63 7.19.61-5.46 4.73 1.64 7.03L12 17.27 5.82 21l1.64-7.03L2 9.24l7.19-.61L12 2Z"/></svg></span>',
    trash:
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v8H8V9Zm6 0h2v8h-2V9ZM6 9h12l-1 11H7L6 9Z"/></svg></span>',
    "chevron-right":
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8.59 16.59 1.41 1.41 6-6-6-6-1.41 1.41L13.17 12z"/></svg></span>',
    edit: '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm14.71-9.04a1.003 1.003 0 0 0 0-1.42l-2.5-2.5a1.003 1.003 0 0 0-1.42 0l-1.96 1.96 3.75 3.75 2.13-1.79Z"/></svg></span>',
  };

  return icons[name] || "";
}

function renderSyncHint(sync = {}) {
  if (sync.isSyncing) {
    syncHintNode.textContent = t("sync_in_progress");
    return;
  }

  if (sync.pendingCount) {
    const flushSuffix = sync.nextFlushAt
      ? t("flush_at", [formatDateTime(sync.nextFlushAt)])
      : "";
    syncHintNode.textContent = t("pending_queue_with_flush", [
      String(sync.pendingCount),
      flushSuffix,
    ]);
    return;
  }

  syncHintNode.textContent = t("archive_up_to_date");
}

async function openOptionsPage() {
  await chrome.runtime.openOptionsPage();
}

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString(undefined);
  } catch {
    return String(value);
  }
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? "#e74c3c" : "#54d69a";
}

function setModalStatus(message, isError = false) {
  modalStatusNode.textContent = message;
  modalStatusNode.style.color = isError ? "#e74c3c" : "#54d69a";
}

function clearModalStatus() {
  modalStatusNode.textContent = "";
  modalStatusNode.style.color = "";
}

function setButtonBusy(button, busy, busyLabel = "") {
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }

  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
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
