// meso.utilities — the hub's guided tour: dialog, rendering and keyboard. The
// content and the step arithmetic live in tour.mjs (and are covered by the
// parity tests); this module owns the overlay DOM, exactly as palette.js does
// for the command palette.
//
// The stage reads the hub's own cards for everything visual — title, colour
// class, tags, href and the illustration itself, which is cloned out of the
// card — so the two can never drift. Only the prose is new.
import { TOOL_ICONS } from "./palette.js";
import { buildSteps, clampIndex, SEEN_KEY, SEEN_VERSION } from "./tour.mjs";

/**
 * Off-site? Decided from the card's own href rather than a `target` attribute,
 * which the hub's hosted card doesn't carry (it opens Poker in the same tab).
 * The tour's link does open a new tab: losing your place in the tour to a
 * hosted app you then have to come back from is the worse of the two.
 */
function isExternal(href) {
  try {
    return new URL(href, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

/** Read the descriptors `buildSteps` wants out of the hub's card elements. */
function describe(cards) {
  return cards.map((card) => {
    const href = card.getAttribute("href") ?? "";
    return {
      id: card.dataset.tool ?? "",
      title: card.querySelector("h2")?.textContent?.trim() ?? "",
      // The card's accent class is what carries the --card-* palette; the stage
      // wears the same one, which is what makes the tint follow the tool.
      color: [...card.classList].find((name) => name.startsWith("card--")) ?? "",
      href,
      tags: [...card.querySelectorAll(".card-meta .tag")].map((tag) =>
        tag.textContent?.trim() ?? ""
      ),
      external: isExternal(href),
      art: card.querySelector(".card-art"),
    };
  });
}

/**
 * Wire the tour for a hub page. `cards` are the tool cards in their *authored*
 * order (not the user's, and not filtered) — a dragged grid or the favourites
 * filter must not reorder or skip the tour. `onClose` is handed the step the
 * user left off on, so the hub can hand attention back to that card.
 */
export function initTour({ cards, onClose }) {
  const described = describe(cards);
  const steps = buildSteps(described);
  const artOf = new Map(described.map((card) => [card.id, card.art]));

  let index = 0;
  /** Built on first open, like the palette's overlay — the hub's first paint is unchanged. */
  let els;

  function markSeen() {
    try {
      localStorage.setItem(SEEN_KEY, SEEN_VERSION);
    } catch {
      /* storage may be unavailable; the tour just offers itself again */
    }
  }

  function build() {
    if (els) return els;

    const dialog = document.createElement("dialog");
    dialog.className = "tour";
    dialog.setAttribute("aria-labelledby", "tour-title");

    const glow = document.createElement("div");
    glow.className = "tour-glow";
    glow.setAttribute("aria-hidden", "true");

    const top = document.createElement("header");
    top.className = "tour-top";
    const eyebrow = document.createElement("span");
    eyebrow.className = "tour-eyebrow";
    eyebrow.innerHTML = '<span class="dot" aria-hidden="true"></span>';
    eyebrow.append("Take a tour");
    const rail = document.createElement("div");
    rail.className = "tour-rail";
    rail.setAttribute("role", "group");
    rail.setAttribute("aria-label", "Tour steps");
    const count = document.createElement("span");
    count.className = "tour-count";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tour-close";
    close.setAttribute("aria-label", "Close the tour");
    close.textContent = "✕";
    top.append(eyebrow, rail, count, close);

    const body = document.createElement("div");
    body.className = "tour-body";
    const art = document.createElement("aside");
    art.className = "tour-art";
    const copy = document.createElement("section");
    copy.className = "tour-copy";
    copy.tabIndex = -1;
    body.append(art, copy);

    const foot = document.createElement("footer");
    foot.className = "tour-foot";
    const keys = document.createElement("div");
    keys.className = "tour-keys";
    keys.innerHTML = "<kbd>←</kbd> <kbd>→</kbd> to move · <kbd>Esc</kbd> to close";
    const actions = document.createElement("div");
    actions.className = "tour-actions";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn btn-ghost";
    skip.textContent = "Skip tour";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn";
    back.textContent = "← Back";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "btn btn-primary tour-next";
    actions.append(skip, back, next);
    foot.append(keys, actions);

    dialog.append(glow, top, body, foot);
    document.body.appendChild(dialog);

    els = { dialog, rail, count, art, copy, skip, back, next };

    close.addEventListener("click", () => end());
    skip.addEventListener("click", () => end());
    back.addEventListener("click", () => go(index - 1, "back"));
    next.addEventListener("click", () => {
      if (index === steps.length - 1) end();
      else go(index + 1, "fwd");
    });
    rail.addEventListener("click", (event) => {
      const seg = /** @type {HTMLElement | null} */ (event.target)?.closest(".tour-seg");
      if (seg instanceof HTMLElement && seg.dataset.index !== undefined) {
        go(Number(seg.dataset.index));
      }
    });
    dialog.addEventListener("keydown", onKeyDown);
    // mousedown (not click) so a drag that ends on the backdrop can't close it,
    // matching the command palette.
    dialog.addEventListener("mousedown", (event) => {
      if (event.target === dialog) end();
    });
    // Esc closes a <dialog> natively; go through the same exit either way.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      end();
    });
    return els;
  }

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const steps_ = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: steps.length - 1 };
    const target = steps_[event.key];
    if (target === undefined) return;
    // Let the arrow keys reach anything that wants them (there is nothing on the
    // stage today, but a future control shouldn't have to fight for them).
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".tour-rail")) return;
    event.preventDefault();
    go(target, target > index ? "fwd" : "back");
  }

  function renderRail() {
    els.rail.replaceChildren(...steps.map((step, i) => {
      const seg = document.createElement("button");
      seg.type = "button";
      // Not a tablist: the stage isn't a tabpanel, and a roving tabindex would
      // fight the dialog's own focus order. Plain buttons, aria-current="step".
      seg.className = "tour-seg" + (i === index ? " is-active" : i < index ? " is-done" : "");
      seg.dataset.index = String(i);
      seg.title = step.title;
      seg.setAttribute("aria-label", `Step ${i + 1}: ${step.title}`);
      if (i === index) seg.setAttribute("aria-current", "step");
      return seg;
    }));
  }

  /** Two digits, so the counter doesn't change width between step 9 and 10. */
  const pad = (n) => String(n).padStart(2, "0");

  function renderArt(step) {
    const source = artOf.get(step.id);
    if (source) {
      const clone = /** @type {HTMLElement} */ (source.cloneNode(true));
      const tags = document.createElement("div");
      tags.className = "tour-art-tags";
      for (const label of step.tags ?? []) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = label;
        tags.append(tag);
      }
      els.art.replaceChildren(clone, tags);
      // Decorative: the copy says everything the drawing does.
      els.art.setAttribute("aria-hidden", "true");
      return;
    }
    // The book-end steps have no card to borrow from: the intro shows the grid
    // it is describing, the outro every tool at once. Both are built from the
    // cards themselves rather than a second set of drawings.
    const recap = document.createElement("div");
    recap.className = "tour-recap";
    for (const card of described) {
      const tile = document.createElement("div");
      tile.className = `tour-recap-tile ${card.color}`;
      // The breadcrumb icon, not a shrunken card illustration: the .card-art
      // part classes are drawn for a 120×96 panel and turn to mud at 18px,
      // whereas .crumb-icon's two fills are built for exactly this size (see
      // the iconography note in CLAUDE.md). Trusted codebase markup, as in
      // palette.js — never user input.
      const icon = TOOL_ICONS[card.id];
      if (icon) {
        const slot = document.createElement("span");
        slot.innerHTML = icon;
        tile.append(...slot.childNodes);
      }
      const name = document.createElement("span");
      name.className = "tour-recap-name";
      name.textContent = card.title;
      tile.appendChild(name);
      recap.append(tile);
    }
    els.art.replaceChildren(recap);
    // Real content — it names every tool — so it stays readable.
    els.art.removeAttribute("aria-hidden");
  }

  function renderCopy(step) {
    const kicker = document.createElement("p");
    kicker.className = "tour-kicker";
    kicker.textContent = step.kicker;

    const title = document.createElement("h2");
    title.id = "tour-title";
    title.textContent = step.title;

    const lede = document.createElement("p");
    lede.className = "tour-lede";
    lede.textContent = step.lede;

    const list = document.createElement("ul");
    list.className = "tour-feats";
    for (const [label, text] of step.features) {
      const item = document.createElement("li");
      const mark = document.createElement("span");
      mark.className = "feat-mark";
      mark.setAttribute("aria-hidden", "true");
      const body = document.createElement("span");
      const strong = document.createElement("b");
      strong.textContent = label;
      const rest = document.createElement("span");
      rest.className = "txt";
      rest.textContent = ` ${text}`;
      body.append(strong, rest);
      item.append(mark, body);
      list.append(item);
    }

    /** @type {HTMLElement[]} */
    const parts = [kicker, title, lede, list];
    if (step.href) {
      const open = document.createElement("a");
      open.className = "tour-open";
      open.href = step.href;
      if (step.external) {
        open.target = "_blank";
        open.rel = "noopener";
      }
      open.textContent = `Open ${step.title} ${step.external ? "↗" : "→"}`;
      parts.push(open);
    }
    els.copy.replaceChildren(...parts);
    els.copy.scrollTop = 0;
  }

  function render(direction) {
    const step = steps[index];
    els.dialog.className = `tour ${step.color} dir-${direction}`;
    // Force the entry animations to restart on every step.
    void els.dialog.offsetWidth;
    renderArt(step);
    renderCopy(step);
    els.count.textContent = `${pad(index + 1)} / ${pad(steps.length)}`;
    els.back.disabled = index === 0;
    const last = index === steps.length - 1;
    els.next.textContent = last ? "Done" : "Continue →";
    els.skip.hidden = last;
    renderRail();
  }

  function go(to, direction) {
    const target = clampIndex(to, steps.length);
    if (target === index) return;
    const dir = direction ?? (target > index ? "fwd" : "back");
    index = target;
    render(dir);
    // Moving focus to the copy is what makes a screen reader announce the new
    // step; an aria-live region here would double-announce it.
    els.copy.focus();
  }

  function open(at) {
    build();
    index = clampIndex(at ?? 0, steps.length);
    render("fwd");
    els.dialog.showModal();
    els.copy.focus();
    markSeen();
  }

  function end() {
    if (!els?.dialog.open) return;
    els.dialog.close();
    markSeen();
    onClose?.(steps[index]);
  }

  return { open };
}
