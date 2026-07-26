/**
 * Tests for the cross-tool handoff module. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  buildHandoff,
  drainUpdates,
  HANDOFF_KEY,
  HANDOFF_MAX_AGE_MS,
  INBOX_KEY,
  parseHandoff,
  queueUpdate,
  sendHandoff,
  takeHandoff,
} from "../static/handoff.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

/** Minimal Storage-like double backed by a Map (sessionStorage stand-in). */
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
}

/** Storage double whose writes always fail, like a full sessionStorage. */
class FullStorage extends FakeStorage {
  override setItem(): void {
    throw new Error("QuotaExceededError");
  }
}

const T0 = 1_750_000_000_000;

Deno.test("buildHandoff: shapes a v1 envelope", () => {
  assertEquals(buildHandoff("rest", "{}", "Decode Anything", T0), {
    v: 1,
    target: "rest",
    from: "Decode Anything",
    text: "{}",
    at: T0,
  });
});

Deno.test("sendHandoff + takeHandoff: round-trips and clears the entry", () => {
  const storage = new FakeStorage();
  assertEquals(sendHandoff(storage, "sanitize", '{"a":1}', "REST Client", T0), true);
  assertEquals(takeHandoff(storage, "sanitize", T0 + 1000), {
    text: '{"a":1}',
    from: "REST Client",
  });
  assertEquals(storage.getItem(HANDOFF_KEY), null, "entry is consumed");
  assertEquals(takeHandoff(storage, "sanitize", T0 + 2000), null, "second take finds nothing");
});

Deno.test("takeHandoff: leaves a fresh entry addressed to another tool", () => {
  const storage = new FakeStorage();
  sendHandoff(storage, "rest", "payload", "Sanitize JSON", T0);
  assertEquals(takeHandoff(storage, "sanitize", T0 + 1000), null);
  assertEquals(storage.size, 1, "entry for the other tool survives");
  assertEquals(takeHandoff(storage, "rest", T0 + 2000)?.text, "payload");
});

Deno.test("takeHandoff: removes stale entries", () => {
  const storage = new FakeStorage();
  sendHandoff(storage, "decode", "payload", "", T0);
  assertEquals(takeHandoff(storage, "decode", T0 + HANDOFF_MAX_AGE_MS + 1), null);
  assertEquals(storage.size, 0, "stale entry is cleaned up");
});

Deno.test("takeHandoff: removes corrupt entries", () => {
  const storage = new FakeStorage();
  storage.setItem(HANDOFF_KEY, "not json {");
  assertEquals(takeHandoff(storage, "decode", T0), null);
  assertEquals(storage.size, 0, "corrupt entry is cleaned up");
});

Deno.test("parseHandoff: accepts an entry exactly at the max age", () => {
  const raw = JSON.stringify(buildHandoff("rest", "x", "", T0));
  assertEquals(parseHandoff(raw, "rest", T0 + HANDOFF_MAX_AGE_MS), { text: "x", from: "" });
});

Deno.test("parseHandoff: rejects wrong target, bad shapes and future timestamps", () => {
  const raw = JSON.stringify(buildHandoff("rest", "x", "", T0));
  assertEquals(parseHandoff(raw, "sanitize", T0), null, "wrong target");
  assertEquals(parseHandoff("", "rest", T0), null, "empty raw");
  assertEquals(parseHandoff("null", "rest", T0), null, "null entry");
  assertEquals(parseHandoff('{"v":2,"target":"rest","text":"x","at":1}', "rest", T0), null, "v2");
  assertEquals(
    parseHandoff(JSON.stringify(buildHandoff("rest", "", "", T0)), "rest", T0),
    null,
    "empty text",
  );
  assertEquals(
    parseHandoff(JSON.stringify(buildHandoff("rest", "x", "", T0 + 120_000)), "rest", T0),
    null,
    "written 2 min in the future",
  );
});

Deno.test("sendHandoff: reports failure when storage is full or unavailable", () => {
  assertEquals(sendHandoff(new FullStorage(), "rest", "x"), false);
});

Deno.test("queueUpdate / drainUpdates: a durable, per-target queue", () => {
  const storage = new FakeStorage();
  assertEquals(drainUpdates(storage, "availability"), [], "nothing queued yet");

  assertEquals(queueUpdate(storage, "availability", { from: "2026-07-27" }, "Leave", T0), true);
  // Saving twice before the target opens must keep both changes.
  assertEquals(queueUpdate(storage, "availability", { from: "2026-08-03" }, "Leave", T0 + 1), true);
  queueUpdate(storage, "shortlink", { url: "x" }, "Leave", T0 + 2);

  const drained = drainUpdates(storage, "availability");
  assertEquals(drained, [
    { data: { from: "2026-07-27" }, from: "Leave", at: T0 },
    { data: { from: "2026-08-03" }, from: "Leave", at: T0 + 1 },
  ], "oldest first");
  assertEquals(drainUpdates(storage, "availability"), [], "draining removes what it returned");
  assertEquals(
    drainUpdates(storage, "shortlink"),
    [{ data: { url: "x" }, from: "Leave", at: T0 + 2 }],
    "another tool's queue is left alone",
  );
  assertEquals(storage.getItem(INBOX_KEY), null, "an emptied queue leaves no key behind");
});

Deno.test("queueUpdate / drainUpdates: age never expires an entry", () => {
  const storage = new FakeStorage();
  queueUpdate(storage, "availability", { from: "2026-07-27" }, "Leave", T0);
  // A handoff this old would be refused (HANDOFF_MAX_AGE_MS); a queued change
  // carries no expiry at all — it waits for however long the detour takes.
  assertEquals(HANDOFF_MAX_AGE_MS > 0, true, "the handoff path does expire");
  assertEquals(drainUpdates(storage, "availability").length, 1, "the queue does not");
});

Deno.test("drainUpdates: survives a corrupt or foreign queue", () => {
  const storage = new FakeStorage();
  storage.setItem(INBOX_KEY, "not json");
  assertEquals(drainUpdates(storage, "availability"), [], "garbage reads as empty");
  storage.setItem(INBOX_KEY, JSON.stringify({ v: 1, target: "availability" }));
  assertEquals(drainUpdates(storage, "availability"), [], "an object, not a queue");
  storage.setItem(
    INBOX_KEY,
    JSON.stringify([{ v: 2, target: "availability" }, { target: "availability" }, null]),
  );
  assertEquals(drainUpdates(storage, "availability"), [], "entries from another version");
});

Deno.test("queueUpdate: reports a storage that cannot take it", () => {
  assertEquals(queueUpdate(new FullStorage(), "availability", {}, "Leave", T0), false);
});
