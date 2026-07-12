/**
 * Tests for the cross-tool handoff module. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  buildHandoff,
  HANDOFF_KEY,
  HANDOFF_MAX_AGE_MS,
  parseHandoff,
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
