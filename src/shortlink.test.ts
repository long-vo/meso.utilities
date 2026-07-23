/**
 * Parity tests for the Shortlink tool's pure logic: name/URL validation, the
 * grouped directory ordering, export/import round-trips and hash resolution.
 *
 * The browser UI (static/shortlink/app.js) imports the same module under test,
 * so these assertions are the contract the on-screen behavior must match.
 * Run with `deno task test`.
 */
import {
  addLink,
  bookmarksToLinks,
  buildShortlinkUrl,
  decodeShare,
  displayHost,
  encodeShare,
  faviconUrl,
  filterLinks,
  findDuplicateTarget,
  groupLinks,
  groupTree,
  hueForText,
  linksInGroup,
  mergeLinks,
  moveToGroup,
  normalizeGroup,
  parseBookmarksHtml,
  parseHash,
  parseImport,
  removeLink,
  renameGroup,
  renameGroupList,
  reorderLink,
  resolve,
  resolveDynamic,
  serializeLinks,
  suggestName,
  topLinks,
  updateLink,
  validateName,
  validateUrl,
} from "../static/shortlink/shortlink.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const links = {
  standup: { url: "https://meet.google.com/abc-defg-hij", group: "Team" },
  "retro-notes": { url: "https://example.com/retro", group: "Team" },
  "hr-portal": { url: "https://portal.example.com/hr", group: "Personal" },
  scratch: { url: "https://example.com/scratch" },
};

/* ------------------------------ validateName ------------------------------ */

Deno.test("validateName: accepts letters, digits, spaces and hyphens, trimmed", () => {
  assertEquals(validateName("  sprint-board-2  ", {}), { ok: true, name: "sprint-board-2" });
  assertEquals(validateName("Sprint Board", {}), { ok: true, name: "Sprint Board" });
  assertEquals(validateName("My Cool Link", {}), { ok: true, name: "My Cool Link" });
});

Deno.test("validateName: rejects empty, bad characters and separator misuse", () => {
  for (const bad of ["", "   ", "a_b", "über", "-a", "a-", "a--b", "a  b", "a -b", "#a"]) {
    const result = validateName(bad, {});
    if (result.ok) throw new Error(`expected "${bad}" to be rejected`);
    assert(result.error.length > 0, `expected an error message for "${bad}"`);
  }
});

Deno.test("validateName: rejects a name that is already taken, in any group", () => {
  const result = validateName("hr-portal", links);
  assertEquals(result, { ok: false, error: '"hr-portal" is already taken.' });
});

/* ------------------------------ validateUrl ------------------------------- */

Deno.test("validateUrl: accepts http and https URLs, trimmed", () => {
  assertEquals(validateUrl("  https://example.com/a?b=1#c  "), {
    ok: true,
    url: "https://example.com/a?b=1#c",
  });
  assert(validateUrl("http://localhost:8000/x").ok, "http should be accepted");
});

Deno.test("validateUrl: rejects empty, non-URLs and non-http(s) schemes", () => {
  const bads = [
    "",
    "   ",
    "not a url",
    "example.com",
    "file:///tmp/x",
    "javascript:alert(1)",
    "ftp://x",
  ];
  for (const bad of bads) {
    const result = validateUrl(bad);
    if (result.ok) throw new Error(`expected "${bad}" to be rejected`);
    assert(result.error.length > 0, `expected an error message for "${bad}"`);
  }
});

/* -------------------------- addLink / removeLink -------------------------- */

Deno.test("addLink: adds a validated link with a trimmed group", () => {
  const result = addLink({}, "docs", "https://example.com/docs", "  Team  ");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.links, { docs: { url: "https://example.com/docs", group: "Team" } });
});

Deno.test("addLink: an empty group is stored as ungrouped (no group key)", () => {
  const result = addLink({}, "docs", "https://example.com/docs", "   ");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.links, { docs: { url: "https://example.com/docs" } });
});

Deno.test("addLink: does not mutate the input map and rejects duplicates", () => {
  const before = { docs: { url: "https://example.com/docs" } };
  const dup = addLink(before, "docs", "https://example.com/other", "");
  assert(!dup.ok, "duplicate name should be rejected");
  const added = addLink(before, "wiki", "https://example.com/wiki", "");
  if (!added.ok) throw new Error(added.error);
  assertEquals(before, { docs: { url: "https://example.com/docs" } }, "input map mutated");
  assertEquals(Object.keys(added.links).sort(), ["docs", "wiki"]);
});

Deno.test("removeLink: removes by name without mutating, unknown name is a no-op", () => {
  const before = { docs: { url: "https://example.com/docs" } };
  assertEquals(removeLink(before, "docs"), {});
  assertEquals(before, { docs: { url: "https://example.com/docs" } }, "input map mutated");
  assertEquals(removeLink(before, "nope"), before);
});

/* --------------------------- resolve / parseHash -------------------------- */

Deno.test("resolve: returns the target URL, or null for an unknown name", () => {
  assertEquals(resolve(links, "standup"), "https://meet.google.com/abc-defg-hij");
  assertEquals(resolve(links, "sprint-bord"), null);
  assertEquals(resolve({}, ""), null);
});

Deno.test("parseHash: strips the leading # and percent-decoding", () => {
  assertEquals(parseHash("#standup"), "standup");
  assertEquals(parseHash("standup"), "standup");
  assertEquals(parseHash("#a%20b"), "a b");
  assertEquals(parseHash("#"), "");
  assertEquals(parseHash(""), "");
});

/* --------------------------- findDuplicateTarget -------------------------- */

Deno.test("findDuplicateTarget: names the first link with the same target, else null", () => {
  assertEquals(findDuplicateTarget(links, "https://example.com/scratch"), "scratch");
  // Ties break A→Z across every group.
  const twins = {
    zeta: { url: "https://dup.example" },
    alpha: { url: "https://dup.example", group: "Team" },
  };
  assertEquals(findDuplicateTarget(twins, "https://dup.example"), "alpha");
  assertEquals(findDuplicateTarget(links, "https://nowhere.example"), null);
  assertEquals(findDuplicateTarget(links, "  "), null);
});

/* ------------------------------- groupLinks ------------------------------- */

Deno.test("groupLinks: groups A→Z with ungrouped last, entries A→Z inside each", () => {
  assertEquals(groupLinks(links), [
    {
      group: "Personal",
      entries: [{ name: "hr-portal", url: "https://portal.example.com/hr" }],
    },
    {
      group: "Team",
      entries: [
        { name: "retro-notes", url: "https://example.com/retro" },
        { name: "standup", url: "https://meet.google.com/abc-defg-hij" },
      ],
    },
    {
      group: "",
      entries: [{ name: "scratch", url: "https://example.com/scratch" }],
    },
  ]);
});

Deno.test("groupLinks: empty map produces no groups", () => {
  assertEquals(groupLinks({}), []);
});

/* ------------------------------- sub-groups -------------------------------- */

Deno.test("normalizeGroup: trims segments, drops empties, joins with /", () => {
  assertEquals(normalizeGroup(" Team / Front End "), "Team/Front End");
  assertEquals(normalizeGroup("/a//b/"), "a/b");
  assertEquals(normalizeGroup("Team"), "Team");
  assertEquals(normalizeGroup("   "), "");
  assertEquals(normalizeGroup("///"), "");
});

Deno.test("addLink: the group is normalized as a path", () => {
  const result = addLink({}, "docs", "https://example.com/docs", " Team / FE ");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.links.docs.group, "Team/FE");
});

Deno.test("groupTree: preorder with depths, missing parents added, ungrouped last", () => {
  const nested = {
    one: { url: "https://1.example", group: "Team" },
    two: { url: "https://2.example", group: "Team/Frontend" },
    three: { url: "https://3.example", group: "Team-x" },
    four: { url: "https://4.example", group: "Ops/CI" },
    five: { url: "https://5.example" },
  };
  assertEquals(
    groupTree(nested).map((
      node: { path: string; depth: number; label: string; entries: unknown[] },
    ) => [
      node.path,
      node.depth,
      node.label,
      node.entries.length,
    ]),
    [
      ["Ops", 0, "Ops", 0],
      ["Ops/CI", 1, "CI", 1],
      ["Team", 0, "Team", 1],
      ["Team/Frontend", 1, "Frontend", 1],
      ["Team-x", 0, "Team-x", 1],
      ["", 0, "", 1],
    ],
  );
});

Deno.test("groupTree: declared groups render empty, merge with link groups, nest", () => {
  const links = { a: { url: "https://a.example", group: "Team" } };
  assertEquals(
    groupTree(links, ["Ops/CI", "Team", " Zoo "]).map(
      (node: { path: string; depth: number; entries: unknown[] }) => [
        node.path,
        node.depth,
        node.entries.length,
      ],
    ),
    [
      ["Ops", 0, 0],
      ["Ops/CI", 1, 0],
      ["Team", 0, 1],
      ["Zoo", 0, 0],
    ],
  );
});

Deno.test("renameGroupList: renames the path and its descendants, normalized", () => {
  assertEquals(
    renameGroupList(["Team", "Team/Frontend", "Teammates"], "Team", " Crew / Core "),
    ["Crew/Core", "Crew/Core/Frontend", "Teammates"],
  );
  assertEquals(renameGroupList(["A"], "A", ""), ["A"], "empty target changes nothing");
});

Deno.test("groupTree: entries keep the group's reorder ordering", () => {
  const links = {
    b: { url: "https://b.example", group: "G/S", order: 0 },
    a: { url: "https://a.example", group: "G/S", order: 1 },
  };
  const node = groupTree(links).find((n: { path: string }) => n.path === "G/S");
  if (!node) throw new Error('expected a "G/S" node');
  assertEquals(node.entries.map((e: { name: string }) => e.name), ["b", "a"]);
});

/* ------------------------------- linksInGroup ------------------------------ */

Deno.test("linksInGroup: takes the group and its sub-groups; empty path is ungrouped", () => {
  const nested = {
    one: { url: "https://1.example", group: "Team" },
    two: { url: "https://2.example", group: "Team/Frontend" },
    three: { url: "https://3.example", group: "Teammates" },
    four: { url: "https://4.example" },
  };
  assertEquals(Object.keys(linksInGroup(nested, "Team")).sort(), ["one", "two"]);
  assertEquals(Object.keys(linksInGroup(nested, "Team/Frontend")), ["two"]);
  assertEquals(Object.keys(linksInGroup(nested, "")), ["four"]);
  assertEquals(linksInGroup(nested, "Nope"), {});
});

/* -------------------------------- updateLink ------------------------------- */

Deno.test("updateLink: edits url and renames, keeping the order when the group stays", () => {
  const before = {
    a: { url: "https://a.example", group: "G", order: 1 },
    b: { url: "https://b.example", group: "G", order: 0 },
  };
  const result = updateLink(before, "a", {
    name: "a-two",
    url: "https://a2.example",
    group: "G",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.links["a-two"], { url: "https://a2.example", group: "G", order: 1 });
  assert(!Object.hasOwn(result.links, "a"), "old name should be gone");
  assertEquals(before.a.url, "https://a.example", "input map mutated");
});

Deno.test("updateLink: keeping your own name is not a duplicate; taking another's is", () => {
  const links = {
    a: { url: "https://a.example" },
    b: { url: "https://b.example" },
  };
  const keep = updateLink(links, "a", { name: "a", url: "https://a.example", group: "" });
  if (!keep.ok) throw new Error(keep.error);
  const clash = updateLink(links, "a", { name: "b", url: "https://a.example", group: "" });
  if (clash.ok) throw new Error("expected the taken name to be rejected");
  assert(clash.error.length > 0, "expected an error message");
});

Deno.test("updateLink: a group change drops the order and normalizes the path", () => {
  const result = updateLink(
    { a: { url: "https://a.example", group: "G", order: 3 } },
    "a",
    { name: "a", url: "https://a.example", group: " New / Sub " },
  );
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.links.a, { url: "https://a.example", group: "New/Sub" });
});

Deno.test("updateLink: rejects a bad url and an unknown link", () => {
  const links = { a: { url: "https://a.example" } };
  const badUrl = updateLink(links, "a", { name: "a", url: "nope", group: "" });
  if (badUrl.ok) throw new Error("expected the bad url to be rejected");
  const unknown = updateLink(links, "nope", { name: "x", url: "https://x.example", group: "" });
  if (unknown.ok) throw new Error("expected the unknown link to be rejected");
});

/* ------------------------------- renameGroup ------------------------------- */

Deno.test("renameGroup: renames the group and its sub-groups, normalized", () => {
  const before = {
    a: { url: "https://a.example", group: "Team", order: 0 },
    b: { url: "https://b.example", group: "Team/Frontend" },
    c: { url: "https://c.example", group: "Teammates" },
    d: { url: "https://d.example" },
  };
  const result = renameGroup(before, "Team", " Crew / Core ");
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.links.a, { url: "https://a.example", group: "Crew/Core", order: 0 });
  assertEquals(result.links.b.group, "Crew/Core/Frontend");
  assertEquals(result.links.c.group, "Teammates", "prefix look-alike must be untouched");
  assertEquals(result.links.d, { url: "https://d.example" });
  assertEquals(before.a.group, "Team", "input map mutated");
});

Deno.test("renameGroup: an empty target is rejected; the same path is a no-op", () => {
  const links = { a: { url: "https://a.example", group: "G" } };
  const empty = renameGroup(links, "G", "  /  ");
  if (empty.ok) throw new Error("expected the empty target to be rejected");
  const same = renameGroup(links, "G", "G");
  if (!same.ok) throw new Error(same.error);
  assertEquals(same.links, links);
});

/* ------------------------------- moveToGroup ------------------------------- */

Deno.test("moveToGroup: changes the group, drops the old order, normalizes the path", () => {
  const before = {
    a: { url: "https://a.example", group: "G", order: 2 },
    b: { url: "https://b.example", group: "G", order: 0 },
  };
  const links = moveToGroup(before, "a", " Team / FE ");
  assertEquals(links.a, { url: "https://a.example", group: "Team/FE" });
  assertEquals(links.b, before.b);
  assertEquals(before.a.group, "G", "input map mutated");
});

Deno.test("moveToGroup: an empty target makes the link ungrouped", () => {
  const links = moveToGroup({ a: { url: "https://a.example", group: "G" } }, "a", "");
  assertEquals(links, { a: { url: "https://a.example" } });
});

Deno.test("moveToGroup: unknown name or the same group change nothing", () => {
  const before = { a: { url: "https://a.example", group: "G", order: 1 } };
  assertEquals(moveToGroup(before, "nope", "H"), before);
  assertEquals(moveToGroup(before, "a", "G"), before);
});

/* -------------------------------- reorder --------------------------------- */

Deno.test("groupLinks: entries with an order come first, by order; the rest A→Z", () => {
  const mixed = {
    zebra: { url: "https://z.example", group: "G", order: 0 },
    apple: { url: "https://a.example", group: "G" },
    mango: { url: "https://m.example", group: "G", order: 1 },
    kiwi: { url: "https://k.example", group: "G" },
  };
  assertEquals(groupLinks(mixed)[0].entries.map((e: { name: string }) => e.name), [
    "zebra",
    "mango",
    "apple",
    "kiwi",
  ]);
});

Deno.test("reorderLink: moves before a target and renumbers the group 0..n-1", () => {
  const before = {
    a: { url: "https://a.example", group: "G" },
    b: { url: "https://b.example", group: "G" },
    c: { url: "https://c.example", group: "G" },
    other: { url: "https://o.example", group: "H", order: 5 },
  };
  const links = reorderLink(before, "c", "a");
  assertEquals(groupLinks(links)[0].entries.map((e: { name: string }) => e.name), ["c", "a", "b"]);
  assertEquals(links.c.order, 0);
  assertEquals(links.a.order, 1);
  assertEquals(links.b.order, 2);
  assertEquals(links.other, { url: "https://o.example", group: "H", order: 5 });
  assertEquals(before.a, { url: "https://a.example", group: "G" }, "input map mutated");
});

Deno.test("reorderLink: a null target moves the link to the end of its group", () => {
  const links = reorderLink(
    {
      a: { url: "https://a.example" },
      b: { url: "https://b.example" },
    },
    "a",
    null,
  );
  assertEquals(groupLinks(links)[0].entries.map((e: { name: string }) => e.name), ["b", "a"]);
});

Deno.test("reorderLink: unknown names or a target in another group change nothing", () => {
  const before = {
    a: { url: "https://a.example", group: "G" },
    b: { url: "https://b.example", group: "H" },
  };
  assertEquals(reorderLink(before, "a", "b"), before);
  assertEquals(reorderLink(before, "nope", null), before);
});

Deno.test("order survives an export/import round-trip", () => {
  const withOrder = {
    b: { url: "https://b.example", group: "G", order: 0 },
    a: { url: "https://a.example", group: "G", order: 1 },
  };
  const result = parseImport(serializeLinks(withOrder));
  if (!result.ok) throw new Error(result.error);
  assertEquals(serializeLinks(result.links), serializeLinks(withOrder));
});

Deno.test("parseImport: rejects a non-numeric order", () => {
  const result = parseImport('{"a":{"url":"https://a.example","order":"first"}}');
  if (result.ok) throw new Error("expected rejection");
  assert(result.error.length > 0, "expected an error message");
});

/* --------------------------- serialize / import --------------------------- */

Deno.test("serializeLinks: stable pretty JSON with sorted names", () => {
  const text = serializeLinks({
    b: { url: "https://example.com/b" },
    a: { url: "https://example.com/a", group: "G" },
  });
  assertEquals(
    text,
    '{\n  "a": {\n    "url": "https://example.com/a",\n    "group": "G"\n  },\n' +
      '  "b": {\n    "url": "https://example.com/b"\n  }\n}',
  );
});

Deno.test("parseImport: round-trips an export", () => {
  const result = parseImport(serializeLinks(links));
  if (!result.ok) throw new Error(result.error);
  // Compare via the stable serialization — export sorts names, the fixture is unsorted.
  assertEquals(serializeLinks(result.links), serializeLinks(links));
});

Deno.test("parseImport: rejects non-JSON, non-objects and malformed entries", () => {
  const bads = [
    "not json",
    "[1,2]",
    '"str"',
    "null",
    '{"ok":{"url":"https://x.example"},"bad_name":{"url":"https://x.example"}}',
    '{"a":{"url":"file:///etc/passwd"}}',
    '{"a":{"url":"https://x.example","group":42}}',
    '{"a":"https://x.example"}',
    '{"a":{}}',
  ];
  for (const bad of bads) {
    const result = parseImport(bad);
    if (result.ok) throw new Error(`expected import to be rejected: ${bad}`);
    assert(result.error.length > 0, `expected an error message for: ${bad}`);
  }
});

Deno.test("mergeLinks: imported entries win on conflict, with added/replaced counts", () => {
  const existing = {
    docs: { url: "https://example.com/docs" },
    wiki: { url: "https://example.com/wiki", group: "Team" },
  };
  const imported = {
    wiki: { url: "https://example.com/new-wiki" },
    board: { url: "https://example.com/board", group: "Team" },
  };
  const result = mergeLinks(existing, imported);
  assertEquals(result.added, 1);
  assertEquals(result.replaced, 1);
  assertEquals(result.links, {
    docs: { url: "https://example.com/docs" },
    wiki: { url: "https://example.com/new-wiki" },
    board: { url: "https://example.com/board", group: "Team" },
  });
  assertEquals(existing.wiki.url, "https://example.com/wiki", "input map mutated");
});

/* ---------------------------- bookmarks import ---------------------------- */

// Chrome/Firefox-style Netscape bookmark export: a toolbar root folder, a
// nested folder, an HTML entity in a title, and two skippable non-http links.
const BOOKMARKS_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://meet.google.com/abc" ADD_DATE="1700000000">Daily standup</A>
    <DT><H3 ADD_DATE="1700000000">Dev &amp; Ops</H3>
    <DL><p>
      <DT><A HREF="https://example.com/ci">CI — Pipelines</A>
      <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
      <DT><A HREF="https://example.com/untitled"></A>
      <DT><H3>Tools</H3>
      <DL><p>
        <DT><A HREF="https://example.com/grafana">Grafana</A>
      </DL><p>
    </DL><p>
    <DT><A HREF="file:///tmp/notes.txt">Local notes</A>
  </DL><p>
</DL><p>`;

Deno.test("parseBookmarksHtml: extracts http(s) links with their full folder path", () => {
  const result = parseBookmarksHtml(BOOKMARKS_HTML);
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.bookmarks, [
    { title: "Daily standup", url: "https://meet.google.com/abc", folder: "" },
    { title: "CI — Pipelines", url: "https://example.com/ci", folder: "Dev & Ops" },
    { title: "", url: "https://example.com/untitled", folder: "Dev & Ops" },
    { title: "Grafana", url: "https://example.com/grafana", folder: "Dev & Ops/Tools" },
  ]);
});

Deno.test("parseBookmarksHtml: rejects files that are not a bookmark export", () => {
  for (const bad of ["", '{"a":{"url":"https://x.example"}}', "<html><body>hi</body></html>"]) {
    const result = parseBookmarksHtml(bad);
    if (result.ok) throw new Error(`expected rejection for: ${bad}`);
    assert(result.error.length > 0, "expected an error message");
  }
});

Deno.test("bookmarksToLinks: slugified names, folder as group, deduped candidates", () => {
  const existing = { "daily-standup": { url: "https://old.example" } };
  const candidates = bookmarksToLinks(
    [
      { title: "Daily standup", url: "https://meet.google.com/abc", folder: "" },
      { title: "CI — Pipelines", url: "https://example.com/ci", folder: "Dev & Ops" },
      { title: "CI Pipelines!", url: "https://example.com/ci2", folder: "Dev & Ops" },
      { title: "", url: "https://portal.example.com/x", folder: "" },
    ],
    existing,
  );
  assertEquals(candidates, [
    {
      name: "daily-standup-2",
      title: "Daily standup",
      url: "https://meet.google.com/abc",
      group: "",
    },
    {
      name: "ci-pipelines",
      title: "CI — Pipelines",
      url: "https://example.com/ci",
      group: "Dev & Ops",
    },
    {
      name: "ci-pipelines-2",
      title: "CI Pipelines!",
      url: "https://example.com/ci2",
      group: "Dev & Ops",
    },
    { name: "portal-example-com", title: "", url: "https://portal.example.com/x", group: "" },
  ]);
});

/* ------------------------------- suggestName ------------------------------- */

Deno.test("suggestName: leading host label plus first path segment, slugified", () => {
  assertEquals(suggestName("https://jira.mesoneer.io/browse"), "jira-browse");
  assertEquals(suggestName("https://github.com"), "github");
  assertEquals(suggestName("https://www.google.com/search?q=x"), "google-search");
  assertEquals(suggestName("http://localhost:8000/x"), "localhost-x");
});

Deno.test("suggestName: dedupes against existing names, returns '' for non-http(s)", () => {
  const existing = { github: { url: "https://github.com" } };
  assertEquals(suggestName("https://github.com/deno", { github: existing.github }), "github-deno");
  assertEquals(suggestName("https://github.com", existing), "github-2");
  assertEquals(suggestName("not a url"), "");
  assertEquals(suggestName("ftp://x/y"), "");
  assertEquals(suggestName(""), "");
});

/* ------------------------- grid view: hue + host --------------------------- */

Deno.test("hueForText: deterministic, in 0–359, spread across inputs", () => {
  assertEquals(hueForText("meet.google.com"), hueForText("meet.google.com"));
  const hues = ["meet.google.com", "mesoneerag.atlassian.net", "portal.mesoneer.io", "Team"]
    .map(hueForText);
  for (const hue of hues) {
    assert(Number.isInteger(hue) && hue >= 0 && hue < 360, `hue out of range: ${hue}`);
  }
  assert(new Set(hues).size > 1, "expected different inputs to spread over hues");
});

Deno.test("displayHost: hostname without www, or the raw value when unparsable", () => {
  assertEquals(displayHost("https://www.example.com/a/b?c=1"), "example.com");
  assertEquals(displayHost("http://localhost:8000/x"), "localhost");
  assertEquals(displayHost("not a url"), "not a url");
});

Deno.test("faviconUrl: target-origin icon for http(s), path and query stripped", () => {
  assertEquals(
    faviconUrl("https://www.example.com/a/b?c=1"),
    "https://www.example.com/favicon.ico",
  );
  assertEquals(faviconUrl("https://github.com/mesoneer"), "https://github.com/favicon.ico");
  // The port is part of the origin; the scheme is preserved for http intranets.
  assertEquals(faviconUrl("http://localhost:8000/x"), "http://localhost:8000/favicon.ico");
  // Dynamic {q} targets still have a plain host to ask for an icon.
  assertEquals(
    faviconUrl("https://www.google.com/search?q={q}"),
    "https://www.google.com/favicon.ico",
  );
});

Deno.test("faviconUrl: null for non-http schemes and unparsable values", () => {
  assertEquals(faviconUrl("mailto:team@example.com"), null);
  assertEquals(faviconUrl("chrome://settings"), null);
  assertEquals(faviconUrl("not a url"), null);
  assertEquals(faviconUrl(""), null);
});

Deno.test("faviconUrl: embedded OKD icon for the cluster host and its subdomains", () => {
  const okdIcon = faviconUrl("https://okd4.dev.mesoneer.io/");
  assert(
    okdIcon !== null && okdIcon.startsWith("data:image/png;base64,"),
    "expected an embedded PNG data URI",
  );
  // Subdomains — the *.apps.<cluster> routes — get the same icon.
  assertEquals(faviconUrl("https://console.apps.okd4.dev.mesoneer.io/dashboard"), okdIcon);
  // A lookalike host that only ends in the same labels without the dot boundary
  // is a different domain and keeps its own favicon.
  assertEquals(
    faviconUrl("https://notokd4.dev.mesoneer.io/"),
    "https://notokd4.dev.mesoneer.io/favicon.ico",
  );
  // Other mesoneer hosts are unaffected.
  assertEquals(
    faviconUrl("https://jira.mesoneer.io/browse"),
    "https://jira.mesoneer.io/favicon.ico",
  );
});

/* ------------------------------ resolveDynamic ----------------------------- */

Deno.test("resolveDynamic: exact names resolve like resolve()", () => {
  assertEquals(resolveDynamic(links, "standup"), "https://meet.google.com/abc-defg-hij");
  assertEquals(resolveDynamic(links, "nope"), null);
  assertEquals(resolveDynamic(links, ""), null);
});

Deno.test("resolveDynamic: #name/rest appends the rest to the target", () => {
  const dyn = {
    jira: { url: "https://x.example/browse" },
    wiki: { url: "https://x.example/wiki/" },
  };
  assertEquals(resolveDynamic(dyn, "jira/PROJ-123"), "https://x.example/browse/PROJ-123");
  assertEquals(resolveDynamic(dyn, "wiki/spaces/TEAM"), "https://x.example/wiki/spaces/TEAM");
  assertEquals(resolveDynamic(dyn, "nope/PROJ-123"), null);
});

Deno.test("resolveDynamic: a {q} target substitutes the encoded rest", () => {
  const dyn = { g: { url: "https://g.example/search?q={q}&hl=en" } };
  assertEquals(resolveDynamic(dyn, "g/deno fmt"), "https://g.example/search?q=deno%20fmt&hl=en");
  assertEquals(resolveDynamic(dyn, "g"), "https://g.example/search?q=&hl=en");
});

Deno.test("validateUrl: accepts a {q} placeholder target", () => {
  assert(validateUrl("https://g.example/search?q={q}").ok, "{q} target should be accepted");
});

/* -------------------------------- filterLinks ------------------------------ */

Deno.test("filterLinks: matches name, url and group, case-insensitively", () => {
  assertEquals(Object.keys(filterLinks(links, "STAND")), ["standup"]);
  assertEquals(Object.keys(filterLinks(links, "portal.example")), ["hr-portal"]);
  assertEquals(Object.keys(filterLinks(links, "team")).sort(), ["retro-notes", "standup"]);
  assertEquals(filterLinks(links, "  "), links, "blank query returns everything");
  assertEquals(Object.keys(filterLinks(links, "zzz")), []);
});

/* --------------------------------- topLinks -------------------------------- */

Deno.test("topLinks: most-hit links first, unknown and zero-hit names dropped", () => {
  const hits = { standup: 9, scratch: 2, ghost: 50, "hr-portal": 0 };
  assertEquals(topLinks(links, hits, 5), [
    { name: "standup", url: "https://meet.google.com/abc-defg-hij", count: 9 },
    { name: "scratch", url: "https://example.com/scratch", count: 2 },
  ]);
  assertEquals(topLinks(links, hits, 1).length, 1, "limit is respected");
  assertEquals(topLinks(links, {}, 5), []);
});

/* ------------------------------- share via URL ----------------------------- */

Deno.test("encodeShare/decodeShare: round-trips links, URL-safe, unicode groups", () => {
  const shared = {
    standup: { url: "https://meet.google.com/abc", group: "Đội ngũ" },
    docs: { url: "https://example.com/docs", order: 1 },
  };
  const blob = encodeShare(shared);
  assert(/^[A-Za-z0-9_-]+$/.test(blob), "blob must be URL-safe with no padding");
  const result = decodeShare(blob);
  if (!result.ok) throw new Error(result.error);
  assertEquals(serializeLinks(result.links), serializeLinks(shared));
});

Deno.test("decodeShare: rejects garbage", () => {
  for (const bad of ["", "not-base64!!", "aGVsbG8"]) {
    const result = decodeShare(bad);
    if (result.ok) throw new Error(`expected rejection for: ${bad}`);
    assert(result.error.length > 0, "expected an error message");
  }
});

/* ---------------------------- buildShortlinkUrl --------------------------- */

Deno.test("buildShortlinkUrl: replaces any existing hash and encodes the name", () => {
  assertEquals(
    buildShortlinkUrl("http://localhost:8000/shortlink/", "standup"),
    "http://localhost:8000/shortlink/#standup",
  );
  assertEquals(
    buildShortlinkUrl("https://x.example/shortlink/#old", "retro-notes"),
    "https://x.example/shortlink/#retro-notes",
  );
  assertEquals(
    buildShortlinkUrl("https://x.example/shortlink/index.html", "a"),
    "https://x.example/shortlink/#a",
  );
});
