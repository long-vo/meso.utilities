/**
 * Parity tests: assert the ported logic masks exactly like the original
 * `/sanitize-text` Slack command. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  collectLogFields,
  findBalancedEnd,
  maskString,
  runSanitize,
  runSanitizeLog,
  sanitize,
} from "../static/sanitize.mjs";

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

Deno.test("maskLog: a pretty-printed block stays pretty-printed, line for line", () => {
  const log = [
    "12:00 INFO body={",
    '  "customer": {',
    '    "lastName": "Weber"',
    "  }",
    "}",
    "12:01 INFO done",
  ].join("\n");
  const r = runSanitizeLog(log, { keepLast: 0, maskAll: true });
  assertEquals(r.text.split("\n").length, log.split("\n").length);
  assertEquals(r.text.split("\n")[2], '    "lastName": "*****"');
  // Preserving the line count is what keeps the Diff view's positional pairing
  // honest — collapsing the block would mis-pair every line after it.
  assertEquals(r.text.split("\n")[5], "12:01 INFO done");
});

Deno.test("maskLog: a multi-line block is re-emitted at its own indent", () => {
  const log = ["    body={", '      "a": "secret"', "    }"].join("\n");
  const r = runSanitizeLog(log, { keepLast: 0, maskAll: true });
  assertEquals(r.text, ["    body={", '      "a": "******"', "    }"].join("\n"));
});

Deno.test("maskLog: a single-line block is still emitted on a single line", () => {
  const log = '12:00 INFO body={"a":"secret"}\n12:01 INFO done';
  const r = runSanitizeLog(log, { keepLast: 0, maskAll: true });
  assertEquals(r.text, '12:00 INFO body={"a":"******"}\n12:01 INFO done');
});

Deno.test("maskLog: field-list mode masks only matching keys inside blocks", () => {
  const line = 'msg={"email":"a@b.com","name":"Jara"}';
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: false, fields: "email" });
  assertEquals(r.text, 'msg={"email":"*******","name":"Jara"}');
  assertEquals(r.stats.maskedValues, 1);
});

// The UI tints a field chip by whether the field actually matched, so log mode
// has to report matched keys the way the JSON path does — otherwise every chip
// renders untinted and "you asked for a field this log never had" is invisible.
Deno.test("maskLog: matchedKeys names the fields that hit, inside a JSON block", () => {
  const line = 'msg={"email":"a@b.com","name":"Jara"}';
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: false, fields: "email, absent" });
  assertEquals(r.stats.matchedKeys, ["email"]);
});

Deno.test("maskLog: matchedKeys covers a Java map key", () => {
  const line = "[INFO]{application=baloise-id, client=172.31.138.81}";
  const r = runSanitizeLog(line, { keepLast: 0, maskAll: false, fields: "client, absent" });
  assertEquals(r.stats.matchedKeys, ["client"]);
  assertEquals(r.text.includes("baloise-id"), true); // untargeted key left alone
});

Deno.test("maskLog: matchedKeys covers a Java object-dump field line", () => {
  const log = ["class Foo {", "    tenantId: abc-123", "    status: OK", "}"].join("\n");
  const r = runSanitizeLog(log, { keepLast: 0, maskAll: false, fields: "tenantId, absent" });
  assertEquals(r.stats.matchedKeys, ["tenantId"]);
  assertEquals(r.text.includes("OK"), true);
});

Deno.test("maskLog: matchedKeys is empty when no field matches", () => {
  const r = runSanitizeLog('msg={"name":"Jara"}', {
    keepLast: 0,
    maskAll: false,
    fields: "email",
  });
  assertEquals(r.stats.matchedKeys, []);
});

// collectLogFields feeds log-mode's "Suggested fields". It must see exactly the
// shapes the masker can mask, or a suggestion would name a field masking cannot
// reach. Last element is always the flat-key object; JSON blocks come first.
Deno.test("collectLogFields: a JSON block is handed over whole, to be walked", () => {
  const got = collectLogFields('12:00 INFO req={"reqCtx":{"logonId":"L006344"},"n":1}');
  assertEquals(got[0], { reqCtx: { logonId: "L006344" }, n: 1 });
  assertEquals(got[got.length - 1], {});
});

Deno.test("collectLogFields: Java map entries land as flat keys", () => {
  const got = collectLogFields("[INFO]{application=baloise-id, client=10.0.0.1, empty=}");
  assertEquals(got[got.length - 1], { application: ["baloise-id"], client: ["10.0.0.1"] });
});

Deno.test("collectLogFields: object-dump lines land as flat keys", () => {
  const log = [
    "class Foo {",
    "    email: jara@example.com",
    "    language: null", // never masked, so never suggested
    "    nested: {",
    "}",
  ].join("\n");
  // The flat keys are the *last* element, as everywhere else here. This dump
  // also holds one balanced pair (`nested: {` … `}`), which parses as an empty
  // block and takes index 0 — it used to find none at all only because an
  // unclosed brace ended the scan.
  const got = collectLogFields(log);
  assertEquals(got[got.length - 1], { email: ["jara@example.com"] });
});

Deno.test("collectLogFields: a JSON block's quoted keys are not also read as dump lines", () => {
  const got = collectLogFields('body={\n  "lastName": "Weber"\n}');
  assertEquals(got[0], { lastName: "Weber" });
  assertEquals(got[got.length - 1], {}, "the quoted key must not double-count as a flat key");
});

Deno.test("collectLogFields: repeated keys keep up to five value samples", () => {
  const log = ["a: 1", "a: 2", "a: 3", "a: 4", "a: 5", "a: 6"].join("\n");
  assertEquals(collectLogFields(log)[0], { a: ["1", "2", "3", "4", "5"] });
});

Deno.test("collectLogFields: distinct flat keys are capped", () => {
  const log = ["k1: a", "k2: b", "k3: c"].join("\n");
  assertEquals(Object.keys(collectLogFields(log, 2)[0] as object), ["k1", "k2"]);
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

/* ---------------- regressions: masking must not stop or under-mask -------- */

Deno.test("maskLog: an unclosed brace does not stop masking the rest of the log", () => {
  // A lone `{` in prose — a parse-error message, a truncated tail — used to
  // abandon the whole scan, shipping every later value in clear.
  const log = [
    "INFO parse error near { unexpected token",
    'INFO payload {"password":"hunter2","iban":"CH9300762011623852957"}',
  ].join("\n");
  const r = runSanitizeLog(log, { keepLast: 0 });
  assertEquals(r.text.includes("hunter2"), false);
  assertEquals(r.text.includes("CH9300762011623852957"), false);
  assertEquals(r.stats.jsonBlocks, 1);
});

Deno.test("maskLog: a Java-map value containing a comma is masked whole", () => {
  // Splitting on a bare ", " cut the value in two and passed the tail through.
  const r = runSanitizeLog("x {user=bob, address=Main St, 5, token=abc123}", { keepLast: 0 });
  assertEquals(r.text, "x {user=***, address=**********, token=******}");
});

Deno.test("maskLog: a block with nothing maskable is left byte-for-byte", () => {
  const log = 'a={\n}\nb={"pw":"secret"}';
  const r = runSanitizeLog(log, { keepLast: 0 });
  assertEquals(r.text, 'a={\n}\nb={"pw":"******"}');
});

Deno.test("sanitize: a __proto__ key keeps its place in the output", () => {
  // Assigning it in the browser invokes the prototype setter and the key — plus
  // everything under it — vanishes from the masked payload. Deno hardens
  // `__proto__`, so this test passes either way; it documents the contract that
  // `setKey` exists to hold, and JSON.parse really does make it an own key.
  const r = runSanitize('{"__proto__":{"password":"secret"},"b":1}', "password", 0);
  assertEquals(r.ok, true);
  if (!r.ok) return;
  const out = JSON.parse(r.pretty);
  assertEquals(Object.keys(out), ["__proto__", "b"]);
  assertEquals(out["__proto__"], { password: "******" });
  assertEquals(r.stats.maskedValues, 1);
});
