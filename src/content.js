const ROOT_ID = "link-manager-root";
const WRAPPER_ID = "link-manager-wrapper";
const STYLE_ID = "link-manager-style";
const BAR_MODE_STORAGE_KEY = "link-manager-bar-mode";
const BAR_MODE_VALUES = ["open", "closed", "icon"];

let extensionState = {
  entries: [],
  settings: {
    captureWithShift: true,
    captureAllClicks: false,
    openLinksInNewTab: false,
    skipSeenInNavigation: false,
    skipFavoriteInNavigation: false,
    barVisibilityMode: "always",
    barVisibilitySites: [],
  },
};

let initialized = false;
let barMode = "closed";
let currentPageState = createEmptyCurrentPageState();
let pendingAction = null;
let toastTimeoutId = null;

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

bootstrap();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state-updated") {
    extensionState = message.payload;
    syncCurrentPageStateFromEntries();
    renderBar();
    return;
  }

  if (message?.type === "show-toast") {
    flashMessage(
      message.payload?.text || t("operation_completed"),
      Boolean(message.payload?.isError),
    );
  }
});

async function bootstrap() {
  if (initialized || !isHtmlDocument()) {
    return;
  }

  initialized = true;
  barMode = await loadBarMode();
  installStyles();
  document.addEventListener("click", handleDocumentClick, true);
  window.addEventListener("focus", handleWindowFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  try {
    const response = await sendMessage({ type: "get-state" });
    extensionState = response;
    await refreshCurrentPageState();
    await checkPageLoad();
  } catch {
    return;
  }

  waitForBody(renderBar);
}

async function checkPageLoad() {
  if (!isSavableUrl(window.location.href)) {
    return;
  }

  try {
    await sendMessage({
      type: "check-page-load",
      payload: { url: window.location.href },
    });
  } catch {
    // Ignore failures during page load checks.
  }
}

function handleWindowFocus() {
  if (document.visibilityState === "visible") {
    void refreshBarState();
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    void refreshBarState();
  }
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

function shouldShowBarForCurrentSite(settings = {}) {
  const hostname = window.location.hostname.toLowerCase();
  const mode = settings.barVisibilityMode || "always";
  const sites = settings.barVisibilitySites || [];

  if (mode === "always") {
    return true;
  }

  const matched = sites.some((pattern) =>
    matchesHostnamePattern(hostname, pattern),
  );
  return mode === "whitelist" ? matched : !matched;
}

function matchesHostnamePattern(hostname, pattern) {
  const normalizedPattern = String(pattern || "")
    .trim()
    .toLowerCase();
  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern === hostname) {
    return true;
  }

  if (!normalizedPattern.startsWith("*.")) {
    return false;
  }

  const suffix = normalizedPattern.slice(2);
  return Boolean(suffix) && hostname.endsWith(`.${suffix}`);
}

function removeBarRoot() {
  document.getElementById(WRAPPER_ID)?.remove();
}

function getBarWrapper() {
  let wrapper = document.getElementById(WRAPPER_ID);
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.id = WRAPPER_ID;
  }

  return wrapper;
}

function getToastHost() {
  let host = document.getElementById("link-manager-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "link-manager-toast-host";
  }

  return host;
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
      duplicate: t("link_already_present"),
      viewed: t("link_already_viewed"),
      updated: t("link_updated"),
      saved: t("link_saved"),
    };

    void refreshBarState();

    flashMessage(feedback[result.status] || t("operation_completed"));
  } catch (error) {
    flashMessage(error.message || t("save_error"), true);
  }
}

function shouldCaptureClick(event) {
  if (!shouldShowBarForCurrentSite(extensionState.settings)) {
    return false;
  }

  if (extensionState.settings.captureAllClicks && !event.shiftKey) {
    return true;
  }

  if (
    (extensionState.settings.captureAllClicks && event.shiftKey) ||
    !extensionState.settings.captureWithShift ||
    !event.shiftKey ||
    event.defaultPrevented
  ) {
    if (extensionState.settings.captureAllClicks) {
      flashMessage(t("auto_save_ignored_click"), false);
    }
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
    isFavorite: false,
    isSeen: false,
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

function getNavigableEntries(preservedEntryId = null) {
  return extensionState.entries.filter((entry) => {
    if (preservedEntryId && entry.id === preservedEntryId) {
      return true;
    }

    if (extensionState.settings.skipSeenInNavigation && entry.isSeen) {
      return false;
    }

    if (extensionState.settings.skipFavoriteInNavigation && entry.isFavorite) {
      return false;
    }

    return true;
  });
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
    savedEntry: null,
    isFavorite: false,
    isSeen: false,
    navigationSnapshot: currentPageState.navigationSnapshot,
  };

  const savedEntry =
    extensionState.entries.find(
      (entry) => entry.normalizedUrl === normalizedUrl,
    ) || null;

  if (savedEntry) {
    currentPageState.savedEntry = savedEntry;
    currentPageState.isFavorite = Boolean(savedEntry.isFavorite);
    currentPageState.isSeen = Boolean(savedEntry.isSeen);
  }
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

function replaceEntryInLocalState(entry) {
  extensionState = {
    ...extensionState,
    entries: extensionState.entries.map((item) =>
      item.id === entry.id ? entry : item,
    ),
  };
  syncCurrentPageStateFromEntries();
}

function setCurrentPageFavorite(isFavorite) {
  currentPageState = {
    ...currentPageState,
    isFavorite,
  };
}

function setCurrentPageNavigationSnapshot(entryId) {
  currentPageState = {
    ...currentPageState,
    navigationSnapshot: createNavigationSnapshot(entryId),
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

function setPendingState(action, targetId = null) {
  pendingAction = { action, targetId };
}

async function loadBarMode() {
  try {
    const storedData = await chrome.storage.local.get(BAR_MODE_STORAGE_KEY);
    const storedMode = storedData?.[BAR_MODE_STORAGE_KEY];
    if (BAR_MODE_VALUES.includes(storedMode)) {
      return storedMode;
    }
  } catch {
    // Fall through to legacy fallback.
  }

  try {
    const legacyMode = window.localStorage.getItem(BAR_MODE_STORAGE_KEY);
    if (!BAR_MODE_VALUES.includes(legacyMode)) {
      return "closed";
    }

    try {
      await chrome.storage.local.set({
        [BAR_MODE_STORAGE_KEY]: legacyMode,
      });
      window.localStorage.removeItem(BAR_MODE_STORAGE_KEY);
    } catch {
      // Ignore migration failures and still use the legacy value.
    }

    return legacyMode;
  } catch {
    return "closed";
  }
}

function setBarMode(nextMode) {
  barMode = nextMode;

  try {
    void chrome.storage.local.set({ [BAR_MODE_STORAGE_KEY]: nextMode });
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

  if (!shouldShowBarForCurrentSite(extensionState.settings)) {
    removeBarRoot();
    return;
  }

  const wrapper = getBarWrapper();
  const toastHost = getToastHost();
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
  }

  placeRoot(wrapper, toastHost, root);
  const navigableEntries = getNavigableEntries(currentPageState.savedEntry?.id);
  const busy = isAnyPending();
  const { previousEntry, nextEntry } = getCurrentEntryNavigation();
  const currentPageTitle =
    document.title?.trim() || window.location.hostname || window.location.href;
  const currentPageStatus = formatCurrentPageStatus();
  const currentToggleAction = currentPageState.savedEntry
    ? "remove-current"
    : "save-current";
  const currentToggleLabel = currentPageState.savedEntry
    ? t("remove")
    : t("add");
  const currentToggleIcon = currentPageState.savedEntry ? "trash" : "plus";
  const compactCurrentPageActionsMarkup = `
        <button class="lm-icon-button" type="button" data-action="${currentToggleAction}" title="${currentToggleLabel} ${t("current_link")}" aria-label="${currentToggleLabel} ${t("current_link")}" ${getDisabledAttrs(busy || !currentPageState.canSave)}>${isPending(currentToggleAction) ? spinnerMarkup() : iconMarkup(currentToggleIcon)}</button>
        <button class="lm-icon-button${getToggleStateClass("seen", currentPageState.isSeen)}" type="button" data-action="toggle-seen-current" title="${currentPageState.isSeen ? t("unmark_seen") : t("mark_seen")}" aria-label="${currentPageState.isSeen ? t("unmark_seen") : t("mark_seen")}" ${getDisabledAttrs(busy || !currentPageState.savedEntry)}>${isPending("toggle-seen-current") ? spinnerMarkup() : iconMarkup(currentPageState.isSeen ? "check-badge" : "check")}</button>
        <button class="lm-icon-button${getToggleStateClass("favorite", currentPageState.isFavorite)}" type="button" data-action="toggle-favorite-current" title="${currentPageState.isFavorite ? t("unmark_favorite") : t("mark_favorite")}" aria-label="${currentPageState.isFavorite ? t("unmark_favorite") : t("mark_favorite")}" ${getDisabledAttrs(busy || !currentPageState.savedEntry)}>${isPending("toggle-favorite-current") ? spinnerMarkup() : iconMarkup(currentPageState.isFavorite ? "star-filled" : "star")}</button>
      `;
  const currentPageActionsMarkup = currentPageState.savedEntry
    ? `
            <button title="${currentPageState.isSeen ? t("unmark_seen") : t("mark_seen")}" class="lm-action-button${getToggleStateClass("seen", currentPageState.isSeen)}" type="button" data-action="toggle-seen-current" ${getDisabledAttrs(busy)}>
              ${isPending("toggle-seen-current") ? spinnerMarkup() : iconMarkup(currentPageState.isSeen ? "check-badge" : "check")}
              <span style="display: none">${currentPageState.isSeen ? t("unmark_seen") : t("mark_seen")}</span>
            </button>
            <button title="${currentPageState.isFavorite ? t("unmark_favorite") : t("mark_favorite")}" class="lm-action-button${getToggleStateClass("favorite", currentPageState.isFavorite)}" type="button" data-action="toggle-favorite-current" ${getDisabledAttrs(busy)}>
              ${isPending("toggle-favorite-current") ? spinnerMarkup() : iconMarkup(currentPageState.isFavorite ? "star-filled" : "star")}
              <span style="display: none">${currentPageState.isFavorite ? t("unmark_favorite") : t("mark_favorite")}</span>
            </button>
          `
    : "";
  const currentPageNavigationMarkup = `
            <button title="${chrome.i18n.getMessage("previous_link")}" class="lm-action-button" type="button" data-action="prev-current" data-id="${escapeHtml(previousEntry?.id || "")}" ${getDisabledAttrs(busy || !previousEntry)}>
              ${isPending("prev-current") ? spinnerMarkup() : iconMarkup("chevron-left")}
              <span style="display: none">${chrome.i18n.getMessage("previous_link")}</span>
            </button>
            <button title="${chrome.i18n.getMessage("next_link")}" class="lm-action-button" type="button" data-action="next-current" data-id="${escapeHtml(nextEntry?.id || "")}" ${getDisabledAttrs(busy || !nextEntry)}>
              ${isPending("next-current") ? spinnerMarkup() : iconMarkup("chevron-right")}
              <span style="display: none">${chrome.i18n.getMessage("next_link")}</span>
            </button>
          `;
  const captureToggleLabel = extensionState.settings.captureAllClicks
    ? t("capture_auto_active")
    : t("capture_clicks");
  const isIconMode = barMode === "icon";
  const isPanelOpen = barMode === "open";
  const isCollapsedBar = barMode === "closed";

  root.innerHTML = isIconMode
    ? `
    <div class="lm-shell lm-shell-icon ${busy ? "is-busy" : ""}">
      <button class="lm-icon-launcher" type="button" data-action="expand-from-icon" title="${chrome.i18n.getMessage("open_link_manager")}" aria-label="${chrome.i18n.getMessage("open_link_manager")}">
        ${iconMarkup("bolt")}
        <span class="lm-toggle-count">${navigableEntries.length}</span>
      </button>
    </div>
  `
    : `
    <div class="lm-shell ${extensionState.entries.length ? "has-entries" : ""} ${busy ? "is-busy" : ""}">
      <div class="lm-topline">
      <button class="lm-toggle" type="button" data-action="toggle">
        <span class="lm-toggle-copy">${iconMarkup("bolt")} ${t("link_manager_name")}</span>
        <span class="lm-toggle-count">${navigableEntries.length}</span>
      </button>
      <div class="lm-top-actions">
        <button class="lm-minimize ${extensionState.settings.captureAllClicks ? "is-active" : ""}" type="button" data-action="toggle-capture-all" title="${captureToggleLabel}" aria-label="${captureToggleLabel}">
          ${iconMarkup("capture")}
        </button>
        <button class="lm-minimize" type="button" data-action="minimize-to-icon" title="${chrome.i18n.getMessage("minimize_to_icon")}" aria-label="${chrome.i18n.getMessage("minimize_to_icon")}">
          ${iconMarkup("minimize")}
        </button>
      </div>
      </div>
      ${
        isCollapsedBar
          ? `
      <div class="lm-quick-actions">
        ${compactCurrentPageActionsMarkup}
        <button class="lm-icon-button" type="button" data-action="prev-current" data-id="${escapeHtml(previousEntry?.id || "")}" title="${chrome.i18n.getMessage("previous_link")}" aria-label="${chrome.i18n.getMessage("previous_link")}" ${getDisabledAttrs(busy || !previousEntry)}>${isPending("prev-current") ? spinnerMarkup() : iconMarkup("chevron-left")}</button>
        <button class="lm-icon-button" type="button" data-action="next-current" data-id="${escapeHtml(nextEntry?.id || "")}" title="${chrome.i18n.getMessage("next_link")}" aria-label="${chrome.i18n.getMessage("next_link")}" ${getDisabledAttrs(busy || !nextEntry)}>${isPending("next-current") ? spinnerMarkup() : iconMarkup("chevron-right")}</button>
        <button class="lm-icon-button" type="button" data-action="random" title="${chrome.i18n.getMessage("open_random_link")}" aria-label="${chrome.i18n.getMessage("open_random_link")}" ${getDisabledAttrs(busy || !navigableEntries.length)}>${isPending("random") ? spinnerMarkup() : iconMarkup("shuffle")}</button>
      </div>
      `
          : ""
      }
      <section class="lm-panel" data-collapsed="${String(!isPanelOpen)}">
        <header class="lm-toolbar">
          <strong>${iconMarkup("bolt")} ${extensionState.settings.captureAllClicks ? t("capture_mode_click") : t("capture_mode_shift_click")}</strong>
          <div class="lm-toolbar-actions">
            <button class="lm-icon-button ${extensionState.settings.captureAllClicks ? "is-active" : ""}" type="button" data-action="toggle-capture-all" title="${captureToggleLabel}" aria-label="${captureToggleLabel}" ${getDisabledAttrs(busy)}>${isPending("toggle-capture-all") ? spinnerMarkup() : iconMarkup("capture")}</button>
            <button class="lm-icon-button" type="button" data-action="save-open-tabs" title="${chrome.i18n.getMessage("save_all_tabs")}" aria-label="${chrome.i18n.getMessage("save_all_tabs")}" ${getDisabledAttrs(busy)}>${isPending("save-open-tabs") ? spinnerMarkup() : iconMarkup("tabs")}</button>
            <button class="lm-icon-button" type="button" data-action="random" title="${chrome.i18n.getMessage("open_random_link")}" aria-label="${chrome.i18n.getMessage("open_random_link")}" ${getDisabledAttrs(busy)}>${isPending("random") ? spinnerMarkup() : iconMarkup("shuffle")}</button>
            <button class="lm-icon-button" type="button" data-action="refresh" title="${chrome.i18n.getMessage("refresh")}" aria-label="${chrome.i18n.getMessage("refresh")}" ${getDisabledAttrs(busy)}>${isPending("refresh") ? spinnerMarkup() : iconMarkup("refresh")}</button>
          </div>
        </header>
        <section class="lm-current-card">
          <div class="lm-current-copy">
            <span class="lm-kicker">${chrome.i18n.getMessage("current_page")}</span>
            <strong title="${escapeHtml(currentPageTitle)}">${escapeHtml(currentPageTitle)}</strong>
            <span class="lm-current-status">${escapeHtml(currentPageStatus)}</span>
          </div>
          <div class="lm-current-actions">
            <button title="${currentToggleLabel}" class="lm-action-button" type="button" data-action="${currentToggleAction}" ${getDisabledAttrs(busy || !currentPageState.canSave)}>
              ${isPending(currentToggleAction) ? spinnerMarkup() : iconMarkup(currentToggleIcon)}
              <span style="display: none">${currentToggleLabel}</span>
            </button>
            ${currentPageActionsMarkup}
            ${currentPageNavigationMarkup}
          </div>
        </section>
      </section>
    </div>
  `;

  attachUiHandlers(root);
}

function attachUiHandlers(root) {
  const toggle = root.querySelector(".lm-toggle");
  const minimize = root.querySelector('[data-action="minimize-to-icon"]');
  const iconLauncher = root.querySelector(".lm-icon-launcher");

  toggle?.addEventListener("click", () => {
    setBarMode(barMode === "open" ? "closed" : "open");
    renderBar();
  });

  minimize?.addEventListener("click", () => {
    setBarMode("icon");
    renderBar();
  });

  iconLauncher?.addEventListener("click", () => {
    setBarMode("closed");
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
          case "toggle-seen-current": {
            if (!currentPageState.savedEntry) {
              break;
            }

            const result = await sendMessage({
              type: "toggle-seen",
              payload: { id: currentPageState.savedEntry.id },
            });
            replaceEntryInLocalState(result.entry);
            flashMessage(
              result.enabled ? t("page_marked_seen") : t("page_marked_unseen"),
            );
            renderBar();
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
            replaceEntryInLocalState(result.entry);
            flashMessage(
              result.enabled
                ? t("page_added_favorites")
                : t("page_removed_favorites"),
            );
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
                ? t("page_already_in_favorites")
                : t("page_added_favorites"),
            );
            if (result.entry) {
              addEntryToLocalState(result.entry);
              setCurrentPageNavigationSnapshot(result.entry.id);
            }
            setCurrentPageFavorite(true);
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
                ? t("page_removed_database")
                : t("page_not_in_database"),
            );
            if (currentPageState.savedEntry) {
              removeEntryFromLocalState(currentPageState.savedEntry.id);
              renderBar();
            }
            break;
          }
          case "save-open-tabs": {
            const result = await sendMessage({ type: "save-open-tabs" });
            flashMessage(formatBatchSaveMessage(result));
            break;
          }
          case "toggle-capture-all": {
            const nextValue = !extensionState.settings.captureAllClicks;
            extensionState.settings.captureAllClicks = nextValue;
            sendMessage({
              type: "update-settings",
              payload: { captureAllClicks: nextValue },
            }).then((settings) => {
              extensionState.settings.captureAllClicks =
                settings.captureAllClicks;
              flashMessage(
                nextValue
                  ? t("auto_save_links_enabled")
                  : t("auto_save_links_disabled"),
              );
            });
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
        flashMessage(error.message || t("operation_failed"), true);
      } finally {
        clearPendingState();
        renderBar();
      }
    });
  });
}

function placeRoot(wrapper, toastHost, root) {
  if (toastHost.parentElement !== wrapper) {
    wrapper.appendChild(toastHost);
  }

  if (root.parentElement !== wrapper) {
    wrapper.appendChild(root);
  }

  if (
    wrapper.parentElement !== document.body ||
    document.body.lastChild !== wrapper
  ) {
    document.body.appendChild(wrapper);
  }
}

function formatCurrentPageStatus() {
  if (!currentPageState.savedEntry) {
    return chrome.i18n.getMessage("not_saved");
  }

  const savedAt = currentPageState.savedEntry.createdAt;

  const parts = [
    chrome.i18n.getMessage("saved", [new Date(savedAt).toLocaleString()]),
  ];

  if (currentPageState.isSeen) {
    const viewedDate = currentPageState.savedEntry.seenAt;
    parts.push(
      chrome.i18n.getMessage("viewed", [new Date(viewedDate).toLocaleString()]),
    );
  }

  if (currentPageState.isFavorite) {
    parts.push(chrome.i18n.getMessage("favorite"));
  }

  return parts.join(" • ");
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${WRAPPER_ID} {
      all: initial;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      overflow: visible;
      pointer-events: none;
      font-family: "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.4;
      color: #f4efe6;
      direction: ltr;
      text-align: left;
      text-size-adjust: none;
    }

    #${WRAPPER_ID},
    #${WRAPPER_ID} *,
    #${ROOT_ID},
    #${ROOT_ID} * {
      box-sizing: border-box;
    }

    #${ROOT_ID} {
      display: block;
      overflow: visible;
      pointer-events: auto;
    }

    #link-manager-toast-host {
      display: block;
      width: 100%;
      overflow: visible;
      pointer-events: none;
      position: relative;
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
      background: linear-gradient(135deg, #dc2626 0%, #f87171 100%);
      color: #fff;
      box-shadow: inset 0 0 0 1px rgba(139, 0, 0, 0.35);
    }

    #${ROOT_ID} .lm-minimize.is-active:hover,
    #${ROOT_ID} .lm-toolbar-actions .lm-icon-button.is-active:hover {
      background: linear-gradient(135deg, #b91c1c 0%, #f87171 100%);
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

    #${ROOT_ID} .lm-icon-button.is-active-seen,
    #${ROOT_ID} .lm-action-button.is-active-seen {
      background: rgba(84, 214, 154, 0.22);
      color: #b9f6da;
      box-shadow: inset 0 0 0 1px rgba(84, 214, 154, 0.45);
    }

    #${ROOT_ID} .lm-icon-button.is-active-favorite,
    #${ROOT_ID} .lm-action-button.is-active-favorite {
      background: rgba(242, 187, 105, 0.24);
      color: #ffd68b;
      box-shadow: inset 0 0 0 1px rgba(242, 187, 105, 0.42);
    }

    #${ROOT_ID} .lm-toolbar {
      display: flex;
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
    #${ROOT_ID} .lm-current-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    #${ROOT_ID} .lm-toolbar-actions {
      justify-content: flex-end;
      margin-left: auto;
    }

    #${ROOT_ID} .lm-toolbar-actions button {
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

    #${ROOT_ID} .lm-toast,
    #link-manager-toast-host .lm-toast {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      margin: 0 auto;
      width: fit-content;
      max-width: min(320px, calc(100vw - 48px));
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(18, 29, 56, 0.96);
      color: #f4efe6;
      font-size: 13px;
      text-align: center;
      pointer-events: none;
      box-shadow: 0 16px 30px rgba(8, 12, 24, 0.32);
      border: 1px solid rgba(255, 255, 255, 0.12);
      animation: lm-fade 2.4s ease forwards;
    }

    .lm-page-notice {
      all: initial;
      position: fixed;
      top: 16px;
      left: 50vw;
      transform: translateX(-50%);
      right: auto;
      z-index: 2147483648;
      min-width: min(220px, calc(100vw - 32px));
      max-width: min(640px, calc(100vw - 32px));
      padding: 12px 18px;
      border-radius: 999px;
      background: linear-gradient(90deg, #d9771f 0%, #f2bb69 100%);
      color: #24170b;
      font-family: "Segoe UI", sans-serif;
      font-size: 13px;
      font-weight: 700;
      text-align: center;
      pointer-events: none;
      box-shadow: 0 16px 30px rgba(8, 12, 24, 0.32);
      border: 1px solid rgba(60, 34, 12, 0.15);
        animation: lm-page-notice-fade 2.4s ease forwards;
    }

    .lm-page-notice.is-error {
      background: rgba(167, 47, 47, 0.96);
      color: #fff;
    }

    #${ROOT_ID} .lm-toast.is-error,
    #link-manager-toast-host .lm-toast.is-error {
      background: rgba(167, 47, 47, 0.96);
      color: #fff;
    }

      @keyframes lm-page-notice-fade {
        0%, 80% { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(8px); }
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

function formatSaveFeedback(status) {
  const feedback = {
    duplicate: t("link_already_present"),
    updated: t("link_updated"),
    viewed: t("link_already_viewed"),
    saved: t("link_saved"),
  };

  return feedback[status] || t("operation_completed");
}

function getToggleStateClass(kind, isActive) {
  if (!isActive) {
    return "";
  }

  return kind === "seen" ? " is-active-seen" : " is-active-favorite";
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
    check:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.55 18.02-5.03-5.03 1.41-1.41 3.62 3.61 8.52-8.51 1.41 1.41-9.93 9.93Z"/></svg>',
    "check-badge":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75 4 5.7v5.86c0 4.84 3.18 9.35 8 10.69 4.82-1.34 8-5.85 8-10.69V5.7L12 2.75Zm3.57 7.98-4.34 4.34-2.8-2.79 1.41-1.42 1.39 1.39 2.93-2.93 1.41 1.41Z"/></svg>',
    shuffle:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H16V3ZM4 7h3.59l9 9H20v-2h-2.59l-9-9H4V7Zm9.29 5.29 1.42 1.42L10.41 18H13v2H8v-5h2v1.59l3.29-3.3ZM19 19v-1.59l-2.29-2.3 1.42-1.42 2.87 2.88V14h2v5h-5Z"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"/></svg>',
    "star-filled":
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 2.81 6.63 7.19.61-5.46 4.73 1.64 7.03L12 17.27 5.82 21l1.64-7.03L2 9.24l7.19-.61L12 2Z"/></svg>',
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
  if (toastTimeoutId !== null) {
    window.clearTimeout(toastTimeoutId);
    toastTimeoutId = null;
  }

  const host = getToastHost();
  if (!host.isConnected) {
    (document.body || document.documentElement)?.appendChild(host);
  }

  const existingToast = host.querySelector(".lm-toast, .lm-page-notice");
  existingToast?.remove();

  const root = document.getElementById(ROOT_ID);
  const notice = document.createElement("div");
  notice.className = root
    ? `lm-toast${isError ? " is-error" : ""}`
    : `lm-page-notice${isError ? " is-error" : ""}`;
  notice.textContent = text;
  host.appendChild(notice);

  toastTimeoutId = window.setTimeout(() => {
    notice.remove();
    toastTimeoutId = null;
  }, 10000);
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
    return t("no_compatible_tabs_found");
  }

  const parts = [];
  if (result.savedCount) {
    parts.push(t("batch_saved_count", [String(result.savedCount)]));
  }
  if (result.updatedCount) {
    parts.push(t("batch_updated_count", [String(result.updatedCount)]));
  }
  if (result.duplicateCount) {
    parts.push(t("batch_duplicate_count", [String(result.duplicateCount)]));
  }

  return parts.length ? parts.join(" • ") : t("no_new_tabs_to_save");
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
