const statusNode = document.getElementById("status");
const captureWithShiftInput = document.getElementById("captureWithShift");
const openLinksInNewTabInput = document.getElementById("openLinksInNewTab");
const skipSeenInNavigationInput = document.getElementById(
  "skipSeenInNavigation",
);
const skipFavoriteInNavigationInput = document.getElementById(
  "skipFavoriteInNavigation",
);
const closeDuplicateTabsOnLoadInput = document.getElementById(
  "closeDuplicateTabsOnLoad",
);
const closeSeenTabsOnLoadInput = document.getElementById("closeSeenTabsOnLoad");
const barVisibilityModeInput = document.getElementById("barVisibilityMode");
const barVisibilitySitesInput = document.getElementById("barVisibilitySites");
const importFolderIdInput = document.getElementById("importFolderId");
const importAsSeenInput = document.getElementById("importAsSeen");
const importAsFavoriteInput = document.getElementById("importAsFavorite");
const siteRulesInput = document.getElementById("siteRules");
const authEmailInput = document.getElementById("authEmail");
const authStatusNode = document.getElementById("authStatus");
const lastSyncAtNode = document.getElementById("lastSyncAt");
const syncQueueStatusNode = document.getElementById("syncQueueStatus");
const nextFlushAtNode = document.getElementById("nextFlushAt");
const authRedirectUrlNode = document.getElementById("authRedirectUrl");
const openArchivePageButton = document.getElementById("openArchivePageButton");
const saveButton = document.getElementById("saveButton");
const importFolderButton = document.getElementById("importFolderButton");
const sendMagicLinkButton = document.getElementById("sendMagicLinkButton");
const syncNowButton = document.getElementById("syncNowButton");
const debugSyncButton = document.getElementById("debugSyncButton");
const fixSyncButton = document.getElementById("fixSyncButton");
const debugSyncOutputNode = document.getElementById("debugSyncOutput");
const signOutButton = document.getElementById("signOutButton");

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

init();

saveButton.addEventListener("click", saveSettings);
importFolderButton.addEventListener("click", importFolder);
sendMagicLinkButton.addEventListener("click", sendMagicLink);
syncNowButton.addEventListener("click", syncNow);
debugSyncButton.addEventListener("click", debugSyncState);
fixSyncButton.addEventListener("click", fixSyncState);
signOutButton.addEventListener("click", signOut);
barVisibilityModeInput.addEventListener("change", syncBarVisibilityState);
openArchivePageButton.addEventListener("click", openArchivePage);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshState();
  }
});

async function init() {
  try {
    applyStaticI18n();
    authRedirectUrlNode.textContent = chrome.runtime.getURL(
      "src/auth-callback.html",
    );
    let [state, folders] = await Promise.all([
      sendMessage({ type: "get-state" }),
      sendMessage({ type: "list-bookmark-folders" }),
    ]);

    if (state.auth?.isAuthenticated) {
      try {
        await sendMessage({ type: "sync-supabase" });
        [state, folders] = await Promise.all([
          sendMessage({ type: "get-state" }),
          sendMessage({ type: "list-bookmark-folders" }),
        ]);
      } catch {
        // Keep rendering cached local state if opportunistic sync fails.
      }
    }

    captureWithShiftInput.checked = Boolean(state.settings.captureWithShift);
    openLinksInNewTabInput.checked = Boolean(state.settings.openLinksInNewTab);
    skipSeenInNavigationInput.checked = Boolean(
      state.settings.skipSeenInNavigation,
    );
    skipFavoriteInNavigationInput.checked = Boolean(
      state.settings.skipFavoriteInNavigation,
    );
    closeDuplicateTabsOnLoadInput.checked = Boolean(
      state.settings.closeDuplicateTabsOnLoad,
    );
    closeSeenTabsOnLoadInput.checked = Boolean(
      state.settings.closeSeenTabsOnLoad,
    );
    barVisibilityModeInput.value = state.settings.barVisibilityMode || "always";
    barVisibilitySitesInput.value = formatSiteList(
      state.settings.barVisibilitySites || [],
    );
    siteRulesInput.value = formatSiteRules(state.settings.siteRules || {});
    authEmailInput.value = state.auth?.email || authEmailInput.value || "";
    renderAuthState(state.auth);
    renderSyncState(state.sync);
    renderImportFolderOptions(folders);
    syncBarVisibilityState();
  } catch (error) {
    setStatus(error.message || t("unable_load_settings"), true);
  }
}

function applyStaticI18n() {
  const uiLang = chrome.i18n.getUILanguage();
  document.documentElement.lang = uiLang?.startsWith("it") ? "it" : "en";

  document.documentElement.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key) {
      return;
    }

    node.textContent = t(key);
  });

  document.documentElement
    .querySelectorAll("[data-i18n-placeholder]")
    .forEach((node) => {
      const key = node.getAttribute("data-i18n-placeholder");
      if (!key) {
        return;
      }

      node.setAttribute("placeholder", t(key));
    });
}

async function saveSettings() {
  try {
    const siteRules = parseSiteRules(siteRulesInput.value);
    await sendMessage({
      type: "update-settings",
      payload: {
        captureWithShift: captureWithShiftInput.checked,
        openLinksInNewTab: openLinksInNewTabInput.checked,
        skipSeenInNavigation: skipSeenInNavigationInput.checked,
        skipFavoriteInNavigation: skipFavoriteInNavigationInput.checked,
        closeDuplicateTabsOnLoad: closeDuplicateTabsOnLoadInput.checked,
        closeSeenTabsOnLoad: closeSeenTabsOnLoadInput.checked,
        barVisibilityMode: barVisibilityModeInput.value,
        barVisibilitySites: parseSiteList(barVisibilitySitesInput.value),
        siteRules,
      },
    });

    setStatus(t("settings_saved"));
  } catch (error) {
    setStatus(error.message || t("settings_save_error"), true);
  }
}

async function sendMagicLink() {
  try {
    setButtonBusy(sendMagicLinkButton, true, t("sending"));
    const result = await sendMessage({
      type: "send-magic-link",
      payload: { email: authEmailInput.value },
    });
    setStatus(t("magic_link_sent_to", [result.email]));
  } catch (error) {
    setStatus(error.message || t("magic_link_send_error"), true);
  } finally {
    setButtonBusy(sendMagicLinkButton, false);
  }
}

async function syncNow() {
  try {
    setButtonBusy(syncNowButton, true, t("sync_in_progress_short"));
    const result = await sendMessage({ type: "sync-supabase" });
    await refreshState();
    setStatus(t("synced_links_count", [String(result.syncedCount)]));
  } catch (error) {
    setStatus(error.message || t("sync_error"), true);
  } finally {
    setButtonBusy(syncNowButton, false);
  }
}

async function signOut() {
  try {
    setButtonBusy(signOutButton, true, t("signing_out"));
    await sendMessage({ type: "sign-out-supabase" });
    await refreshState();
    setStatus(t("sign_out_completed"));
  } catch (error) {
    setStatus(error.message || t("sign_out_error"), true);
  } finally {
    setButtonBusy(signOutButton, false);
  }
}

async function debugSyncState() {
  try {
    setButtonBusy(debugSyncButton, true, t("comparing"));
    const result = await sendMessage({ type: "debug-sync-diff" });
    debugSyncOutputNode.textContent = formatSyncDiagnostic(result);

    if (result.summary.localOnlyCount) {
      setStatus(
        t("found_local_only_links", [String(result.summary.localOnlyCount)]),
        true,
      );
    } else {
      setStatus(t("local_remote_aligned"));
    }
  } catch (error) {
    debugSyncOutputNode.textContent = "";
    setStatus(error.message || t("sync_compare_error"), true);
  } finally {
    setButtonBusy(debugSyncButton, false);
  }
}

async function fixSyncState() {
  try {
    setButtonBusy(fixSyncButton, true, t("fixing"));
    const result = await sendMessage({ type: "debug-sync-fix" });
    debugSyncOutputNode.textContent = formatSyncDiagnostic(result);
    await refreshState();

    if (result.summary.localOnlyCount || result.summary.mismatchedCount) {
      setStatus(
        t("sync_fix_remaining", [
          String(
            result.summary.localOnlyCount + result.summary.mismatchedCount,
          ),
        ]),
        true,
      );
      return;
    }

    setStatus(t("sync_fix_completed", [String(result.fixedUpserts || 0)]));
  } catch (error) {
    debugSyncOutputNode.textContent = "";
    setStatus(error.message || t("sync_fix_error"), true);
  } finally {
    setButtonBusy(fixSyncButton, false);
  }
}

async function refreshState() {
  const [state, folders] = await Promise.all([
    sendMessage({ type: "get-state" }),
    sendMessage({ type: "list-bookmark-folders" }),
  ]);

  renderAuthState(state.auth);
  renderSyncState(state.sync);
  authEmailInput.value = state.auth?.email || authEmailInput.value || "";
  renderImportFolderOptions(folders, importFolderIdInput.value);
}

async function openArchivePage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/links.html") });
}

function renderAuthState(auth = {}) {
  authStatusNode.textContent = auth.isAuthenticated
    ? t("connected_as", [auth.email || t("user_generic")])
    : t("not_authenticated");
  lastSyncAtNode.textContent = auth.lastSyncAt
    ? formatDateTime(auth.lastSyncAt)
    : t("never");
  syncNowButton.disabled = !auth.isAuthenticated;
  signOutButton.disabled = !auth.isAuthenticated;
}

function renderSyncState(sync = {}) {
  if (sync.isSyncing) {
    syncQueueStatusNode.textContent = t("sync_in_progress");
  } else if (sync.pendingCount) {
    syncQueueStatusNode.textContent = t("pending_changes_count", [
      String(sync.pendingCount),
    ]);
  } else {
    syncQueueStatusNode.textContent = t("no_changes_queued");
  }

  nextFlushAtNode.textContent = sync.nextFlushAt
    ? formatDateTime(sync.nextFlushAt)
    : t("not_scheduled");
}

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString(undefined);
  } catch {
    return value;
  }
}

function renderImportFolderOptions(folders, selectedId = "") {
  const options = [
    `<option value="">${escapeHtml(t("select_folder"))}</option>`,
    ...folders.map((folder) => {
      const selected = folder.id === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(folder.id)}"${selected}>${escapeHtml(folder.path)}</option>`;
    }),
  ];

  importFolderIdInput.innerHTML = options.join("");
}

function syncBarVisibilityState() {
  const disabled = barVisibilityModeInput.value === "always";
  barVisibilitySitesInput.disabled = disabled;
}

async function importFolder() {
  if (!importFolderIdInput.value) {
    setStatus(t("select_folder_to_import"), true);
    return;
  }

  try {
    setButtonBusy(importFolderButton, true, t("importing"));
    const result = await sendMessage({
      type: "import-bookmark-folder",
      payload: {
        folderId: importFolderIdInput.value,
        importAsSeen: importAsSeenInput.checked,
        importAsFavorite: importAsFavoriteInput.checked,
      },
    });
    setStatus(formatImportMessage(result));
  } catch (error) {
    setStatus(error.message || t("folder_import_error"), true);
  } finally {
    setButtonBusy(importFolderButton, false);
  }
}

function parseSiteRules(raw) {
  const siteRules = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [hostname, params] = trimmed.split("=");
    if (!hostname || params === undefined) {
      throw new Error(t("invalid_rule", [trimmed]));
    }

    const normalizedHostname = hostname.trim().toLowerCase();
    if (!normalizedHostname) {
      throw new Error(t("invalid_rule", [trimmed]));
    }

    siteRules[normalizedHostname] = params
      .split(",")
      .map((param) => param.trim())
      .filter(Boolean);
  }

  return siteRules;
}

function formatSiteRules(siteRules) {
  return Object.entries(siteRules)
    .map(([hostname, params]) => `${hostname}=${params.join(",")}`)
    .join("\n");
}

function parseSiteList(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

function formatSiteList(sites) {
  return (sites || []).join("\n");
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? "#c0392b" : "#2c6e49";
}

function setButtonBusy(button, busy, busyLabel = "") {
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }

  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function formatImportMessage(result) {
  if (!result?.totalCount) {
    return t("no_compatible_links_found_folder");
  }

  const parts = [];
  if (result.savedCount) {
    parts.push(t("imported_count", [String(result.savedCount)]));
  }
  if (result.updatedCount) {
    parts.push(t("updated_count", [String(result.updatedCount)]));
  }
  if (result.duplicateCount) {
    parts.push(t("already_present_count", [String(result.duplicateCount)]));
  }

  return parts.length ? parts.join(" • ") : t("no_new_links_to_import");
}

function formatSyncDiagnostic(result) {
  const sections = [
    `${t("diag_local")}: ${result.summary.localCount}`,
    `${t("diag_remote")}: ${result.summary.remoteCount}`,
    `${t("diag_local_only")}: ${result.summary.localOnlyCount}`,
    `${t("diag_remote_only")}: ${result.summary.remoteOnlyCount}`,
    `${t("diag_field_mismatches")}: ${result.summary.mismatchedCount}`,
    `${t("diag_pending_upsert")}: ${result.summary.pendingUpserts}`,
    `${t("diag_pending_delete")}: ${result.summary.pendingDeletes}`,
    `${t("diag_last_sync_revision")}: ${result.summary.lastSyncRevision || "-"}`,
  ];

  if (result.localOnly.length) {
    sections.push(`\n${t("diag_links_local_only")}:`);
    for (const entry of result.localOnly) {
      sections.push(
        `- ${entry.title} | ${entry.url} | pendingUpsert=${entry.pendingUpsert} pendingDelete=${entry.pendingDelete} remoteDeleted=${entry.remoteDeleted}`,
      );
    }
  }

  if (result.remoteOnly.length) {
    sections.push(`\n${t("diag_links_remote_only")}:`);
    for (const entry of result.remoteOnly) {
      sections.push(`- ${entry.title} | ${entry.url}`);
    }
  }

  if (result.mismatched.length) {
    sections.push(`\n${t("diag_links_mismatched")}:`);
    for (const entry of result.mismatched) {
      sections.push(
        `- ${entry.normalizedUrl} | differenze: ${entry.differences.join(", ")}`,
      );
    }
  }

  return sections.join("\n");
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
