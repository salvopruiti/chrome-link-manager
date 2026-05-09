const searchInput = document.getElementById("searchInput");
const resultsNode = document.getElementById("results");
const countNode = document.getElementById("count");
const statusNode = document.getElementById("status");
const randomButton = document.getElementById("randomButton");

let popupState = {
  entries: [],
};
let searchQuery = "";
let pendingAction = null;

init();

searchInput.addEventListener("input", (event) => {
  searchQuery = event.target.value;
  render();
});

randomButton.addEventListener("click", async () => {
  await runAction("random", async () => {
    await sendMessage({ type: "open-random-link" });
    window.close();
  });
});

async function init() {
  try {
    popupState = await sendMessage({ type: "get-state" });
    render();
  } catch (error) {
    setStatus(error.message || "Impossibile caricare i link", true);
  }
}

function render() {
  countNode.textContent = String(popupState.entries.length);

  const filteredEntries = filterEntries(searchQuery, popupState.entries);
  resultsNode.innerHTML = !searchQuery.trim()
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
                  <button class="icon-button" data-action="promote" data-id="${escapeHtml(entry.id)}" title="Aggiungi ai preferiti" aria-label="Aggiungi ai preferiti">
                    ${isPending("promote", entry.id) ? spinnerMarkup() : iconMarkup("star")}
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
            popupState.entries = popupState.entries.filter((entry) => entry.id !== id);
            setStatus("Link rimosso");
            break;
          case "promote":
            await sendMessage({ type: "promote-link", payload: { id } });
            popupState.entries = popupState.entries.filter((entry) => entry.id !== id);
            setStatus("Link spostato nei preferiti");
            break;
          default:
            break;
        }
      }, id);
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

function filterEntries(query, entries) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return entries
    .filter((entry) =>
      [entry.title, entry.url, entry.pageUrl]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    )
    .slice(0, 40);
}

function iconMarkup(name) {
  const icons = {
    star: '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"/></svg></span>',
    trash: '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v8H8V9Zm6 0h2v8h-2V9ZM6 9h12l-1 11H7L6 9Z"/></svg></span>',
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