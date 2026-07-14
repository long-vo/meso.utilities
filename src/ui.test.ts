/**
 * Parity tests for the shared UI helpers (static/ui.mjs). Covers the pure
 * escape/highlight logic; `makeToast` touches the DOM and is exercised in the
 * browser only. Dependency-free (no remote std import) so it runs offline,
 * like the sibling tests.
 */
import { escapeHtml, highlightJson } from "../static/ui.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

Deno.test("escapeHtml: escapes &, < and >", () => {
  assertEquals(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

Deno.test("escapeHtml: leaves quotes and other text untouched", () => {
  assertEquals(escapeHtml(`"hello" 'world' 100%`), `"hello" 'world' 100%`);
});

Deno.test("highlightJson: classifies a key and a string value", () => {
  assertEquals(
    highlightJson('{"a":"x"}'),
    '{<span class="j-key">"a":</span><span class="j-str">"x"</span>}',
  );
});

Deno.test("highlightJson: number, boolean and null each get their own class", () => {
  assertEquals(
    highlightJson('{"n":12,"b":true,"z":null}'),
    '{<span class="j-key">"n":</span><span class="j-num">12</span>,' +
      '<span class="j-key">"b":</span><span class="j-bool">true</span>,' +
      '<span class="j-key">"z":</span><span class="j-null">null</span>}',
  );
});

Deno.test("highlightJson: masked string values are highlighted distinctly", () => {
  assertEquals(
    highlightJson('{"pw":"****"}'),
    '{<span class="j-key">"pw":</span><span class="j-masked">"****"</span>}',
  );
});

Deno.test("highlightJson: escapes HTML before highlighting", () => {
  assertEquals(
    highlightJson('{"t":"<b>"}'),
    '{<span class="j-key">"t":</span><span class="j-str">"&lt;b&gt;"</span>}',
  );
});
