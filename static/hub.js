// meso.utilities — hub (master page) interactions.
// "Share to Slack": Slack has no public post-a-message URL, and this hub has no
// backend, so we copy a ready-to-paste message to the clipboard instead.
const shareBtn = document.getElementById("share-slack");
const toast = document.getElementById("toast");
let toastTimer;

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

if (shareBtn) {
  shareBtn.addEventListener("click", async () => {
    const message = `meso.utilities — small tools for the team: ${location.href}`;
    try {
      await navigator.clipboard.writeText(message);
      showToast("Copied — paste it into Slack 💬");
    } catch {
      showToast("Couldn't copy — the link is in the address bar");
    }
  });
}

/* ------------------------------ favourites -------------------------------
   A ☆ star at the top-right of every tool card marks it as a favourite.
   Favourites float to the top of the grid and persist in localStorage. */

const FAVORITES_KEY = "meso-fav-tools";
const cardsSection = document.querySelector(".cards");
/** Cards in their authored order, so unstarring restores the default sort. */
const originalCards = [...document.querySelectorAll(".cards .card[data-tool]")];

function readFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeFavorites(ids) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    /* storage may be unavailable; favourites just won't persist */
  }
}

function applyFavoriteState(button, isFavorite) {
  button.classList.toggle("is-fav", isFavorite);
  button.textContent = isFavorite ? "★" : "☆";
  button.setAttribute("aria-pressed", String(isFavorite));
  const tool = button.closest(".card")?.querySelector("h2")?.textContent ?? "this tool";
  button.setAttribute(
    "aria-label",
    isFavorite ? `Remove ${tool} from favourites` : `Add ${tool} to favourites`,
  );
  button.title = isFavorite ? "Remove from favourites" : "Add to favourites";
}

/** Favourites first; JS sort is stable, so authored order is kept otherwise. */
function sortCardsByFavorite() {
  if (!cardsSection) return;
  const favorites = new Set(readFavorites());
  const ranked = [...originalCards].sort(
    (a, b) => Number(favorites.has(b.dataset.tool)) - Number(favorites.has(a.dataset.tool)),
  );
  for (const card of ranked) cardsSection.appendChild(card);
}

function toggleFavorite(tool, button) {
  const favorites = readFavorites();
  const isFavorite = !favorites.includes(tool);
  writeFavorites(isFavorite ? [...favorites, tool] : favorites.filter((id) => id !== tool));
  applyFavoriteState(button, isFavorite);
  sortCardsByFavorite();
  showToast(isFavorite ? "Added to favourites ★" : "Removed from favourites");
}

const savedFavorites = new Set(readFavorites());
for (const card of originalCards) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fav-btn";
  button.addEventListener("click", (event) => {
    event.preventDefault(); // the card is a link — don't navigate
    event.stopPropagation();
    toggleFavorite(card.dataset.tool, button);
  });
  applyFavoriteState(button, savedFavorites.has(card.dataset.tool));
  card.appendChild(button);
}
sortCardsByFavorite();
