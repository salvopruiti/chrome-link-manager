import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const STORAGE_KEYS = {
  entries: "entries",
  settings: "settings",
  bookmarkFolderId: "bookmarkFolderId",
  authSession: "authSession",
  lastSyncAt: "lastSyncAt",
  pendingSync: "pendingSync",
  syncUserId: "syncUserId",
};

const SETTINGS_STORAGE = chrome.storage.sync;
const LOCAL_SETTINGS_STORAGE = chrome.storage.local;
const SUPABASE_PAGE_SIZE = 1000;

const CONTEXT_MENU_ID = "save-link-from-context-menu";

const DEFAULT_SETTINGS = {
  captureWithShift: true,
  captureAllClicks: false,
  openLinksInNewTab: true,
  bookmarkFolderId: null,
  bookmarkFolderTitle: "Link Manager",
  siteRules: {},
};

const DEFAULT_SYNC_SETTINGS = {
  captureWithShift: DEFAULT_SETTINGS.captureWithShift,
  captureAllClicks: DEFAULT_SETTINGS.captureAllClicks,
  openLinksInNewTab: DEFAULT_SETTINGS.openLinksInNewTab,
  bookmarkFolderTitle: DEFAULT_SETTINGS.bookmarkFolderTitle,
  siteRules: DEFAULT_SETTINGS.siteRules,
};

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();

  await ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSettingsStorage();
  void ensureContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.linkUrl) {
    return;
  }

  void handleContextMenuSave(info, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "get-state":
      return getState();
    case "inspect-link":
      return inspectLink(message.payload?.url);
    case "list-bookmark-folders":
      return listBookmarkFolders();
    case "import-bookmark-folder":
      return importBookmarkFolder(message.payload?.folderId);
    case "bookmark-link":
      return bookmarkLink(message.payload);
    case "save-link":
      return saveLink(message.payload, sender);
    case "save-open-tabs":
      return saveOpenTabs();
    case "remove-link-by-url":
      return removeLinkByUrl(message.payload?.url);
    case "remove-link":
      return removeLink(message.payload?.id);
    case "open-link":
      return openLink(
        message.payload?.id,
        message.payload?.active,
        sender,
        message.payload?.openInCurrentTab,
        message.payload?.openInNewTab,
      );
    case "open-random-link":
      return openRandomLink(sender, message.payload);
    case "promote-link":
      return promoteLink(message.payload?.id);
    case "update-settings":
      return updateSettings(message.payload);
    case "ensure-bookmark-folder":
      return ensureBookmarkFolder();
    case "send-magic-link":
      return sendMagicLink(message.payload?.email);
    case "complete-auth-session":
      return completeAuthSession(message.payload);
    case "sign-out-supabase":
      return signOutSupabase();
    case "sync-supabase":
      return syncSupabase();
    default:
      throw new Error("Unsupported message type");
  }
}

async function ensureContextMenu() {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Salva link",
    contexts: ["link"],
  });
}

async function handleContextMenuSave(info, tab) {
  try {
    const result = await saveLinks([
      {
        url: info.linkUrl,
        title: info.selectionText?.trim() || info.linkText || info.linkUrl,
        text: info.linkText || info.selectionText || "",
        pageUrl: info.pageUrl || tab?.url || null,
      },
    ]);

    await sendToastToTab(tab?.id, formatSaveStatusMessage(result.status));
  } catch (error) {
    await sendToastToTab(
      tab?.id,
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}

function formatSaveStatusMessage(status) {
  const feedback = {
    duplicate: "Link gia presente",
    bookmarked: "Link gia nei preferiti",
    saved: "Link salvato",
  };

  return feedback[status] || "Operazione completata";
}

async function sendToastToTab(tabId, text, isError = false) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "show-toast",
      payload: { text, isError },
    });
  } catch {
    // Ignore tabs where the content script is not available.
  }
}

async function getState() {
  const [entries, settings, auth] = await Promise.all([
    getEntries(),
    getSettings(),
    getAuthState(),
  ]);
  return { entries, settings, auth };
}

async function getEntries() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.entries);
  return normalizeEntries(data[STORAGE_KEYS.entries] || []);
}

async function setEntries(entries) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.entries]: normalizeEntries(entries),
  });
  await broadcastState();
}

async function getSettings() {
  await initializeSettingsStorage();
  const [syncData, localData] = await Promise.all([
    SETTINGS_STORAGE.get(STORAGE_KEYS.settings),
    LOCAL_SETTINGS_STORAGE.get(STORAGE_KEYS.bookmarkFolderId),
  ]);

  return {
    ...DEFAULT_SETTINGS,
    ...(syncData[STORAGE_KEYS.settings] || {}),
    bookmarkFolderId:
      localData[STORAGE_KEYS.bookmarkFolderId] ||
      DEFAULT_SETTINGS.bookmarkFolderId,
  };
}

async function updateSettings(nextSettings) {
  const sanitized = sanitizeSettings(nextSettings);
  const syncSettings = pickSyncSettings(sanitized);
  const localSettings = pickLocalSettings(sanitized);

  if (Object.keys(syncSettings).length) {
    const currentSyncSettings = await getStoredSyncSettings();
    await SETTINGS_STORAGE.set({
      [STORAGE_KEYS.settings]: {
        ...currentSyncSettings,
        ...syncSettings,
      },
    });
  }

  if (Object.hasOwn(localSettings, "bookmarkFolderId")) {
    await LOCAL_SETTINGS_STORAGE.set({
      [STORAGE_KEYS.bookmarkFolderId]: localSettings.bookmarkFolderId,
    });
  }

  await broadcastState();
  return getSettings();
}

async function initializeSettingsStorage() {
  const data = await SETTINGS_STORAGE.get(STORAGE_KEYS.settings);
  const rawSyncSettings = pickSyncSettings(data[STORAGE_KEYS.settings] || {});
  const storedSyncSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    ...pickSyncSettings(sanitizeSettings(rawSyncSettings)),
  };

  if (JSON.stringify(rawSyncSettings) !== JSON.stringify(storedSyncSettings)) {
    await SETTINGS_STORAGE.set({ [STORAGE_KEYS.settings]: storedSyncSettings });
  }

  return storedSyncSettings;
}

async function getStoredSyncSettings() {
  const data = await SETTINGS_STORAGE.get(STORAGE_KEYS.settings);
  return {
    ...DEFAULT_SYNC_SETTINGS,
    ...pickSyncSettings(sanitizeSettings(data[STORAGE_KEYS.settings] || {})),
  };
}

async function getAuthSession() {
  const data = await LOCAL_SETTINGS_STORAGE.get(STORAGE_KEYS.authSession);
  return data[STORAGE_KEYS.authSession] || null;
}

async function setAuthSession(session) {
  await LOCAL_SETTINGS_STORAGE.set({ [STORAGE_KEYS.authSession]: session });
  await broadcastState();
}

async function clearAuthSession() {
  await LOCAL_SETTINGS_STORAGE.remove(STORAGE_KEYS.authSession);
  await LOCAL_SETTINGS_STORAGE.remove(STORAGE_KEYS.lastSyncAt);
  await LOCAL_SETTINGS_STORAGE.remove(STORAGE_KEYS.syncUserId);
  await broadcastState();
}

async function getAuthState() {
  const [session, lastSyncAt] = await Promise.all([
    getAuthSession(),
    getLastSyncAt(),
  ]);

  return {
    isConfigured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
    isAuthenticated: Boolean(session?.accessToken),
    email: session?.user?.email || "",
    userId: session?.user?.id || null,
    lastSyncAt,
  };
}

async function getLastSyncAt() {
  const data = await LOCAL_SETTINGS_STORAGE.get(STORAGE_KEYS.lastSyncAt);
  return data[STORAGE_KEYS.lastSyncAt] || null;
}

async function setLastSyncAt(value) {
  await LOCAL_SETTINGS_STORAGE.set({ [STORAGE_KEYS.lastSyncAt]: value });
}

async function getSyncUserId() {
  const data = await LOCAL_SETTINGS_STORAGE.get(STORAGE_KEYS.syncUserId);
  return data[STORAGE_KEYS.syncUserId] || null;
}

async function setSyncUserId(userId) {
  await LOCAL_SETTINGS_STORAGE.set({ [STORAGE_KEYS.syncUserId]: userId });
}

async function getPendingSync() {
  const data = await LOCAL_SETTINGS_STORAGE.get(STORAGE_KEYS.pendingSync);
  return {
    upserts: {},
    deletes: {},
    ...(data[STORAGE_KEYS.pendingSync] || {}),
  };
}

async function setPendingSync(pendingSync) {
  await LOCAL_SETTINGS_STORAGE.set({ [STORAGE_KEYS.pendingSync]: pendingSync });
}

async function queueEntriesForUpsert(entries) {
  if (!entries.length) {
    return;
  }

  const pendingSync = await getPendingSync();

  for (const entry of normalizeEntries(entries)) {
    pendingSync.upserts[entry.normalizedUrl] = serializePendingUpsert(entry);
    delete pendingSync.deletes[entry.normalizedUrl];
  }

  await setPendingSync(pendingSync);
}

async function queueEntryDelete(entry) {
  if (!entry?.normalizedUrl) {
    return;
  }

  const pendingSync = await getPendingSync();
  delete pendingSync.upserts[entry.normalizedUrl];
  pendingSync.deletes[entry.normalizedUrl] = {
    normalizedUrl: entry.normalizedUrl,
    deletedAt: new Date().toISOString(),
  };
  await setPendingSync(pendingSync);
}

async function sendMagicLink(email) {
  const trimmedEmail = String(email || "")
    .trim()
    .toLowerCase();
  if (!trimmedEmail) {
    throw new Error("Inserisci un indirizzo email valido");
  }

  const response = await fetchSupabase("/auth/v1/otp", {
    method: "POST",
    body: JSON.stringify({
      email: trimmedEmail,
      create_user: true,
      email_redirect_to: chrome.runtime.getURL("src/auth-callback.html"),
    }),
  });

  await readSupabaseJson(response);

  return {
    sent: true,
    email: trimmedEmail,
  };
}

async function completeAuthSession(payload) {
  const payloadSession = payload?.token_hash
    ? await exchangeTokenHashForSession(payload)
    : payload;
  const nextSession = normalizeSupabaseSession(payloadSession);
  const user = await fetchSupabaseUser(nextSession.accessToken);
  const session = {
    ...nextSession,
    user,
  };

  await setAuthSession(session);
  await syncSupabase();
  return getAuthState();
}

async function exchangeTokenHashForSession(payload) {
  const response = await fetchSupabase("/auth/v1/verify", {
    method: "POST",
    body: JSON.stringify({
      token_hash: payload.token_hash,
      type: payload.type || "email",
    }),
  });

  return readSupabaseJson(response);
}

async function signOutSupabase() {
  const session = await getAuthSession();

  if (session?.accessToken) {
    try {
      const response = await fetchSupabase("/auth/v1/logout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
        },
      });
      await readSupabaseJson(response, true);
    } catch {
      // Local sign-out should still succeed if the remote session is already invalid.
    }
  }

  await clearAuthSession();
  return getAuthState();
}

async function syncSupabase() {
  const session = await ensureValidAuthSession();
  if (!session?.user?.id) {
    throw new Error("Effettua prima l'accesso con magic link");
  }

  const syncedUserId = await getSyncUserId();
  if (syncedUserId && syncedUserId !== session.user.id) {
    await resetLocalSyncCache();
  }

  const syncStartedAt = new Date().toISOString();
  await flushPendingSync(session);

  const lastSyncAt = await getLastSyncAt();
  const [localEntries, remoteLinks] = await Promise.all([
    getEntries(),
    fetchRemoteLinks(session, lastSyncAt),
  ]);
  const mergedEntries = mergeEntriesForSync(localEntries, remoteLinks);

  if (!lastSyncAt && mergedEntries.length) {
    await upsertLinksToSupabase(mergedEntries, session);
  }

  await setEntries(mergedEntries);
  await setLastSyncAt(syncStartedAt);
  await setSyncUserId(session.user.id);
  await broadcastState();

  return {
    syncedCount: mergedEntries.length,
    changesPulled: remoteLinks.length,
    lastSyncAt: syncStartedAt,
  };
}

function normalizeSupabaseSession(payload = {}) {
  return {
    accessToken: payload.access_token || payload.accessToken || "",
    refreshToken: payload.refresh_token || payload.refreshToken || "",
    expiresAt:
      Number(payload.expires_at || payload.expiresAt || 0) ||
      Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600),
    tokenType: payload.token_type || payload.tokenType || "bearer",
  };
}

async function ensureValidAuthSession() {
  const session = await getAuthSession();
  if (!session?.accessToken || !session?.refreshToken) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if ((session.expiresAt || 0) > now + 60) {
    return session;
  }

  const response = await fetchSupabase(
    "/auth/v1/token?grant_type=refresh_token",
    {
      method: "POST",
      body: JSON.stringify({
        refresh_token: session.refreshToken,
      }),
    },
  );
  const data = await readSupabaseJson(response);
  const refreshedSession = {
    ...normalizeSupabaseSession(data),
    user: data.user || session.user,
  };

  await setAuthSession(refreshedSession);
  return refreshedSession;
}

async function fetchSupabaseUser(accessToken) {
  const response = await fetchSupabase("/auth/v1/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return readSupabaseJson(response);
}

async function fetchRemoteLinks(session, changedAfter = null) {
  const remoteLinks = [];
  let offset = 0;

  while (true) {
    const query = new URLSearchParams({
      select:
        "id,url,normalized_url,title,page_url,created_at,updated_at,deleted_at",
      order: "updated_at.desc",
      limit: String(SUPABASE_PAGE_SIZE),
      offset: String(offset),
    });

    if (changedAfter) {
      query.set("updated_at", `gt.${changedAfter}`);
    }

    const response = await fetchSupabase(`/rest/v1/links?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
      },
    });

    const page = await readSupabaseJson(response);
    remoteLinks.push(...page);

    if (page.length < SUPABASE_PAGE_SIZE) {
      break;
    }

    offset += SUPABASE_PAGE_SIZE;
  }

  return remoteLinks;
}

async function upsertLinksToSupabase(entries, session) {
  if (!entries.length) {
    return;
  }

  const payload = entries.map((entry) => ({
    id: entry.id,
    user_id: session.user.id,
    url: entry.url,
    normalized_url: entry.normalizedUrl,
    title: entry.title,
    page_url: entry.pageUrl || null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    deleted_at: null,
  }));

  const response = await fetchSupabase(
    "/rest/v1/links?on_conflict=user_id,normalized_url",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );

  await readSupabaseJson(response, true);
}

async function syncCreatedEntries(entries) {
  await queueEntriesForUpsert(entries);
  const session = await ensureValidAuthSession();
  if (!session?.user?.id) {
    return;
  }

  await flushPendingSync(session);
  await broadcastState();
}

async function markRemoteLinkDeleted(entry) {
  await queueEntryDelete(entry);
  const session = await ensureValidAuthSession();
  if (!session?.accessToken || !entry?.normalizedUrl) {
    return;
  }

  await flushPendingSync(session);
}

async function flushPendingSync(session) {
  const pendingSync = await getPendingSync();
  const pendingDeletes = Object.values(pendingSync.deletes);
  const pendingUpserts = Object.values(pendingSync.upserts);

  if (!pendingDeletes.length && !pendingUpserts.length) {
    return;
  }

  for (const pendingDelete of pendingDeletes) {
    await patchRemoteLinkDeleted(pendingDelete, session);
    delete pendingSync.deletes[pendingDelete.normalizedUrl];
  }

  if (pendingUpserts.length) {
    await upsertLinksToSupabase(pendingUpserts, session);
    for (const pendingUpsert of pendingUpserts) {
      delete pendingSync.upserts[pendingUpsert.normalizedUrl];
    }
  }

  await setPendingSync(pendingSync);
}

async function resetLocalSyncCache() {
  await setEntries([]);
  await setPendingSync({ upserts: {}, deletes: {} });
  await setLastSyncAt(null);
}

async function patchRemoteLinkDeleted(entry, session) {

  const response = await fetchSupabase(
    `/rest/v1/links?normalized_url=eq.${encodeURIComponent(entry.normalizedUrl)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        deleted_at: entry.deletedAt,
      }),
    },
  );

  await readSupabaseJson(response, true);
}

function mergeEntriesForSync(localEntries, remoteLinks) {
  const merged = new Map(
    localEntries.map((entry) => [entry.normalizedUrl, { ...entry }]),
  );

  for (const remoteLink of remoteLinks) {
    if (remoteLink.deleted_at) {
      merged.delete(remoteLink.normalized_url);
      continue;
    }

    merged.set(remoteLink.normalized_url, {
      id: remoteLink.id,
      url: remoteLink.url,
      normalizedUrl: remoteLink.normalized_url,
      title: remoteLink.title,
      pageUrl: remoteLink.page_url,
      createdAt: remoteLink.created_at,
      updatedAt: remoteLink.updated_at || remoteLink.created_at,
    });
  }

  return [...merged.values()].sort((left, right) =>
    String(right.updatedAt || right.createdAt || "").localeCompare(
      String(left.updatedAt || left.createdAt || ""),
    ),
  );
}

function normalizeEntries(entries) {
  return entries.map((entry) => ({
    ...entry,
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
  }));
}

function serializePendingUpsert(entry) {
  return {
    id: entry.id,
    url: entry.url,
    normalizedUrl: entry.normalizedUrl,
    title: entry.title,
    pageUrl: entry.pageUrl || null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt || entry.createdAt,
  };
}

function fetchSupabase(path, options = {}, skipContentType = false) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    ...(skipContentType ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };

  return fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers,
  });
}

async function readSupabaseJson(response, allowEmpty = false) {
  if (!response.ok) {
    const errorPayload = await safeJson(response);
    throw new Error(
      errorPayload?.msg ||
        errorPayload?.error_description ||
        errorPayload?.message ||
        `Supabase error ${response.status}`,
    );
  }

  const text = await response.text();
  if (!text) {
    return allowEmpty ? null : {};
  }

  return JSON.parse(text);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pickSyncSettings(settings) {
  const syncSettings = { ...settings };
  delete syncSettings.bookmarkFolderId;
  return syncSettings;
}

function pickLocalSettings(settings) {
  const localSettings = {};

  if (Object.hasOwn(settings, "bookmarkFolderId")) {
    localSettings.bookmarkFolderId = settings.bookmarkFolderId;
  }

  return localSettings;
}

function sanitizeSettings(nextSettings = {}) {
  const sanitized = {};

  if (Object.hasOwn(nextSettings, "captureWithShift")) {
    sanitized.captureWithShift = Boolean(nextSettings.captureWithShift);
  }

  if (Object.hasOwn(nextSettings, "captureAllClicks")) {
    sanitized.captureAllClicks = Boolean(nextSettings.captureAllClicks);
  }

  if (Object.hasOwn(nextSettings, "openLinksInNewTab")) {
    sanitized.openLinksInNewTab = Boolean(nextSettings.openLinksInNewTab);
  }

  if (Object.hasOwn(nextSettings, "bookmarkFolderId")) {
    sanitized.bookmarkFolderId = nextSettings.bookmarkFolderId || null;
  }

  if (Object.hasOwn(nextSettings, "bookmarkFolderTitle")) {
    sanitized.bookmarkFolderTitle =
      (
        nextSettings.bookmarkFolderTitle || DEFAULT_SETTINGS.bookmarkFolderTitle
      ).trim() || DEFAULT_SETTINGS.bookmarkFolderTitle;
  }

  if (Object.hasOwn(nextSettings, "siteRules")) {
    const siteRules = {};

    for (const [hostname, params] of Object.entries(
      nextSettings.siteRules || {},
    )) {
      const cleanedHostname = hostname.trim().toLowerCase();
      if (!cleanedHostname) {
        continue;
      }

      siteRules[cleanedHostname] = [
        ...new Set((params || []).map((param) => param.trim()).filter(Boolean)),
      ];
    }

    sanitized.siteRules = siteRules;
  }

  return sanitized;
}

async function saveLink(payload, sender) {
  return saveLinks([
    {
      url: payload?.url,
      title: payload?.title,
      text: payload?.text,
      pageUrl: payload?.pageUrl || sender?.tab?.url || null,
    },
  ]);
}

async function saveOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const links = tabs
    .filter((tab) => isSavableUrl(tab.url))
    .map((tab) => ({
      url: tab.url,
      title: tab.title || tab.url,
      text: "",
      pageUrl: null,
    }));

  return saveLinks(links);
}

async function saveLinks(links) {
  const entries = await getEntries();
  const settings = await getSettings();
  const knownUrls = new Set(entries.map((entry) => entry.normalizedUrl));
  const bookmarkUrls = settings.bookmarkFolderId
    ? await getBookmarkUrlSet(settings.bookmarkFolderId, settings.siteRules)
    : new Set();
  const createdEntries = [];
  let duplicateCount = 0;
  let bookmarkedCount = 0;

  for (const link of links) {
    if (!link?.url) {
      continue;
    }

    const normalizedUrl = normalizeUrl(link.url, settings.siteRules);

    if (knownUrls.has(normalizedUrl)) {
      duplicateCount += 1;
      continue;
    }

    if (bookmarkUrls.has(normalizedUrl)) {
      bookmarkedCount += 1;
      continue;
    }

    const entry = {
      id: crypto.randomUUID(),
      title: link.title?.trim() || link.text?.trim() || normalizedUrl,
      url: link.url,
      normalizedUrl,
      pageUrl: link.pageUrl || null,
      createdAt: new Date().toISOString(),
    };

    knownUrls.add(normalizedUrl);
    entries.unshift(entry);
    createdEntries.push(entry);
  }

  if (createdEntries.length) {
    await setEntries(entries);
    void syncCreatedEntries(createdEntries).catch(() => undefined);
  }

  if (links.length === 1) {
    if (createdEntries.length) {
      return {
        status: "saved",
        entry: createdEntries[0],
      };
    }

    if (duplicateCount) {
      return { status: "duplicate" };
    }

    if (bookmarkedCount) {
      return { status: "bookmarked" };
    }

    throw new Error("Missing URL");
  }

  return {
    status: createdEntries.length ? "saved" : "noop",
    savedCount: createdEntries.length,
    duplicateCount,
    bookmarkedCount,
    totalCount: links.length,
  };
}

async function inspectLink(url) {
  if (!isSavableUrl(url)) {
    return {
      canSave: false,
      savedEntry: null,
      isBookmarked: false,
    };
  }

  const settings = await getSettings();
  const entries = await getEntries();
  const normalizedUrl = normalizeUrl(url, settings.siteRules);
  const savedEntry =
    entries.find((entry) => entry.normalizedUrl === normalizedUrl) || null;
  let isBookmarked = false;

  if (settings.bookmarkFolderId) {
    try {
      isBookmarked = Boolean(
        await findBookmarkInFolder(settings.bookmarkFolderId, normalizedUrl),
      );
    } catch {
      isBookmarked = false;
    }
  }

  return {
    canSave: true,
    normalizedUrl,
    savedEntry,
    isBookmarked,
  };
}

async function bookmarkLink(payload) {
  const url = payload?.url;
  if (!isSavableUrl(url)) {
    throw new Error("Missing URL");
  }

  const settings = await getSettings();
  const normalizedUrl = normalizeUrl(url, settings.siteRules);
  const folderId = await ensureBookmarkFolder();
  const existingBookmark = await findBookmarkInFolder(folderId, normalizedUrl);

  if (!existingBookmark) {
    await chrome.bookmarks.create({
      parentId: folderId,
      title: payload?.title?.trim() || url,
      url,
    });
  }

  const entries = await getEntries();
  const savedEntry =
    entries.find((entry) => entry.normalizedUrl === normalizedUrl) || null;

  if (savedEntry) {
    await removeLink(savedEntry.id);
  }

  return {
    bookmarked: true,
    alreadyBookmarked: Boolean(existingBookmark),
    removedSavedEntry: Boolean(savedEntry),
  };
}

function isSavableUrl(url) {
  return typeof url === "string" && /^(https?:|ftp:)/i.test(url);
}

async function removeLinkByUrl(url) {
  const inspection = await inspectLink(url);

  if (!inspection.savedEntry) {
    return { removed: false };
  }

  return removeLink(inspection.savedEntry.id);
}

async function removeLink(id) {
  const entries = await getEntries();
  const removedEntry = entries.find((entry) => entry.id === id) || null;
  const nextEntries = entries.filter((entry) => entry.id !== id);
  await setEntries(nextEntries);
  if (removedEntry) {
    void markRemoteLinkDeleted(removedEntry).catch(() => undefined);
  }
  return { removed: entries.length !== nextEntries.length };
}

async function openLink(
  id,
  active = true,
  sender,
  openInCurrentTab = false,
  openInNewTab,
) {
  const entries = await getEntries();
  const settings = await getSettings();
  const entry = entries.find((item) => item.id === id);

  if (!entry) {
    throw new Error("Link not found");
  }

  const shouldOpenInNewTab =
    typeof openInNewTab === "boolean"
      ? openInNewTab
      : openInCurrentTab
        ? false
        : settings.openLinksInNewTab;

  await openUrl(entry.url, Boolean(active), shouldOpenInNewTab, sender);
  return entry;
}

async function openRandomLink(sender, context = {}) {
  const entries = await getEntries();
  const settings = await getSettings();

  if (!entries.length) {
    throw new Error("No saved links");
  }

  const entry = entries[Math.floor(Math.random() * entries.length)];
  await openUrl(entry.url, true, settings.openLinksInNewTab, sender, context);
  return entry;
}

async function openUrl(url, active, openInNewTab, sender, context = {}) {
  const targetTabId =
    typeof sender?.tab?.id === "number"
      ? sender.tab.id
      : typeof context?.tabId === "number"
        ? context.tabId
        : null;
  const targetWindowId =
    typeof sender?.tab?.windowId === "number"
      ? sender.tab.windowId
      : typeof context?.windowId === "number"
        ? context.windowId
        : undefined;

  if (!openInNewTab && targetTabId !== null) {
    await chrome.tabs.update(targetTabId, { url, active: Boolean(active) });
    return;
  }

  await chrome.tabs.create({
    url,
    active: Boolean(active),
    ...(typeof targetWindowId === "number" ? { windowId: targetWindowId } : {}),
  });
}

async function promoteLink(id) {
  const entries = await getEntries();
  const entry = entries.find((item) => item.id === id);

  if (!entry) {
    throw new Error("Link not found");
  }

  const folderId = await ensureBookmarkFolder();
  const existingBookmark = await findBookmarkInFolder(
    folderId,
    entry.normalizedUrl,
  );

  if (!existingBookmark) {
    await chrome.bookmarks.create({
      parentId: folderId,
      title: entry.title,
      url: entry.url,
    });
  }

  await removeLink(id);
  return {
    promoted: true,
    alreadyBookmarked: Boolean(existingBookmark),
  };
}

async function ensureBookmarkFolder() {
  const settings = await getSettings();

  if (settings.bookmarkFolderId) {
    try {
      const node = await chrome.bookmarks.get(settings.bookmarkFolderId);
      if (node?.[0]) {
        return settings.bookmarkFolderId;
      }
    } catch {
      // Ignore stale folder id and recreate below.
    }
  }

  const [bookmarkRoot] = await chrome.bookmarks.getTree();
  const bookmarksBar = findBookmarksBar(bookmarkRoot);
  const existingFolder = findFolderByTitle(
    bookmarksBar,
    settings.bookmarkFolderTitle || DEFAULT_SETTINGS.bookmarkFolderTitle,
  );

  if (existingFolder) {
    await updateSettings({
      bookmarkFolderId: existingFolder.id,
      bookmarkFolderTitle: existingFolder.title,
    });
    return existingFolder.id;
  }

  const folder = await chrome.bookmarks.create({
    parentId: bookmarksBar.id,
    title: settings.bookmarkFolderTitle || DEFAULT_SETTINGS.bookmarkFolderTitle,
  });

  await updateSettings({ bookmarkFolderId: folder.id });
  return folder.id;
}

function findBookmarksBar(root) {
  const queue = [root];

  while (queue.length) {
    const node = queue.shift();
    if (!node) {
      continue;
    }

    if (node.id === "1" || node.title === "Bookmarks bar") {
      return node;
    }

    for (const child of node.children || []) {
      queue.push(child);
    }
  }

  throw new Error("Bookmarks bar not found");
}

function findFolderByTitle(root, title) {
  const queue = [root];

  while (queue.length) {
    const node = queue.shift();
    if (!node) {
      continue;
    }

    if (!node.url && node.title === title) {
      return node;
    }

    for (const child of node.children || []) {
      queue.push(child);
    }
  }

  return null;
}

async function listBookmarkFolders() {
  const [bookmarkRoot] = await chrome.bookmarks.getTree();
  const folders = [];

  for (const child of bookmarkRoot.children || []) {
    if (!child.url) {
      collectBookmarkFolders(child, folders, "");
    }
  }

  return folders;
}

async function importBookmarkFolder(folderId) {
  if (!folderId) {
    throw new Error("Missing folder id");
  }

  const tree = await chrome.bookmarks.getSubTree(folderId);
  const root = tree?.[0];
  if (!root) {
    throw new Error("Bookmark folder not found");
  }

  return saveLinks(collectBookmarkLinks(root));
}

function collectBookmarkFolders(node, folders, parentPath) {
  const title = node.title || "Senza nome";
  const currentPath = parentPath ? `${parentPath} / ${title}` : title;

  if (!node.url) {
    folders.push({
      id: node.id,
      title,
      path: currentPath,
    });
  }

  for (const child of node.children || []) {
    if (!child.url) {
      collectBookmarkFolders(child, folders, currentPath);
    }
  }
}

function collectBookmarkLinks(node) {
  const links = [];
  const queue = [node];

  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (current.url && isSavableUrl(current.url)) {
      links.push({
        url: current.url,
        title: current.title || current.url,
        text: "",
        pageUrl: null,
      });
      continue;
    }

    for (const child of current.children || []) {
      queue.push(child);
    }
  }

  return links;
}

async function findBookmarkInFolder(folderId, normalizedUrl) {
  const children = await chrome.bookmarks.getChildren(folderId);
  const settings = await getSettings();

  return (
    children.find(
      (child) =>
        child.url &&
        normalizeUrl(child.url, settings.siteRules) === normalizedUrl,
    ) || null
  );
}

async function getBookmarkUrlSet(folderId, siteRules) {
  try {
    const children = await chrome.bookmarks.getChildren(folderId);
    return new Set(
      children
        .filter((child) => child.url)
        .map((child) => normalizeUrl(child.url, siteRules)),
    );
  } catch {
    return new Set();
  }
}

function normalizeUrl(input, siteRules = {}) {
  const url = new URL(input);
  url.hash = "";

  const ignoredParams = resolveIgnoredParams(url.hostname, siteRules);
  for (const param of ignoredParams) {
    url.searchParams.delete(param);
  }

  url.search = sortSearchParams(url.searchParams).toString();

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

function resolveIgnoredParams(hostname, siteRules) {
  const normalizedHostname = hostname.toLowerCase();
  const globalRules = siteRules["*"] || [];
  const directRules = siteRules[normalizedHostname] || [];
  const wildcardRules = Object.entries(siteRules)
    .filter(([ruleHostname]) => ruleHostname.startsWith("*."))
    .filter(
      ([ruleHostname]) =>
        normalizedHostname === ruleHostname.slice(2) ||
        normalizedHostname.endsWith(`.${ruleHostname.slice(2)}`),
    )
    .flatMap(([, params]) => params);

  return [...new Set([...globalRules, ...directRules, ...wildcardRules])];
}

function sortSearchParams(searchParams) {
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

async function broadcastState() {
  const state = await getState();
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, { type: "state-updated", payload: state })
          .catch(() => undefined),
      ),
  );
}
