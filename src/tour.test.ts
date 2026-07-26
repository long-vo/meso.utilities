/**
 * Parity tests for the hub's guided tour (static/tour.mjs) — the same module the
 * browser imports, so what's asserted here is what ships. The dialog, the card
 * cloning and the keyboard wiring live in tour.js and are exercised in the
 * browser only. Dependency-free (no remote std import) so it runs offline, like
 * its siblings.
 *
 * The first test is the one that earns its keep: it reads the hub page itself
 * and fails when a card has no tour content (or content has no card), so adding
 * a tool cannot quietly skip the tour.
 */
import {
  buildSteps,
  clampIndex,
  INTRO,
  OUTRO,
  SEEN_KEY,
  SEEN_VERSION,
  shouldNudge,
  TOUR_CONTENT,
} from "../static/tour.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

/** The `data-tool` ids of the cards on the hub, in authored order. */
async function hubToolIds(): Promise<string[]> {
  const html = await Deno.readTextFile(new URL("../static/index.html", import.meta.url));
  return [...html.matchAll(/class="card [^"]*"\s+data-tool="([^"]+)"/g)].map((m) => m[1]);
}

/** Card descriptors of the shape `tour.js` reads off the hub. */
function cards(ids: string[]) {
  return ids.map((id) => ({
    id,
    title: id,
    color: `card--${id}`,
    href: `${id}/`,
    tags: ["tag"],
    external: id === "poker",
  }));
}

Deno.test("every hub card has tour content, and vice versa", async () => {
  const onHub = await hubToolIds();
  assert(onHub.length > 0, "found no cards in static/index.html — did the markup change?");
  const missing = onHub.filter((id) => !(id in TOUR_CONTENT));
  const orphaned = Object.keys(TOUR_CONTENT).filter((id) => !onHub.includes(id));
  assertEquals(missing, [], "hub cards with no TOUR_CONTENT entry");
  assertEquals(orphaned, [], "TOUR_CONTENT entries with no hub card");
});

Deno.test("SEEN_KEY is the documented localStorage key", () => {
  assertEquals(SEEN_KEY, "meso-tour-seen");
});

Deno.test("shouldNudge: only a flag from this exact version counts as seen", () => {
  assertEquals(shouldNudge(null), true, "never seen");
  assertEquals(shouldNudge(undefined), true, "storage unavailable");
  assertEquals(shouldNudge(""), true, "empty value");
  assertEquals(shouldNudge(SEEN_VERSION), false, "seen this version");
  assertEquals(shouldNudge("0"), true, "seen an older version — nudge again");
});

Deno.test("buildSteps: intro first, outro last, tools in the order given", () => {
  const steps = buildSteps(cards(["decode", "sanitize", "poker"]));
  assertEquals(steps.map((s) => s.id), ["intro", "decode", "sanitize", "poker", "outro"]);
  assertEquals(steps[0], INTRO);
  assertEquals(steps[steps.length - 1], OUTRO);
});

Deno.test("buildSteps: numbers the tool steps and names the hosted one", () => {
  const steps = buildSteps(cards(["sanitize", "poker"]));
  assertEquals(steps[1].kicker, "Tool 1 of 2 · runs in your browser");
  assertEquals(steps[2].kicker, "Tool 2 of 2 · hosted, opens in a new tab");
});

Deno.test("buildSteps: skips a card with no content, and survives no cards at all", () => {
  const steps = buildSteps([...cards(["sanitize"]), { id: "ghost", title: "Ghost" }]);
  assertEquals(steps.map((s) => s.id), ["intro", "sanitize", "outro"]);
  assertEquals(buildSteps([]).map((s) => s.id), ["intro", "outro"]);
  assertEquals(buildSteps(undefined).map((s) => s.id), ["intro", "outro"]);
});

Deno.test("buildSteps: carries the card's own colour, tags and href onto the step", () => {
  const [, step] = buildSteps(cards(["leave"]));
  assertEquals(step.color, "card--leave");
  assertEquals(step.tags, ["tag"]);
  assertEquals(step.href, "leave/");
  assertEquals(step.external, false);
});

Deno.test("clampIndex: holds at both ends", () => {
  assertEquals(clampIndex(-1, 5), 0);
  assertEquals(clampIndex(0, 5), 0);
  assertEquals(clampIndex(4, 5), 4);
  assertEquals(clampIndex(5, 5), 4, "one past the end");
  assertEquals(clampIndex(99, 5), 4, "End key");
  assertEquals(clampIndex(-99, 5), 0, "Home key");
  assertEquals(clampIndex(NaN, 5), 0, "junk index");
  assertEquals(clampIndex(2, 0), 0, "no steps");
});

Deno.test("every step has a title, a kicker, a lede and 3–6 features", () => {
  for (const step of buildSteps(cards(Object.keys(TOUR_CONTENT)))) {
    const where = `step "${step.id}"`;
    assert(step.title.trim().length > 0, `${where}: empty title`);
    assert(step.kicker.trim().length > 0, `${where}: empty kicker`);
    assert(step.lede.trim().length > 20, `${where}: lede too short to be real copy`);
    assert(
      step.features.length >= 3 && step.features.length <= 6,
      `${where}: ${step.features.length} features — expected 3–6`,
    );
  }
});

Deno.test("every feature is a [label, text] pair with a label that ends in a full stop", () => {
  for (const step of buildSteps(cards(Object.keys(TOUR_CONTENT)))) {
    for (const feature of step.features) {
      const where = `step "${step.id}" feature ${JSON.stringify(feature[0])}`;
      assertEquals(feature.length, 2, `${where}: expected [label, text]`);
      const [label, text] = feature;
      assert(label.trim().length > 0, `${where}: empty label`);
      assert(label.trimEnd().endsWith("."), `${where}: label should end in a full stop`);
      assert(text.trim().length > 20, `${where}: text too short to be real copy`);
    }
  }
});

Deno.test("only the hosted tool is external, and it carries an absolute URL", async () => {
  const html = await Deno.readTextFile(new URL("../static/index.html", import.meta.url));
  // The hub's own markup decides which tools are off-site; the tour must agree,
  // because an external step opens in a new tab and the others must not.
  const external = [...html.matchAll(/data-tool="([^"]+)"\s+href="(https?:[^"]+)"/g)]
    .map((m) => m[1]);
  assertEquals(external, ["poker"], "hub cards pointing off-site");
});
