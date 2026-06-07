const statusNode = document.getElementById("status");

void completeAuth();

async function completeAuth() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const error =
    params.get("error_description") || query.get("error_description");

  if (error) {
    setStatus(decodeURIComponent(error), true);
    return;
  }

  const session = {
    access_token: params.get("access_token") || query.get("access_token"),
    refresh_token: params.get("refresh_token") || query.get("refresh_token"),
    expires_in: Number(
      params.get("expires_in") || query.get("expires_in") || 0,
    ),
    expires_at: Number(
      params.get("expires_at") || query.get("expires_at") || 0,
    ),
    token_type: params.get("token_type") || query.get("token_type") || "bearer",
    token_hash: params.get("token_hash") || query.get("token_hash"),
    type: params.get("type") || query.get("type") || "email",
  };

  if (
    (!session.access_token || !session.refresh_token) &&
    !session.token_hash
  ) {
    setStatus(chrome.i18n.getMessage("auth_invalid_link"), true);
    return;
  }

  try {
    await sendMessage({
      type: "complete-auth-session",
      payload: session,
    });
    setStatus(chrome.i18n.getMessage("auth_completed"));
  } catch (errorInstance) {
    setStatus(
      errorInstance.message || chrome.i18n.getMessage("auth_complete_error"),
      true,
    );
  }
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
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
