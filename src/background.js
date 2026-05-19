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
const SYNC_FLUSH_DEBOUNCE_MS = 15000;
const SYNC_PERIODIC_FLUSH_MINUTES = 2;
const SYNC_FLUSH_ALARM = "pending-sync-flush";
const SYNC_PERIODIC_ALARM = "periodic-sync-flush";

const CONTEXT_MENU_ID = "save-link-from-context-menu";
let pendingSyncFlushPromise = null;
let isPendingSyncFlushRunning = false;

const DEFAULT_SETTINGS = {
  captureWithShift: true,
  captureAllClicks: false,
  openLinksInNewTab: true,
  skipSeenInNavigation: false,
  skipFavoriteInNavigation: false,
  barVisibilityMode: "always",
  barVisibilitySites: [],
  bookmarkFolderId: null,
  bookmarkFolderTitle: "Link Manager",
  siteRules: {},
};

const DEFAULT_SYNC_SETTINGS = {
  captureWithShift: DEFAULT_SETTINGS.captureWithShift,
  captureAllClicks: DEFAULT_SETTINGS.captureAllClicks,
  openLinksInNewTab: DEFAULT_SETTINGS.openLinksInNewTab,
  skipSeenInNavigation: DEFAULT_SETTINGS.skipSeenInNavigation,
  skipFavoriteInNavigation: DEFAULT_SETTINGS.skipFavoriteInNavigation,
  barVisibilityMode: DEFAULT_SETTINGS.barVisibilityMode,
  barVisibilitySites: DEFAULT_SETTINGS.barVisibilitySites,
  bookmarkFolderTitle: DEFAULT_SETTINGS.bookmarkFolderTitle,
  siteRules: DEFAULT_SETTINGS.siteRules,
};

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();

  await ensureContextMenu();
  await initializeSyncScheduler();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSettingsStorage();
  void ensureContextMenu();
  void initializeSyncScheduler();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (![SYNC_FLUSH_ALARM, SYNC_PERIODIC_ALARM].includes(alarm?.name)) {
    return;
  }

  void runScheduledPendingSyncFlush();
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
      return importBookmarkFolder(message.payload?.folderId, message.payload);
    case "bookmark-link":
      return bookmarkLink(message.payload);
    case "toggle-seen":
      return toggleEntrySeen(message.payload?.id);
    case "toggle-favorite":
      return toggleEntryFavorite(message.payload?.id);
    case "save-link":
      return saveLink(message.payload, sender);
    case "update-link":
      return updateLink(message.payload);
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

async function initializeSyncScheduler() {
  await chrome.alarms.create(SYNC_PERIODIC_ALARM, {
    periodInMinutes: SYNC_PERIODIC_FLUSH_MINUTES,
  });

  if (await hasPendingSyncChanges()) {
    await schedulePendingSyncFlush();
  }
}

async function schedulePendingSyncFlush() {
  await chrome.alarms.create(SYNC_FLUSH_ALARM, {
    when: Date.now() + SYNC_FLUSH_DEBOUNCE_MS,
  });
}

async function hasPendingSyncChanges() {
  const pendingSync = await getPendingSync();
  return Boolean(
    Object.keys(pendingSync.upserts || {}).length ||
    Object.keys(pendingSync.deletes || {}).length,
  );
}

async function runScheduledPendingSyncFlush() {
  if (pendingSyncFlushPromise) {
    return pendingSyncFlushPromise;
  }

  pendingSyncFlushPromise = (async () => {
    if (!(await hasPendingSyncChanges())) {
      return false;
    }

    const session = await ensureValidAuthSession();
    if (!session?.user?.id) {
      return false;
    }

    isPendingSyncFlushRunning = true;
    void broadcastState();
    await flushPendingSync(session);
    isPendingSyncFlushRunning = false;
    void broadcastState();
    return true;
  })()
    .catch((error) => {
      isPendingSyncFlushRunning = false;
      throw error;
    })
    .finally(() => {
      isPendingSyncFlushRunning = false;
      pendingSyncFlushPromise = null;
    });

  return pendingSyncFlushPromise;
}

function formatSaveStatusMessage(status) {
  const feedback = {
    duplicate: "Link gia presente",
    updated: "Stato link aggiornato",
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
  const [entries, settings, auth, sync] = await Promise.all([
    getEntries(),
    getSettings(),
    getAuthState(),
    getSyncStatus(),
  ]);
  return { entries, settings, auth, sync };
}

async function getSyncStatus() {
  const [pendingSync, flushAlarm] = await Promise.all([
    getPendingSync(),
    chrome.alarms.get(SYNC_FLUSH_ALARM),
  ]);

  const upsertCount = Object.keys(pendingSync.upserts || {}).length;
  const deleteCount = Object.keys(pendingSync.deletes || {}).length;

  return {
    pendingUpserts: upsertCount,
    pendingDeletes: deleteCount,
    pendingCount: upsertCount + deleteCount,
    isFlushScheduled: Boolean(flushAlarm),
    isSyncing: isPendingSyncFlushRunning,
    nextFlushAt: flushAlarm?.scheduledTime || null,
  };
}

async function getEntries() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.entries);
  return normalizeEntries(data[STORAGE_KEYS.entries] || []);
}

async function setEntries(entries) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.entries]: normalizeEntries(entries),
  });
  void broadcastState();
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
  void broadcastState();
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
      redirect_to: chrome.runtime.getURL("src/auth-callback.html"),
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
  void broadcastState();

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
        "id,url,normalized_url,title,page_url,created_at,updated_at,deleted_at,is_seen,seen_at,is_favorite,favorited_at",
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
    is_seen: Boolean(entry.isSeen),
    seen_at: entry.seenAt || null,
    is_favorite: Boolean(entry.isFavorite),
    favorited_at: entry.favoritedAt || null,
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
  await schedulePendingSyncFlush();
  void broadcastState();
}

async function markRemoteLinkDeleted(entry) {
  await queueEntryDelete(entry);
  if (!entry?.normalizedUrl) {
    return;
  }

  await schedulePendingSyncFlush();
  void broadcastState();
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
      isSeen: Boolean(remoteLink.is_seen),
      seenAt: remoteLink.seen_at || null,
      isFavorite: Boolean(remoteLink.is_favorite),
      favoritedAt: remoteLink.favorited_at || null,
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
    isSeen: Boolean(entry.isSeen),
    seenAt:
      entry.seenAt ||
      (entry.isSeen
        ? entry.updatedAt || entry.createdAt || new Date().toISOString()
        : null),
    isFavorite: Boolean(entry.isFavorite),
    favoritedAt:
      entry.favoritedAt ||
      (entry.isFavorite
        ? entry.updatedAt || entry.createdAt || new Date().toISOString()
        : null),
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
    isSeen: Boolean(entry.isSeen),
    seenAt: entry.seenAt || null,
    isFavorite: Boolean(entry.isFavorite),
    favoritedAt: entry.favoritedAt || null,
  };
}

function createEntryFromLink(link, normalizedUrl) {
  const now = new Date().toISOString();
  return normalizeEntries([
    {
      id: crypto.randomUUID(),
      title: link.title?.trim() || link.text?.trim() || normalizedUrl,
      url: link.url,
      normalizedUrl,
      pageUrl: link.pageUrl || null,
      createdAt: now,
      updatedAt: now,
      isSeen: Boolean(link.isSeen),
      seenAt: link.seenAt || null,
      isFavorite: Boolean(link.isFavorite),
      favoritedAt: link.favoritedAt || null,
    },
  ])[0];
}

function mergeEntryWithLink(existingEntry, link) {
  const current = normalizeEntries([existingEntry])[0];
  let nextEntry = current;
  let changed = false;
  const now = new Date().toISOString();

  if (link.isSeen && !current.isSeen) {
    nextEntry = {
      ...nextEntry,
      isSeen: true,
      seenAt: link.seenAt || now,
      updatedAt: now,
    };
    changed = true;
  }

  if (link.isFavorite && !nextEntry.isFavorite) {
    nextEntry = {
      ...nextEntry,
      isFavorite: true,
      favoritedAt: link.favoritedAt || now,
      updatedAt: now,
    };
    changed = true;
  }

  return changed ? normalizeEntries([nextEntry])[0] : current;
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

  if (Object.hasOwn(nextSettings, "skipSeenInNavigation")) {
    sanitized.skipSeenInNavigation = Boolean(nextSettings.skipSeenInNavigation);
  }

  if (Object.hasOwn(nextSettings, "skipFavoriteInNavigation")) {
    sanitized.skipFavoriteInNavigation = Boolean(
      nextSettings.skipFavoriteInNavigation,
    );
  }

  if (Object.hasOwn(nextSettings, "barVisibilityMode")) {
    sanitized.barVisibilityMode = ["always", "whitelist", "blacklist"].includes(
      nextSettings.barVisibilityMode,
    )
      ? nextSettings.barVisibilityMode
      : DEFAULT_SETTINGS.barVisibilityMode;
  }

  if (Object.hasOwn(nextSettings, "barVisibilitySites")) {
    sanitized.barVisibilitySites = [
      ...new Set(
        (Array.isArray(nextSettings.barVisibilitySites)
          ? nextSettings.barVisibilitySites
          : []
        )
          .map((site) =>
            String(site || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    ];
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
      isSeen: payload?.isSeen,
      seenAt: payload?.isSeen
        ? payload?.seenAt || new Date().toISOString()
        : null,
      isFavorite: payload?.isFavorite,
      favoritedAt: payload?.isFavorite
        ? payload?.favoritedAt || new Date().toISOString()
        : null,
    },
  ]);
}

async function updateLink(payload) {
  const id = payload?.id;
  const url = String(payload?.url || "").trim();

  if (!id) {
    throw new Error("Missing link id");
  }

  if (!isSavableUrl(url)) {
    throw new Error("Inserisci un URL valido");
  }

  const entries = await getEntries();
  const settings = await getSettings();
  const currentEntry = entries.find((entry) => entry.id === id);

  if (!currentEntry) {
    throw new Error("Link not found");
  }

  const normalizedUrl = normalizeUrl(url, settings.siteRules);
  const conflictingEntry = entries.find(
    (entry) => entry.id !== id && entry.normalizedUrl === normalizedUrl,
  );

  if (conflictingEntry) {
    throw new Error("Esiste gia un link con questo URL");
  }

  const now = new Date().toISOString();
  const nextIsSeen = Boolean(payload?.isSeen);
  const nextIsFavorite = Boolean(payload?.isFavorite);
  const nextEntry = normalizeEntries([
    {
      ...currentEntry,
      url,
      normalizedUrl,
      title: String(payload?.title || "").trim() || url,
      pageUrl:
        String(payload?.pageUrl || "").trim() || currentEntry.pageUrl || url,
      isSeen: nextIsSeen,
      seenAt: nextIsSeen
        ? currentEntry.isSeen
          ? currentEntry.seenAt || now
          : now
        : null,
      isFavorite: nextIsFavorite,
      favoritedAt: nextIsFavorite
        ? currentEntry.isFavorite
          ? currentEntry.favoritedAt || now
          : now
        : null,
      updatedAt: now,
    },
  ])[0];

  const nextEntries = entries.map((entry) =>
    entry.id === id ? nextEntry : entry,
  );
  await setEntries(nextEntries);

  if (currentEntry.normalizedUrl !== nextEntry.normalizedUrl) {
    await queueEntryDelete(currentEntry);
  }

  void syncCreatedEntries([nextEntry]).catch(() => undefined);

  return {
    updated: true,
    entry: nextEntry,
  };
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
  const entriesByUrl = new Map(
    entries.map((entry) => [entry.normalizedUrl, entry]),
  );
  const nextEntries = [...entries];
  const createdEntries = [];
  const updatedEntries = [];
  let duplicateCount = 0;

  for (const link of links) {
    if (!link?.url) {
      continue;
    }

    const normalizedUrl = normalizeUrl(link.url, settings.siteRules);
    const existingEntry = entriesByUrl.get(normalizedUrl) || null;

    if (existingEntry) {
      const nextEntry = mergeEntryWithLink(existingEntry, link);
      if (nextEntry.updatedAt !== existingEntry.updatedAt) {
        const entryIndex = nextEntries.findIndex(
          (entry) => entry.id === existingEntry.id,
        );
        if (entryIndex !== -1) {
          nextEntries[entryIndex] = nextEntry;
        }
        entriesByUrl.set(normalizedUrl, nextEntry);
        updatedEntries.push(nextEntry);
      } else {
        duplicateCount += 1;
      }
      continue;
    }

    const entry = createEntryFromLink(link, normalizedUrl);

    entriesByUrl.set(normalizedUrl, entry);
    nextEntries.unshift(entry);
    createdEntries.push(entry);
  }

  if (createdEntries.length || updatedEntries.length) {
    await setEntries(nextEntries);
    void syncCreatedEntries([...createdEntries, ...updatedEntries]).catch(
      () => undefined,
    );
  }

  if (links.length === 1) {
    if (createdEntries.length) {
      return {
        status: "saved",
        entry: createdEntries[0],
      };
    }

    if (updatedEntries.length) {
      return {
        status: "updated",
        entry: updatedEntries[0],
      };
    }

    if (duplicateCount) {
      return { status: "duplicate" };
    }

    throw new Error("Missing URL");
  }

  return {
    status: createdEntries.length || updatedEntries.length ? "saved" : "noop",
    savedCount: createdEntries.length,
    updatedCount: updatedEntries.length,
    duplicateCount,
    totalCount: links.length,
  };
}

async function inspectLink(url) {
  if (!isSavableUrl(url)) {
    return {
      canSave: false,
      savedEntry: null,
      isBookmarked: false,
      isFavorite: false,
      isSeen: false,
    };
  }

  const settings = await getSettings();
  const entries = await getEntries();
  const normalizedUrl = normalizeUrl(url, settings.siteRules);
  const savedEntry =
    entries.find((entry) => entry.normalizedUrl === normalizedUrl) || null;
  const isFavorite = Boolean(savedEntry?.isFavorite);
  const isSeen = Boolean(savedEntry?.isSeen);

  return {
    canSave: true,
    normalizedUrl,
    savedEntry,
    isBookmarked: isFavorite,
    isFavorite,
    isSeen,
  };
}

async function bookmarkLink(payload) {
  const url = payload?.url;
  if (!isSavableUrl(url)) {
    throw new Error("Missing URL");
  }

  const entries = await getEntries();
  const settings = await getSettings();
  const normalizedUrl = normalizeUrl(url, settings.siteRules);
  const savedEntry =
    entries.find((entry) => entry.normalizedUrl === normalizedUrl) || null;
  const now = new Date().toISOString();

  if (savedEntry) {
    const nextEntry = savedEntry.isFavorite
      ? savedEntry
      : {
          ...savedEntry,
          isFavorite: true,
          favoritedAt: savedEntry.favoritedAt || now,
          updatedAt: now,
        };

    if (!savedEntry.isFavorite) {
      const nextEntries = entries.map((entry) =>
        entry.id === savedEntry.id ? nextEntry : entry,
      );
      await setEntries(nextEntries);
      void syncCreatedEntries([nextEntry]).catch(() => undefined);
    }

    return {
      bookmarked: true,
      favorited: true,
      alreadyBookmarked: savedEntry.isFavorite,
      alreadyFavorite: savedEntry.isFavorite,
      entry: nextEntry,
    };
  }

  const entry = createEntryFromLink(
    {
      url,
      title: payload?.title,
      text: "",
      pageUrl: payload?.pageUrl || url,
      isFavorite: true,
      favoritedAt: now,
    },
    normalizedUrl,
  );
  entry.updatedAt = now;

  await setEntries([entry, ...entries]);
  void syncCreatedEntries([entry]).catch(() => undefined);

  return {
    bookmarked: true,
    favorited: true,
    alreadyBookmarked: false,
    alreadyFavorite: false,
    entry,
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
  const navigationEntries = filterNavigationEntries(entries, settings);

  if (!navigationEntries.length) {
    throw new Error("No saved links");
  }

  const entry =
    navigationEntries[Math.floor(Math.random() * navigationEntries.length)];
  await openUrl(entry.url, true, settings.openLinksInNewTab, sender, context);
  return entry;
}

function filterNavigationEntries(entries, settings = {}) {
  return normalizeEntries(entries).filter((entry) => {
    if (settings.skipSeenInNavigation && entry.isSeen) {
      return false;
    }

    if (settings.skipFavoriteInNavigation && entry.isFavorite) {
      return false;
    }

    return true;
  });
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

  const now = new Date().toISOString();
  const nextEntry = entry.isFavorite
    ? entry
    : {
        ...entry,
        isFavorite: true,
        favoritedAt: entry.favoritedAt || now,
        updatedAt: now,
      };

  if (!entry.isFavorite) {
    const nextEntries = entries.map((item) =>
      item.id === id ? nextEntry : item,
    );
    await setEntries(nextEntries);
    void syncCreatedEntries([nextEntry]).catch(() => undefined);
  }

  return {
    promoted: true,
    favorited: true,
    alreadyBookmarked: entry.isFavorite,
    alreadyFavorite: entry.isFavorite,
    entry: nextEntry,
  };
}

async function toggleEntrySeen(id) {
  return toggleEntryFlag(id, "isSeen", "seenAt");
}

async function toggleEntryFavorite(id) {
  return toggleEntryFlag(id, "isFavorite", "favoritedAt");
}

async function toggleEntryFlag(id, flagKey, timestampKey) {
  const entries = await getEntries();
  const entry = entries.find((item) => item.id === id);

  if (!entry) {
    throw new Error("Link not found");
  }

  const nextFlagValue = !entry[flagKey];
  const now = new Date().toISOString();
  const nextEntry = {
    ...entry,
    [flagKey]: nextFlagValue,
    [timestampKey]: nextFlagValue ? entry[timestampKey] || now : null,
    updatedAt: now,
  };

  await setEntries(entries.map((item) => (item.id === id ? nextEntry : item)));
  void syncCreatedEntries([nextEntry]).catch(() => undefined);

  return {
    entry: nextEntry,
    enabled: nextFlagValue,
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

async function importBookmarkFolder(folderId, options = {}) {
  if (!folderId) {
    throw new Error("Missing folder id");
  }

  const tree = await chrome.bookmarks.getSubTree(folderId);
  const root = tree?.[0];
  if (!root) {
    throw new Error("Bookmark folder not found");
  }

  return saveLinks(collectBookmarkLinks(root, options));
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

function collectBookmarkLinks(node, options = {}) {
  const links = [];
  const queue = [node];
  const markAsSeen = Boolean(options.importAsSeen);
  const markAsFavorite = Boolean(options.importAsFavorite);
  const importedAt = new Date().toISOString();

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
        isSeen: markAsSeen,
        seenAt: markAsSeen ? importedAt : null,
        isFavorite: markAsFavorite,
        favoritedAt: markAsFavorite ? importedAt : null,
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

  // await Promise.all(
  //   tabs
  //     .filter((tab) => typeof tab.id === "number")
  //     .map((tab) =>
  //       chrome.tabs
  //         .sendMessage(tab.id, { type: "state-updated", payload: state })
  //         .catch(() => undefined),
  //     ),
  // );
}
