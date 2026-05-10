const statusNode = document.getElementById("status");
const captureWithShiftInput = document.getElementById("captureWithShift");
const openLinksInNewTabInput = document.getElementById("openLinksInNewTab");
const bookmarkFolderIdInput = document.getElementById("bookmarkFolderId");
const importFolderIdInput = document.getElementById("importFolderId");
const bookmarkFolderTitleInput = document.getElementById("bookmarkFolderTitle");
const siteRulesInput = document.getElementById("siteRules");
const authEmailInput = document.getElementById("authEmail");
const authStatusNode = document.getElementById("authStatus");
const lastSyncAtNode = document.getElementById("lastSyncAt");
const authRedirectUrlNode = document.getElementById("authRedirectUrl");
const saveButton = document.getElementById("saveButton");
const ensureFolderButton = document.getElementById("ensureFolderButton");
const importFolderButton = document.getElementById("importFolderButton");
const sendMagicLinkButton = document.getElementById("sendMagicLinkButton");
const syncNowButton = document.getElementById("syncNowButton");
const signOutButton = document.getElementById("signOutButton");

init();

saveButton.addEventListener("click", saveSettings);
ensureFolderButton.addEventListener("click", ensureFolder);
importFolderButton.addEventListener("click", importFolder);
sendMagicLinkButton.addEventListener("click", sendMagicLink);
syncNowButton.addEventListener("click", syncNow);
signOutButton.addEventListener("click", signOut);

async function init() {
  try {
    authRedirectUrlNode.textContent = chrome.runtime.getURL(
      "src/auth-callback.html",
    );
    const [state, folders] = await Promise.all([
      sendMessage({ type: "get-state" }),
      sendMessage({ type: "list-bookmark-folders" }),
    ]);

    captureWithShiftInput.checked = Boolean(state.settings.captureWithShift);
    openLinksInNewTabInput.checked = Boolean(state.settings.openLinksInNewTab);
    bookmarkFolderTitleInput.value =
      state.settings.bookmarkFolderTitle || "Link Manager";
    siteRulesInput.value = formatSiteRules(state.settings.siteRules || {});
    authEmailInput.value = state.auth?.email || authEmailInput.value || "";
    renderAuthState(state.auth);
    renderBookmarkFolderOptions(folders, state.settings.bookmarkFolderId);
    renderImportFolderOptions(folders);
  } catch (error) {
    setStatus(error.message || "Impossibile caricare le impostazioni", true);
  }
}

async function saveSettings() {
  try {
    const siteRules = parseSiteRules(siteRulesInput.value);
    await sendMessage({
      type: "update-settings",
      payload: {
        captureWithShift: captureWithShiftInput.checked,
        openLinksInNewTab: openLinksInNewTabInput.checked,
        bookmarkFolderId: bookmarkFolderIdInput.value || null,
        bookmarkFolderTitle: bookmarkFolderTitleInput.value,
        siteRules,
      },
    });

    setStatus("Impostazioni salvate");
  } catch (error) {
    setStatus(error.message || "Errore salvataggio impostazioni", true);
  }
}

async function sendMagicLink() {
  try {
    setButtonBusy(sendMagicLinkButton, true, "Invio...");
    const result = await sendMessage({
      type: "send-magic-link",
      payload: { email: authEmailInput.value },
    });
    setStatus(`Magic link inviato a ${result.email}`);
  } catch (error) {
    setStatus(error.message || "Errore invio magic link", true);
  } finally {
    setButtonBusy(sendMagicLinkButton, false);
  }
}

async function syncNow() {
  try {
    setButtonBusy(syncNowButton, true, "Sync...");
    const result = await sendMessage({ type: "sync-supabase" });
    await refreshState();
    setStatus(`Sincronizzati ${result.syncedCount} link`);
  } catch (error) {
    setStatus(error.message || "Errore sincronizzazione", true);
  } finally {
    setButtonBusy(syncNowButton, false);
  }
}

async function signOut() {
  try {
    setButtonBusy(signOutButton, true, "Uscita...");
    await sendMessage({ type: "sign-out-supabase" });
    await refreshState();
    setStatus("Disconnessione completata");
  } catch (error) {
    setStatus(error.message || "Errore disconnessione", true);
  } finally {
    setButtonBusy(signOutButton, false);
  }
}

async function refreshState() {
  const [state, folders] = await Promise.all([
    sendMessage({ type: "get-state" }),
    sendMessage({ type: "list-bookmark-folders" }),
  ]);

  renderAuthState(state.auth);
  authEmailInput.value = state.auth?.email || authEmailInput.value || "";
  renderBookmarkFolderOptions(folders, state.settings.bookmarkFolderId);
  renderImportFolderOptions(folders, importFolderIdInput.value);
}

function renderAuthState(auth = {}) {
  authStatusNode.textContent = auth.isAuthenticated
    ? `Connesso come ${auth.email || "utente"}`
    : "Non autenticato";
  lastSyncAtNode.textContent = auth.lastSyncAt
    ? formatDateTime(auth.lastSyncAt)
    : "Mai";
  syncNowButton.disabled = !auth.isAuthenticated;
  signOutButton.disabled = !auth.isAuthenticated;
}

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString("it-IT");
  } catch {
    return value;
  }
}

async function ensureFolder() {
  try {
    setButtonBusy(ensureFolderButton, true, "Creazione...");
    await saveSettings();
    const folderId = await sendMessage({ type: "ensure-bookmark-folder" });
    const folders = await sendMessage({ type: "list-bookmark-folders" });
    renderBookmarkFolderOptions(folders, folderId);
    renderImportFolderOptions(folders, importFolderIdInput.value);
    setStatus("Cartella preferiti pronta");
  } catch (error) {
    setStatus(error.message || "Errore creazione cartella", true);
  } finally {
    setButtonBusy(ensureFolderButton, false);
  }
}

function renderBookmarkFolderOptions(folders, selectedId) {
  const options = [
    '<option value="">Crea o trova usando il nome</option>',
    ...folders.map((folder) => {
      const selected = folder.id === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(folder.id)}"${selected}>${escapeHtml(folder.path)}</option>`;
    }),
  ];

  bookmarkFolderIdInput.innerHTML = options.join("");
}

function renderImportFolderOptions(folders, selectedId = "") {
  const options = [
    '<option value="">Seleziona una cartella</option>',
    ...folders.map((folder) => {
      const selected = folder.id === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(folder.id)}"${selected}>${escapeHtml(folder.path)}</option>`;
    }),
  ];

  importFolderIdInput.innerHTML = options.join("");
}

async function importFolder() {
  if (!importFolderIdInput.value) {
    setStatus("Seleziona una cartella da importare", true);
    return;
  }

  try {
    setButtonBusy(importFolderButton, true, "Importazione...");
    const result = await sendMessage({
      type: "import-bookmark-folder",
      payload: { folderId: importFolderIdInput.value },
    });
    setStatus(formatImportMessage(result));
  } catch (error) {
    setStatus(error.message || "Errore import cartella", true);
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
      throw new Error(`Regola non valida: ${trimmed}`);
    }

    const normalizedHostname = hostname.trim().toLowerCase();
    if (!normalizedHostname) {
      throw new Error(`Regola non valida: ${trimmed}`);
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
    return "Nessun link compatibile trovato nella cartella";
  }

  const parts = [];
  if (result.savedCount) {
    parts.push(`${result.savedCount} importati`);
  }
  if (result.duplicateCount) {
    parts.push(`${result.duplicateCount} gia presenti`);
  }
  if (result.bookmarkedCount) {
    parts.push(`${result.bookmarkedCount} gia nei preferiti target`);
  }

  return parts.length ? parts.join(" • ") : "Nessun nuovo link da importare";
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
