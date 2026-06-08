import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const SUPABASE_PAGE_SIZE = 1000;

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function normalizeSupabaseSession(payload = {}) {
  return {
    accessToken: payload.access_token || payload.accessToken || "",
    refreshToken: payload.refresh_token || payload.refreshToken || "",
    expiresAt:
      Number(payload.expires_at || payload.expiresAt || 0) ||
      Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600),
    tokenType: payload.token_type || payload.tokenType || "bearer",
  };
}

export async function sendMagicLinkRequest(email, redirectTo) {
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
      redirect_to: redirectTo,
    }),
  });

  await readSupabaseJson(response);

  return {
    sent: true,
    email: trimmedEmail,
  };
}

export async function exchangeTokenHashForSession(payload) {
  const response = await fetchSupabase("/auth/v1/verify", {
    method: "POST",
    body: JSON.stringify({
      token_hash: payload.token_hash,
      type: payload.type || "email",
    }),
  });

  return readSupabaseJson(response);
}

export async function refreshSupabaseSession(refreshToken) {
  const response = await fetchSupabase(
    "/auth/v1/token?grant_type=refresh_token",
    {
      method: "POST",
      body: JSON.stringify({
        refresh_token: refreshToken,
      }),
    },
  );

  return readSupabaseJson(response);
}

export async function fetchSupabaseUser(accessToken) {
  const response = await fetchSupabase("/auth/v1/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return readSupabaseJson(response);
}

export async function signOutRequest(accessToken) {
  const response = await fetchSupabase("/auth/v1/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return readSupabaseJson(response, true);
}

export async function fetchRemoteLinks(session, revisionAfter = null) {
  const remoteLinks = [];
  let offset = 0;

  while (true) {
    const query = new URLSearchParams({
      select:
        "id,url,normalized_url,title,page_url,created_at,updated_at,revision_id,deleted_at,is_seen,seen_at,is_favorite,favorited_at,tags",
      order: "revision_id.asc",
      limit: String(SUPABASE_PAGE_SIZE),
      offset: String(offset),
    });

    if (Number.isFinite(revisionAfter) && revisionAfter > 0) {
      query.set("revision_id", `gt.${revisionAfter}`);
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

export async function upsertLinksToSupabase(entries, session) {
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
    is_seen: Boolean(entry.isSeen),
    seen_at: entry.seenAt || null,
    is_favorite: Boolean(entry.isFavorite),
    favorited_at: entry.favoritedAt || null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
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

export async function patchRemoteLinkDeleted(entry, session) {
  const response = await fetchSupabase(
    `/rest/v1/links?normalized_url=eq.${encodeURIComponent(entry.normalizedUrl)}&user_id=eq.${session.user.id}`,
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
