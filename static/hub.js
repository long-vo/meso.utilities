// meso.utilities — hub (master page) interactions.
import { registerCommands } from "./palette.js";

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

async function shareToSlack() {
  const message = `meso.utilities — small tools for the team: ${location.href}`;
  try {
    await navigator.clipboard.writeText(message);
    showToast("Copied — paste it into Slack 💬");
  } catch {
    showToast("Couldn't copy — the link is in the address bar");
  }
}

if (shareBtn) shareBtn.addEventListener("click", shareToSlack);

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
  applyFilter();
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

/* --------------------- show favourites only (filter) ---------------------
   A toolbar toggle hides every non-favourite card; the choice persists in
   localStorage. With the filter on and nothing starred, an empty-state hint
   replaces the grid. */

const FAV_ONLY_KEY = "meso-fav-only";

function readFavOnly() {
  return localStorage.getItem(FAV_ONLY_KEY) === "1";
}

function writeFavOnly(on) {
  try {
    localStorage.setItem(FAV_ONLY_KEY, on ? "1" : "0");
  } catch {
    /* storage may be unavailable; the choice just won't persist */
  }
}

// Toggle pill, in its own toolbar row just above the cards grid.
const favFilterBtn = document.createElement("button");
favFilterBtn.type = "button";
favFilterBtn.id = "fav-filter";
favFilterBtn.className = "pill pill-toggle";
const favFilterStar = document.createElement("span");
favFilterStar.setAttribute("aria-hidden", "true");
favFilterStar.textContent = "★";
favFilterBtn.append(favFilterStar, " Favourites only");

// Hint shown in place of the grid when the filter is on but nothing is starred.
const favEmptyState = document.createElement("p");
favEmptyState.className = "cards-empty";
favEmptyState.hidden = true;
favEmptyState.textContent = "No favourites yet — tap ☆ on a tool to pin it here.";

if (cardsSection) {
  const toolbar = document.createElement("div");
  toolbar.className = "cards-toolbar";
  toolbar.appendChild(favFilterBtn);
  cardsSection.before(toolbar);
  cardsSection.after(favEmptyState);
  cardsSection.classList.add("has-toolbar");
}

/** Hide non-favourites when the filter is on; show the hint if none remain. */
function applyFilter() {
  const favOnly = readFavOnly();
  const favorites = new Set(readFavorites());
  for (const card of originalCards) {
    card.classList.toggle("card--hidden", favOnly && !favorites.has(card.dataset.tool));
  }
  const hasFavorites = originalCards.some((card) => favorites.has(card.dataset.tool));
  favEmptyState.hidden = !(favOnly && !hasFavorites);
  favFilterBtn.classList.toggle("is-active", favOnly);
  favFilterBtn.setAttribute("aria-pressed", String(favOnly));
}

favFilterBtn.addEventListener("click", () => {
  const favOnly = !readFavOnly();
  writeFavOnly(favOnly);
  applyFilter();
  showToast(favOnly ? "Showing favourites only" : "Showing all tools");
});

applyFilter();

/* ---------------------------- command palette ---------------------------- */

registerCommands([
  {
    icon: "★",
    title: "Toggle favourites-only filter",
    hint: "action",
    keywords: ["favourites", "favorites", "filter", "star"],
    run: () => favFilterBtn.click(),
  },
  {
    icon: "💬",
    title: "Copy Slack share message",
    hint: "action",
    keywords: ["share", "slack"],
    run: shareToSlack,
  },
]);
