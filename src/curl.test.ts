/**
 * Tests for curl import. The strongest property is the roundtrip: whatever
 * `buildCurlCommand` (the existing exporter) produces, `parseCurlCommand`
 * must read back into the same request. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { parseCurlCommand, tokenizeShell } from "../static/rest/curl.mjs";
import { buildCurlCommand } from "../static/rest/rest.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

Deno.test("tokenizeShell: quotes, escapes and line continuations", () => {
  assertEquals(tokenizeShell(`a 'b c' "d \\"e\\"" f\\ g`), {
    tokens: ["a", "b c", 'd "e"', "f g"],
  });
  assertEquals(tokenizeShell("curl \\\n  -X POST"), { tokens: ["curl", "-X", "POST"] });
  assertEquals("error" in tokenizeShell("curl 'oops"), true);
});

Deno.test("parseCurlCommand: rejects non-curl input", () => {
  assertEquals(parseCurlCommand("wget https://x").ok, false);
  assertEquals(parseCurlCommand("").ok, false);
});

Deno.test("parseCurlCommand: minimal GET", () => {
  const result = parseCurlCommand("curl https://api.example.com/v1/users");
  assertEquals(result, {
    ok: true,
    request: {
      method: "GET",
      url: "https://api.example.com/v1/users",
      headerText: "",
      auth: { kind: "none", token: "", username: "", password: "" },
      body: "",
    },
    notes: [],
  });
});

Deno.test("parseCurlCommand: data implies POST; multiple -d join with &", () => {
  const result = parseCurlCommand("curl https://x -d a=1 --data-raw b=2");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.request.method, "POST");
  assertEquals(result.request.body, "a=1&b=2");
});

Deno.test("parseCurlCommand: attached short flags (-XPOST) work", () => {
  const result = parseCurlCommand("curl -XPUT https://x -d'{}'");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.request.method, "PUT");
  assertEquals(result.request.body, "{}");
});

Deno.test("parseCurlCommand: Bearer and Basic headers become auth", () => {
  const bearer = parseCurlCommand(
    "curl https://x -H 'Authorization: Bearer tok-123' -H 'Accept: application/json'",
  );
  if (!bearer.ok) throw new Error(bearer.error);
  assertEquals(bearer.request.auth, {
    kind: "bearer",
    token: "tok-123",
    username: "",
    password: "",
  });
  assertEquals(bearer.request.headerText, "Accept: application/json");

  const basic = parseCurlCommand(`curl https://x -H 'Authorization: Basic ${btoa("jara:pw")}'`);
  if (!basic.ok) throw new Error(basic.error);
  assertEquals(basic.request.auth, { kind: "basic", token: "", username: "jara", password: "pw" });
});

Deno.test("parseCurlCommand: -u sets basic auth", () => {
  const result = parseCurlCommand("curl -u jara:s3cret https://x");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.request.auth.kind, "basic");
  assertEquals(result.request.auth.username, "jara");
  assertEquals(result.request.auth.password, "s3cret");
});

Deno.test("parseCurlCommand: --json adds content-type and accept", () => {
  const result = parseCurlCommand(`curl https://x --json '{"a":1}'`);
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.request.body, '{"a":1}');
  assertEquals(result.request.headerText.includes("Content-Type: application/json"), true);
  assertEquals(result.request.headerText.includes("Accept: application/json"), true);
});

Deno.test("parseCurlCommand: -G moves data into the query string", () => {
  const result = parseCurlCommand("curl -G https://x/search -d q=meso -d lang=de");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.request.method, "GET");
  assertEquals(result.request.url, "https://x/search?q=meso&lang=de");
  assertEquals(result.request.body, "");
});

Deno.test("parseCurlCommand: cookies, user-agent, HEAD and notes", () => {
  const result = parseCurlCommand(
    "curl -I -b 'sid=1' -A meso-bot -o out.txt --compressed --retry 3 https://x",
  );
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.request.method, "HEAD");
  assertEquals(result.request.headerText, "Cookie: sid=1\nUser-Agent: meso-bot");
  assertEquals(result.notes.includes("-o ignored"), true);
  assertEquals(result.notes.includes("--retry ignored"), true);

  assertEquals(parseCurlCommand("curl -F a=b https://x").ok, false, "-F is refused");
  const fileBody = parseCurlCommand("curl https://x -d @payload.json");
  if (!fileBody.ok) throw new Error(fileBody.error);
  assertEquals(fileBody.request.body, "");
  assertEquals(fileBody.notes.includes("file body @payload.json was not read"), true);
});

Deno.test("roundtrip: buildCurlCommand output parses back to the same request", () => {
  const request = {
    method: "POST",
    url: "https://api.example.ch/v1/login?x=a b",
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "X-Request-Id", value: "abc-123" },
    ],
    body: '{"user":"jara","note":"it\'s \\"quoted\\""}',
  };
  const command = buildCurlCommand(request);
  const parsed = parseCurlCommand(command);
  if (!parsed.ok) throw new Error(parsed.error);
  assertEquals(parsed.request.method, "POST");
  assertEquals(parsed.request.url, request.url);
  assertEquals(parsed.request.body, request.body);
  assertEquals(
    parsed.request.headerText,
    "Content-Type: application/json\nX-Request-Id: abc-123",
  );
});
