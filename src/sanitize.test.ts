/**
 * Parity tests: assert the ported logic masks exactly like the original
 * `/sanitize-text` Slack command. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { findBalancedEnd, maskString, runSanitize, runSanitizeLog, sanitize } from "../static/sanitize.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function fieldSet(...names: string[]): Set<string> {
  return new Set(names.map((n) => n.toLowerCase()));
}

Deno.test("maskString: keepLast <= 0 masks the whole string", () => {
  assertEquals(maskString("hello", 0), "*****");
  assertEquals(maskString("hello", -3), "*****");
});

Deno.test("maskString: short secret (len <= keepLast) is fully masked", () => {
  assertEquals(maskString("ab", 4), "**");
  assertEquals(maskString("1234", 4), "****");
});

Deno.test("maskString: reveals only the last N characters", () => {
  assertEquals(maskString("secret123", 4), "*****t123");
  assertEquals(maskString("weber", 2), "***er");
});

Deno.test("sanitize: matches keys case-insensitively at any depth", () => {
  const input = {
    person: { LastName: "Weber", first: "Jara" },
    contacts: [{ email: "a@b.com" }, { email: "c@d.com" }],
  };
  const out = sanitize(input, fieldSet("lastname", "email"), 2);
  assertEquals(out, {
    person: { LastName: "***er", first: "Jara" },
    contacts: [{ email: "*****om" }, { email: "*****om" }],
  });
});

Deno.test("sanitize: numbers are masked as strings", () => {
  const out = sanitize({ pin: 12345 }, fieldSet("pin"), 2);
  assertEquals(out, { pin: "***45" });
});

Deno.test("sanitize: booleans and null under a matched key pass through", () => {
  const out = sanitize({ active: true, deleted: null }, fieldSet("active", "deleted"), 0);
  assertEquals(out, { active: true, deleted: null });
});

Deno.test("sanitize: a matched container masks every leaf inside it", () => {
  const out = sanitize(
    { user: { email: "a@b.com", name: "X", age: 40, ok: true } },
    fieldSet("user"),
    0,
  );
  assertEquals(out, { user: { email: "*******", name: "*", age: "**", ok: true } });
});

Deno.test("sanitize: arrays under a matched key are masked element-wise", () => {
  const out = sanitize({ tokens: ["abcd", "efgh"] }, fieldSet("tokens"), 0);
  assertEquals(out, { tokens: ["****", "****"] });
});

Deno.test("runSanitize: parses free-form fields and reports stats", () => {
  const result = runSanitize(
    '{"a":{"email":"a@b.com"},"b":{"email":"c@d.com"},"x":1}',
    "email, missingField",
    4,
  );
  if (!result.ok) throw new Error("expected ok result");
  assertEquals(result.stats.maskedValues, 2);
  assertEquals(result.stats.matchedKeys, ["email"]);
  assertEquals(result.stats.fieldCount, 2);
  assertEquals(result.fields, ["email", "missingField"]);
});

Deno.test("runSanitize: invalid JSON returns a failure with a message", () => {
  const result = runSanitize("{ not json", "email", 4);
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  if (typeof result.error !== "string" || result.error.length === 0) {
    throw new Error("expected a non-empty error message");
  }
});

Deno.test("runSanitize: array field list is accepted", () => {
  const result = runSanitize('{"email":"a@b.com"}', ["email"], 0);
  if (!result.ok) throw new Error("expected ok result");
  assertEquals(result.sanitized, { email: "*******" });
});

Deno.test("findBalancedEnd: ignores braces inside string literals", () => {
  const s = 'x={"a":"}{","b":1}y';
  const end = findBalancedEnd(s, 2);
  assertEquals(s.slice(2, end), '{"a":"}{","b":1}');
});

Deno.test("maskLog: masks every value in an embedded JSON block, keeps prose", () => {
  const line = 'INFO Sending request={"logonId":"L006344","tenantId":8334} done';
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: true });
  assertEquals(r.text, 'INFO Sending request={"logonId":"*******","tenantId":"****"} done');
  assertEquals(r.stats.blocks, 1);
  assertEquals(r.stats.maskedValues, 2);
});

Deno.test("maskLog: keepLast reveals the tail of each value", () => {
  const r = runSanitizeLog('req={"iban":"CH9300762011","id":42}', { keepLast: 4, maskAll: true });
  assertEquals(r.text, 'req={"iban":"********2011","id":"**"}');
});

Deno.test("maskLog: non-JSON braces are left untouched", () => {
  const line = "2026-07-02 [-][-][-] INFO 7 --- [baloise-e-portal-api] no json here";
  const r = runSanitizeLog(line, { maskAll: true });
  assertEquals(r.text, line);
  assertEquals(r.stats.blocks, 0);
});

Deno.test("maskLog: handles multiple blocks and nested objects", () => {
  const line = 'a={"x":{"y":"secret"}} b={"z":"top"}';
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: true });
  assertEquals(r.text, 'a={"x":{"y":"******"}} b={"z":"***"}');
  assertEquals(r.stats.blocks, 2);
  assertEquals(r.stats.maskedValues, 2);
});

Deno.test("maskLog: field-list mode masks only matching keys inside blocks", () => {
  const line = 'msg={"email":"a@b.com","name":"Jara"}';
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: false, fields: "email" });
  assertEquals(r.text, 'msg={"email":"*******","name":"Jara"}');
  assertEquals(r.stats.maskedValues, 1);
});

Deno.test("maskLog: braces inside a string value do not break parsing", () => {
  const line = 'x={"note":"a } b { c","n":1}';
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: true });
  assertEquals(r.text, 'x={"note":"*********","n":"*"}');
});

Deno.test("maskLog: masks values in a Java toString map ({key=value})", () => {
  const line = "[INFO]{application=baloise-id, client=172.31.138.81, request=, requestId=15317}";
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: true, redact: false });
  assertEquals(r.stats.mapBlocks, 1);
  assertEquals(r.text.includes("baloise-id"), false);
  assertEquals(r.text.includes("172.31.138.81"), false);
  assertEquals(r.text.includes("15317"), false);
  assertEquals(r.text.includes("application="), true); // keys preserved
  assertEquals(r.text.includes("request=,"), true); // empty value left as-is
});

Deno.test("maskLog: masks Java object-dump field values, keeps openers and null", () => {
  const dump = [
    "class Req {",
    "    id: a0884b97-24df-4eaf-9077-d9f6b43629ee",
    "    language: null",
    "    signers: [class S {",
    "        signerId: adb63f07-6e74-4769-a18a-6d0bcebb3074",
    "    }]",
    "}",
  ].join("\n");
  const r = runSanitizeLog(dump, { keepLast: 0, maskAll: true, redact: false });
  assertEquals(r.text.includes("a0884b97-24df-4eaf-9077-d9f6b43629ee"), false);
  assertEquals(r.text.includes("adb63f07-6e74-4769-a18a-6d0bcebb3074"), false);
  assertEquals(r.text.includes("language: null"), true); // null preserved
  assertEquals(r.text.includes("signers: [class S {"), true); // opener preserved
});

Deno.test("redact: masks UUIDs, IPs and emails anywhere in the text", () => {
  const line = "user a@b.com from 10.0.0.5 id 550e8400-e29b-41d4-a716-446655440000";
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: true, redact: true });
  assertEquals(r.text.includes("a@b.com"), false);
  assertEquals(r.text.includes("10.0.0.5"), false);
  assertEquals(r.text.includes("550e8400-e29b-41d4-a716-446655440000"), false);
  assertEquals(r.stats.patternHits, 3);
});

Deno.test("maskLog: redact is opt-in — loose IDs in plain lines are kept by default", () => {
  const line = "INFO DossierService : dossierId=12345678-1234-1234-1234-1234567890ab";
  const kept = runSanitizeLog(line, { keepLast: 4, maskAll: true }); // redact defaults off
  assertEquals(kept.text, line);
  assertEquals(kept.stats.patternHits, 0);

  const redacted = runSanitizeLog(line, { keepLast: 4, maskAll: true, redact: true });
  assertEquals(redacted.text.includes("12345678-1234"), false);
  assertEquals(redacted.stats.patternHits, 1);
});

Deno.test("redact: leaves timestamps and short version numbers intact", () => {
  const line = "2026-07-10 04:12:39.550 Spring Boot (v4.0.7) ready";
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: true, redact: true });
  assertEquals(r.text, line);
  assertEquals(r.stats.patternHits, 0);
});

Deno.test("maskLog: field mode masks listed keys; redact still nukes UUIDs", () => {
  const dump = [
    "class R {",
    "    tenantId: f346611c-6a34-4c32-b7d0-759f8299f8c4",
    "    extApplication: GOB_DEV",
    "}",
  ].join("\n");
  const r = runSanitizeLog(dump, {
    keepLast: 0,
    maskAll: false,
    fields: "extApplication",
    redact: true,
  });
  assertEquals(r.text.includes("GOB_DEV"), false); // masked by field-list pass
  assertEquals(r.text.includes("f346611c-6a34-4c32-b7d0-759f8299f8c4"), false); // redacted by pattern pass
});
