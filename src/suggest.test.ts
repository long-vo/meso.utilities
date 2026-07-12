/**
 * Tests for the sensitive-field suggester of the Sanitize JSON tool. Run with
 * `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { suggestSensitiveFields } from "../static/suggest.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function names(root: unknown, existing: string[] = []): string[] {
  return suggestSensitiveFields(root, existing).map((s: { name: string }) => s.name);
}

Deno.test("suggest: sensitive key names are suggested with a reason", () => {
  const result = suggestSensitiveFields({ password: "hunter2", note: "hi" });
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "password");
  assertEquals(result[0].reason.includes("secret"), true);
});

Deno.test("suggest: fields already listed are excluded, case-insensitively", () => {
  assertEquals(names({ Password: "x" }, ["PASSWORD"]), []);
});

Deno.test("suggest: keys whose values can never be masked are skipped", () => {
  // Booleans and nulls are left untouched by masking, so suggesting them
  // would be noise.
  assertEquals(names({ passwordSet: true, secretRef: null }), []);
});

Deno.test("suggest: value shapes — email, IBAN, JWT, card, phone, token", () => {
  const root = {
    contact: "jara.weber@example.com",
    account: "CH93 0076 2011 6238 5295 7",
    assertion: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJMMDA2MzQ0In0.sig",
    pan: "4111 1111 1111 1111",
    reach: "+41 79 123 45 67",
    key: "sk_live_9f8b7c6d5e4f3a2b1c0d",
  };
  const result = suggestSensitiveFields(root);
  assertEquals(names(root).length, 6);
  const reasonOf = (name: string) =>
    (result as { name: string; reason: string }[]).find((s) => s.name === name)?.reason ?? "";
  assertEquals(reasonOf("contact").includes("email"), true);
  assertEquals(reasonOf("account").includes("IBAN"), true);
  assertEquals(reasonOf("assertion").includes("JWT"), true);
  assertEquals(reasonOf("pan").includes("card"), true);
  assertEquals(reasonOf("reach").includes("phone"), true);
  assertEquals(reasonOf("key").includes("token"), true);
});

Deno.test("suggest: UUIDs and plain values are not token-shaped", () => {
  assertEquals(
    names({
      dossier: "a0884b97-24df-4eaf-9077-d9f6b43629ee",
      status: "VERIFICATION_CONFIRMED",
      zip: "3000",
      balance: 15230.75,
      city: "Bern",
    }),
    [],
  );
});

Deno.test("suggest: walks nested objects and arrays, deduplicates keys", () => {
  const root = {
    customers: [
      { profile: { firstName: "Jara" } },
      { profile: { firstName: "Nils" } },
    ],
  };
  assertEquals(names(root), ["firstName"]);
});

Deno.test("suggest: honours the limit", () => {
  const root = {
    email: "a@b.co",
    phone: "+41 79 123 45 67",
    iban: "x",
    token: "x",
    password: "x",
    firstName: "x",
    lastName: "x",
    passport: "x",
    ssn: "x",
  };
  assertEquals(suggestSensitiveFields(root, [], 3).length, 3);
});

Deno.test("suggest: the bundled example suggests exactly firstName", () => {
  // With the example's mask list applied, the one sensible leftover is
  // firstName (city/zip/balance/verified must stay quiet).
  const example = {
    customer: {
      firstName: "Jara",
      lastName: "Weber",
      email: "jara.weber@example.com",
      phoneNumber: "+41 79 123 45 67",
      verified: true,
      addresses: [{ type: "home", city: "Bern", zip: "3000" }],
    },
    account: {
      iban: "CH93 0076 2011 6238 5295 7",
      balance: 15230.75,
      token: "sk_live_9f8b7c6d5e4f3a2b1c0d",
    },
    auditTrail: [{ actor: "system", email: "ops@example.com" }],
  };
  assertEquals(names(example, ["lastName", "email", "phoneNumber", "token", "iban"]), [
    "firstName",
  ]);
});
