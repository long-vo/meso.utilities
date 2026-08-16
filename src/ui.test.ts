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

Deno.test("escapeHtml: escapes both quote characters", () => {
  assertEquals(escapeHtml(`"hello" 'world' 100%`), `&quot;hello&quot; &#39;world&#39; 100%`);
});

// Callers interpolate escaped text into `title="…"` / `aria-label="…"`, so a
// quote that survived would close the attribute and inject a handler.
Deno.test("escapeHtml: an attribute break-out cannot survive", () => {
  assertEquals(
    escapeHtml(`" onmouseover="alert(1)`),
    "&quot; onmouseover=&quot;alert(1)",
  );
});

Deno.test("highlightJson: classifies a key and a string value", () => {
  assertEquals(
    highlightJson('{"a":"x"}'),
    '{<span class="j-key">&quot;a&quot;:</span><span class="j-str">&quot;x&quot;</span>}',
  );
});

Deno.test("highlightJson: number, boolean and null each get their own class", () => {
  assertEquals(
    highlightJson('{"n":12,"b":true,"z":null}'),
    '{<span class="j-key">&quot;n&quot;:</span><span class="j-num">12</span>,' +
      '<span class="j-key">&quot;b&quot;:</span><span class="j-bool">true</span>,' +
      '<span class="j-key">&quot;z&quot;:</span><span class="j-null">null</span>}',
  );
});

Deno.test("highlightJson: masked string values are highlighted distinctly", () => {
  assertEquals(
    highlightJson('{"pw":"****"}'),
    '{<span class="j-key">&quot;pw&quot;:</span><span class="j-masked">&quot;****&quot;</span>}',
  );
});

Deno.test("highlightJson: escapes HTML before highlighting", () => {
  assertEquals(
    highlightJson('{"t":"<b>"}'),
    '{<span class="j-key">&quot;t&quot;:</span><span class="j-str">&quot;&lt;b&gt;&quot;</span>}',
  );
});

// The escaped quotes are the string delimiters now, so an escaped quote *inside*
// a string must not be mistaken for the closing one.
Deno.test("highlightJson: an escaped quote does not end the string", () => {
  assertEquals(
    highlightJson(String.raw`{"q":"say \"hi\""}`),
    '{<span class="j-key">&quot;q&quot;:</span>' +
      '<span class="j-str">&quot;say \\&quot;hi\\&quot;&quot;</span>}',
  );
});
