/**
 * Tests for the REST Client's pure logic (header parsing, auth, curl export,
 * URL validation, formatting). Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline; the
 * network-facing fetch lives in the page code and is intentionally untested.
 */
import {
  applyVariableCompletion,
  BODYLESS_METHODS,
  buildAuthHeader,
  buildCurlCommand,
  buildRequestHeaders,
  collectRequestVariables,
  describeSendError,
  filterVariableNames,
  findVariableNames,
  findVariableToken,
  formatBytes,
  formatDuration,
  formatJsonBody,
  hasHeader,
  HEADER_NAME_SUGGESTIONS,
  isJsonContentType,
  isTextualContentType,
  parseHeaderLines,
  resolveRequest,
  serializeHeaderRows,
  shellQuote,
  substituteVariables,
  suggestHeaderValues,
  toVariableMap,
  validateUrl,
} from "../static/rest/rest.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assertContains(haystack: string | undefined, needle: string, msg?: string): void {
  if (haystack === undefined || !haystack.includes(needle)) {
    throw new Error(`${msg ?? "assertContains failed"}\n  needle: ${needle}\n  in: ${haystack}`);
  }
}

/* ---------------------------------- URL ----------------------------------- */

Deno.test("validateUrl: accepts http(s) URLs unchanged", () => {
  const result = validateUrl("https://api.example.com/v1/users?limit=10");
  assertEquals(result, { ok: true, url: "https://api.example.com/v1/users?limit=10" });
});

Deno.test("validateUrl: prepends https:// when the scheme is missing", () => {
  const result = validateUrl("api.example.com/users");
  assertEquals(result, { ok: true, url: "https://api.example.com/users" });
});

Deno.test("validateUrl: rejects empty, invalid and non-http URLs", () => {
  assertEquals(validateUrl("").ok, false);
  assertEquals(validateUrl("   ").ok, false);
  assertEquals(validateUrl("ftp://files.example.com").ok, false);
  assertEquals(validateUrl("http://").ok, false);
});

/* -------------------------------- headers --------------------------------- */

Deno.test("parseHeaderLines: parses Name: value pairs, keeps colons in values", () => {
  const { headers, errors } = parseHeaderLines(
    "Accept: application/json\nX-Time: 12:30:00\n\n# comment\nAuthorization: Bearer a.b.c",
  );
  assertEquals(errors, []);
  assertEquals(headers, [
    { name: "Accept", value: "application/json" },
    { name: "X-Time", value: "12:30:00" },
    { name: "Authorization", value: "Bearer a.b.c" },
  ]);
});

Deno.test("parseHeaderLines: reports malformed lines with their line number", () => {
  const { headers, errors } = parseHeaderLines("Accept: ok\nnot a header\nspaced name: x");
  assertEquals(headers.length, 1);
  assertEquals(errors.length, 2);
  assertContains(errors[0], "line 2");
});

Deno.test("hasHeader: matches case-insensitively", () => {
  const headers = [{ name: "Content-Type", value: "text/plain" }];
  assertEquals(hasHeader(headers, "content-type"), true);
  assertEquals(hasHeader(headers, "Accept"), false);
});

/* ---------------------------------- auth ---------------------------------- */

Deno.test("buildAuthHeader: bearer trims the token, empty token means no header", () => {
  assertEquals(buildAuthHeader({ kind: "bearer", token: "  abc  " }), {
    name: "Authorization",
    value: "Bearer abc",
  });
  assertEquals(buildAuthHeader({ kind: "bearer", token: "  " }), undefined);
  assertEquals(buildAuthHeader({ kind: "none" }), undefined);
  assertEquals(buildAuthHeader(undefined), undefined);
});

Deno.test("buildAuthHeader: basic base64-encodes user:pass (unicode-safe)", () => {
  assertEquals(buildAuthHeader({ kind: "basic", username: "user", password: "pass" }), {
    name: "Authorization",
    value: "Basic dXNlcjpwYXNz",
  });
  const unicode = buildAuthHeader({ kind: "basic", username: "jöra", password: "gehe1m" });
  assertContains(unicode?.value, "Basic ");
});

Deno.test("buildRequestHeaders: auth helper never overrides an explicit header", () => {
  const result = buildRequestHeaders({
    method: "GET",
    headerText: "Authorization: Bearer explicit",
    auth: { kind: "bearer", token: "helper" },
  });
  assertEquals(result.isAuthApplied, false);
  assertEquals(result.headers, [{ name: "Authorization", value: "Bearer explicit" }]);
});

Deno.test("buildRequestHeaders: JSON body gets Content-Type automatically", () => {
  const result = buildRequestHeaders({ method: "POST", body: '{"a":1}' });
  assertEquals(result.isContentTypeApplied, true);
  assertEquals(result.headers, [{ name: "Content-Type", value: "application/json" }]);
});

Deno.test("buildRequestHeaders: no auto Content-Type for GET, non-JSON or explicit", () => {
  assertEquals(buildRequestHeaders({ method: "GET", body: '{"a":1}' }).isContentTypeApplied, false);
  assertEquals(buildRequestHeaders({ method: "POST", body: "plain" }).isContentTypeApplied, false);
  const explicit = buildRequestHeaders({
    method: "POST",
    body: '{"a":1}',
    headerText: "Content-Type: application/problem+json",
  });
  assertEquals(explicit.isContentTypeApplied, false);
  assertEquals(explicit.headers.length, 1);
});

/* ---------------------------------- curl ---------------------------------- */

Deno.test("shellQuote: single quotes are escaped the POSIX way", () => {
  assertEquals(shellQuote("O'Brien"), `'O'\\''Brien'`);
  assertEquals(shellQuote("plain"), "'plain'");
});

Deno.test("buildCurlCommand: GET omits -X, HEAD uses --head", () => {
  assertEquals(
    buildCurlCommand({ method: "GET", url: "https://x.ch/a", headers: [] }),
    "curl 'https://x.ch/a'",
  );
  assertEquals(
    buildCurlCommand({ method: "HEAD", url: "https://x.ch", headers: [] }),
    "curl --head 'https://x.ch'",
  );
});

Deno.test("buildCurlCommand: POST renders method, headers and raw body", () => {
  const command = buildCurlCommand({
    method: "POST",
    url: "https://api.example.ch/users",
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Authorization", value: "Bearer a'b" },
    ],
    body: '{"name":"O\'Brien"}',
  });
  assertEquals(
    command,
    "curl -X POST 'https://api.example.ch/users' \\\n" +
      "  -H 'Content-Type: application/json' \\\n" +
      `  -H 'Authorization: Bearer a'\\''b' \\\n` +
      `  --data-raw '{"name":"O'\\''Brien"}'`,
  );
});

Deno.test("buildCurlCommand: bodyless methods never emit --data-raw", () => {
  for (const method of BODYLESS_METHODS) {
    const command = buildCurlCommand({
      method,
      url: "https://x.ch",
      headers: [],
      body: '{"ignored":true}',
    });
    assertEquals(command.includes("--data-raw"), false, `body leaked for ${method}`);
  }
});

/* ------------------------------ suggestions -------------------------------- */

Deno.test("suggestHeaderValues: known names suggest values, case-insensitively", () => {
  assertContains(suggestHeaderValues("Accept").join(","), "application/json");
  assertContains(suggestHeaderValues("content-type").join(","), "application/json");
  assertEquals(suggestHeaderValues("X-Totally-Custom"), []);
});

Deno.test("suggestHeaderValues: uuid-style headers get a fresh UUID each call", () => {
  for (const name of ["X-Request-Id", "x-correlation-id", "Idempotency-Key"]) {
    const values = suggestHeaderValues(name);
    assertEquals(values.length, 1, `one suggestion for ${name}`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values[0])) {
      throw new Error(`not a UUID: ${values[0]}`);
    }
  }
  const [first] = suggestHeaderValues("X-Request-Id");
  const [second] = suggestHeaderValues("X-Request-Id");
  assertEquals(first === second, false, "UUIDs should differ per call");
});

Deno.test("HEADER_NAME_SUGGESTIONS: contains the staples", () => {
  for (const name of ["Accept", "Content-Type", "Authorization", "X-Request-Id"]) {
    assertEquals(HEADER_NAME_SUGGESTIONS.includes(name), true, `missing ${name}`);
  }
});

Deno.test("serializeHeaderRows: trims, skips nameless rows, round-trips", () => {
  const text = serializeHeaderRows([
    { name: " Accept ", value: " application/json " },
    { name: "", value: "ignored" },
    { name: "X-Empty", value: "" },
  ]);
  assertEquals(text, "Accept: application/json\nX-Empty: ");
  const { headers, errors } = parseHeaderLines(text);
  assertEquals(errors, []);
  assertEquals(headers, [
    { name: "Accept", value: "application/json" },
    { name: "X-Empty", value: "" },
  ]);
});

/* ------------------------------ environments ------------------------------- */

Deno.test("findVariableNames: unique names in first-use order, whitespace ok", () => {
  assertEquals(findVariableNames("{{baseUrl}}/v1/{{ id }}/x/{{baseUrl}}"), ["baseUrl", "id"]);
  assertEquals(findVariableNames("no placeholders"), []);
  assertEquals(findVariableNames("{{not closed"), []);
});

Deno.test("substituteVariables: replaces known, keeps unknown, case-sensitive", () => {
  const variables = toVariableMap([
    { name: "baseUrl", value: "https://api-uat.example.ch" },
    { name: "id", value: "42" },
  ]);
  assertEquals(
    substituteVariables("{{baseUrl}}/v1/customers/{{ id }}", variables),
    "https://api-uat.example.ch/v1/customers/42",
  );
  assertEquals(substituteVariables("{{BASEURL}}/x", variables), "{{BASEURL}}/x");
  assertEquals(substituteVariables("{{missing}}", variables), "{{missing}}");
});

Deno.test("toVariableMap: trims names, skips blanks, last duplicate wins", () => {
  const map = toVariableMap([
    { name: " token ", value: "a" },
    { name: "", value: "ignored" },
    { name: "token", value: "b" },
  ]);
  assertEquals([...map.entries()], [["token", "b"]]);
});

Deno.test("collectRequestVariables: gathers names across all request parts", () => {
  const names = collectRequestVariables({
    method: "POST",
    url: "{{baseUrl}}/v1/customers",
    headerText: "Authorization: Bearer {{token}}\nX-Tenant-Id: {{tenantId}}",
    auth: { kind: "basic", username: "{{user}}", password: "{{pass}}" },
    body: '{"clientId":"{{clientId}}","again":"{{token}}"}',
  });
  assertEquals(names, ["baseUrl", "token", "tenantId", "user", "pass", "clientId"]);
});

Deno.test("resolveRequest: substitutes everywhere and lists unresolved names", () => {
  const variables = toVariableMap([
    { name: "baseUrl", value: "https://api-uat.example.ch" },
    { name: "token", value: "t0ps3cret" },
  ]);
  const { request, unresolved } = resolveRequest({
    method: "POST",
    url: "{{baseUrl}}/v1/customers",
    headerText: "Authorization: Bearer {{token}}",
    auth: { kind: "bearer", token: "{{token}}" },
    body: '{"clientId":"{{clientId}}"}',
  }, variables);
  assertEquals(request.url, "https://api-uat.example.ch/v1/customers");
  assertEquals(request.headerText, "Authorization: Bearer t0ps3cret");
  assertEquals(request.auth?.token, "t0ps3cret");
  assertEquals(request.body, '{"clientId":"{{clientId}}"}'); // left visible
  assertEquals(unresolved, ["clientId"]);
});

Deno.test("resolveRequest: no variables used means nothing unresolved", () => {
  const { request, unresolved } = resolveRequest(
    { method: "GET", url: "https://api.example.ch/health" },
    new Map(),
  );
  assertEquals(unresolved, []);
  assertEquals(request.url, "https://api.example.ch/health");
});

/* ------------------------------ autocomplete ------------------------------- */

Deno.test("findVariableToken: detects the open token at the caret", () => {
  assertEquals(findVariableToken("GET {{ba", 8), { start: 4, prefix: "ba" });
  assertEquals(findVariableToken("{{a}} {{t", 9), { start: 6, prefix: "t" });
  assertEquals(findVariableToken("{{ spaced", 9), { start: 0, prefix: "spaced" });
  assertEquals(findVariableToken("{{", 2), { start: 0, prefix: "" });
});

Deno.test("findVariableToken: closed tokens and plain text yield nothing", () => {
  assertEquals(findVariableToken("{{a}}", 5), undefined);
  assertEquals(findVariableToken("plain text", 10), undefined);
  assertEquals(findVariableToken("single { brace", 14), undefined);
});

Deno.test("filterVariableNames: case-insensitive prefix, empty matches all", () => {
  const names = ["baseUrl", "token", "tenantId"];
  assertEquals(filterVariableNames(names, "T"), ["token", "tenantId"]);
  assertEquals(filterVariableNames(names, ""), names);
  assertEquals(filterVariableNames(names, "zz"), []);
});

Deno.test("applyVariableCompletion: completes and places the caret after }}", () => {
  const result = applyVariableCompletion("GET {{ba/users", 8, "baseUrl");
  assertEquals(result.text, "GET {{baseUrl}}/users");
  assertEquals(result.caret, 15);
});

Deno.test("applyVariableCompletion: consumes token remainder and closing braces", () => {
  assertEquals(applyVariableCompletion("{{ba}} x", 4, "baseUrl").text, "{{baseUrl}} x");
  assertEquals(applyVariableCompletion("{{barUrl}} x", 4, "baseUrl").text, "{{baseUrl}} x");
  assertEquals(applyVariableCompletion("{{ba rest", 4, "baseUrl").text, "{{baseUrl}} rest");
});

Deno.test("applyVariableCompletion: no open token leaves text untouched", () => {
  assertEquals(applyVariableCompletion("plain", 5, "x"), { text: "plain", caret: 5 });
});

/* --------------------------------- body ----------------------------------- */

Deno.test("formatJsonBody: pretty-prints compact JSON with 2 spaces", () => {
  const result = formatJsonBody('{"a":{"b":[1,2]}}');
  if (!result.ok) throw new Error("expected ok");
  assertEquals(result.text, '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}');
});

Deno.test("formatJsonBody: quoted {{variables}} survive formatting", () => {
  const result = formatJsonBody('{"clientId":"{{clientId}}"}');
  if (!result.ok) throw new Error("expected ok");
  assertContains(result.text, '"clientId": "{{clientId}}"');
});

Deno.test("formatJsonBody: empty and invalid bodies are reported, not changed", () => {
  assertEquals(formatJsonBody("").ok, false);
  assertEquals(formatJsonBody("   ").ok, false);
  const bare = formatJsonBody('{"count": {{n}}}'); // unquoted placeholder
  assertEquals(bare.ok, false);
  if (!bare.ok) assertContains(bare.error, "quotes");
});

/* ------------------------------- responses -------------------------------- */

Deno.test("isTextualContentType: text-ish types render, binary ones don't", () => {
  assertEquals(isTextualContentType("application/json; charset=utf-8"), true);
  assertEquals(isTextualContentType("application/problem+json"), true);
  assertEquals(isTextualContentType("text/html"), true);
  assertEquals(isTextualContentType(""), true);
  assertEquals(isTextualContentType("application/pdf"), false);
  assertEquals(isTextualContentType("image/png"), false);
  assertEquals(isTextualContentType("application/octet-stream"), false);
});

Deno.test("isJsonContentType: spots json variants", () => {
  assertEquals(isJsonContentType("application/json"), true);
  assertEquals(isJsonContentType("application/vnd.github+json"), true);
  assertEquals(isJsonContentType("text/html"), false);
});

Deno.test("describeSendError: aborts, CORS-ish TypeErrors and plain errors", () => {
  const abort = new DOMException("The user aborted a request.", "AbortError");
  assertEquals(describeSendError(abort), "Request aborted.");
  assertContains(describeSendError(new TypeError("Failed to fetch")), "CORS");
  assertEquals(describeSendError(new Error("boom")), "boom");
  assertEquals(describeSendError("odd"), "odd");
});

Deno.test("formatDuration / formatBytes: friendly units", () => {
  assertEquals(formatDuration(845.4), "845 ms");
  assertEquals(formatDuration(1240), "1.24 s");
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(1331), "1.3 KB");
  assertEquals(formatBytes(2_516_582), "2.4 MB");
});
