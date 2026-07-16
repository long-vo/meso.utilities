// meso.utilities — diff/merge engine for the Compare Files tool. Pure logic
// (no DOM): a Myers line diff, side-by-side row alignment for two or three
// files, character-level inline segments, hunk grouping and a per-hunk merge.
// Imported unchanged by the browser UI (app.js) and the parity tests
// (src/compare.test.ts).

/** Split text into lines, tolerating Windows/old-Mac line endings. */
export function splitLines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n");
}

/** Inputs longer than this fall back to a prefix/suffix diff (Myers is O(ND)). */
const MYERS_LINE_LIMIT = 20000;
/** Lines longer than this skip character-level highlighting. */
const CHAR_DIFF_LIMIT = 600;

/**
 * Shortest edit script between two arrays (Myers O(ND) with a greedy
 * backtrack). Returns ops in order: `{ type: "same" | "del" | "add", value }`.
 * Common prefix/suffix is trimmed first so typical edits stay cheap.
 */
export function diffOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((value) => ({ type: "same", value }));
  const tail = a.slice(endA).map((value) => ({ type: "same", value }));
  const coreA = a.slice(start, endA);
  const coreB = b.slice(start, endB);
  const core = coreA.length > MYERS_LINE_LIMIT || coreB.length > MYERS_LINE_LIMIT
    ? blockDiff(coreA, coreB)
    : myers(coreA, coreB);
  return [...head, ...core, ...tail];
}

/** Degenerate fallback for huge inputs: everything deleted, then added. */
function blockDiff(a, b) {
  return [
    ...a.map((value) => ({ type: "del", value })),
    ...b.map((value) => ({ type: "add", value })),
  ];
}

/** Myers O(ND) shortest-edit-script with trace backtracking. */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((value) => ({ type: "add", value }));
  if (m === 0) return a.map((value) => ({ type: "del", value }));

  const max = n + m;
  const offset = max;
  let v = new Array(2 * max + 1).fill(0);
  const trace = [];

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v);
    v = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  trace.push(v);

  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])
      ? k + 1
      : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "same", value: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: "add", value: b[y - 1] });
        y--;
      } else {
        ops.push({ type: "del", value: a[x - 1] });
        x--;
      }
    }
  }
  return ops.reverse();
}

/**
 * Align two texts into side-by-side rows: `{ a, b, type }` where a missing
 * side is `null` and `type` is `"same"`, `"mod"` (both present, different),
 * `"del"` (only in A) or `"add"` (only in B). Runs of deletions and additions
 * between unchanged lines are paired positionally into `"mod"` rows.
 */
export function alignPair(aText, bText) {
  const ops = diffOps(splitLines(aText), splitLines(bText));
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const paired = Math.min(dels.length, adds.length);
    for (let i = 0; i < paired; i++) rows.push({ a: dels[i], b: adds[i], type: "mod" });
    for (let i = paired; i < dels.length; i++) rows.push({ a: dels[i], b: null, type: "del" });
    for (let i = paired; i < adds.length; i++) rows.push({ a: null, b: adds[i], type: "add" });
    dels = [];
    adds = [];
  };
  for (const op of ops) {
    if (op.type === "same") {
      flush();
      rows.push({ a: op.value, b: op.value, type: "same" });
    } else if (op.type === "del") {
      dels.push(op.value);
    } else {
      adds.push(op.value);
    }
  }
  flush();
  return rows;
}

/**
 * Align three texts into rows `{ a, b, c, type }`, using B (the middle file)
 * as the anchor: A and C are each aligned against B and the two alignments
 * are zipped along B's lines. `type` is `"same"` only when all three sides
 * are present and equal; otherwise `"diff"`.
 */
export function alignTriple(aText, bText, cText) {
  const ab = alignPair(aText, bText); // a = A, b = B
  const bc = alignPair(bText, cText); // a = B, b = C
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < ab.length || j < bc.length) {
    const left = ab[i];
    const right = bc[j];
    if (left && left.b === null) {
      rows.push(makeTripleRow(left.a, null, null));
      i++;
    } else if (right && right.a === null) {
      rows.push(makeTripleRow(null, null, right.b));
      j++;
    } else if (left && right) {
      rows.push(makeTripleRow(left.a, left.b, right.b));
      i++;
      j++;
    } else if (left) {
      rows.push(makeTripleRow(left.a, left.b, null));
      i++;
    } else {
      rows.push(makeTripleRow(null, right.a, right.b));
      j++;
    }
  }
  return rows;
}

function makeTripleRow(a, b, c) {
  const same = a !== null && b !== null && c !== null && a === b && b === c;
  return { a, b, c, type: same ? "same" : "diff" };
}

/**
 * Character-level diff of one line pair for inline highlighting. Returns
 * `{ a, b }`, each an array of segments `{ text, changed }` that concatenate
 * back to the original line. Very long lines skip the char diff and come
 * back as one changed segment.
 */
export function charDiff(aLine, bLine) {
  if (aLine === bLine) {
    return {
      a: aLine === "" ? [] : [{ text: aLine, changed: false }],
      b: bLine === "" ? [] : [{ text: bLine, changed: false }],
    };
  }
  if (aLine.length > CHAR_DIFF_LIMIT || bLine.length > CHAR_DIFF_LIMIT) {
    return {
      a: aLine === "" ? [] : [{ text: aLine, changed: true }],
      b: bLine === "" ? [] : [{ text: bLine, changed: true }],
    };
  }
  const ops = diffOps([...aLine], [...bLine]);
  const a = [];
  const b = [];
  for (const op of ops) {
    if (op.type === "same") {
      pushSegment(a, op.value, false);
      pushSegment(b, op.value, false);
    } else if (op.type === "del") {
      pushSegment(a, op.value, true);
    } else {
      pushSegment(b, op.value, true);
    }
  }
  return { a, b };
}

function pushSegment(segments, text, changed) {
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

/**
 * Group consecutive non-`same` rows into hunks: `{ start, end }` with `end`
 * exclusive. Hunks are the unit the merge picks operate on.
 */
export function buildHunks(rows) {
  const hunks = [];
  let start = -1;
  rows.forEach((row, index) => {
    if (row.type !== "same") {
      if (start < 0) start = index;
    } else if (start >= 0) {
      hunks.push({ start, end: index });
      start = -1;
    }
  });
  if (start >= 0) hunks.push({ start, end: rows.length });
  return hunks;
}

/**
 * Build the merged text: unchanged rows pass through; each hunk contributes
 * the lines of the side picked for it (`picks[hunkIndex]` is `"a"`, `"b"` or
 * `"c"`; missing picks default to `"a"`). Rows where the picked side is
 * absent contribute nothing.
 */
export function mergeRows(rows, hunks, picks) {
  const lines = [];
  let h = 0;
  for (let i = 0; i < rows.length; i++) {
    if (h < hunks.length && i === hunks[h].start) {
      const side = picks[h] ?? "a";
      for (let j = hunks[h].start; j < hunks[h].end; j++) {
        const value = rows[j][side];
        if (value !== null && value !== undefined) lines.push(value);
      }
      i = hunks[h].end - 1;
      h++;
    } else {
      lines.push(rows[i].a ?? rows[i].b ?? rows[i].c ?? "");
    }
  }
  return lines.join("\n");
}

/** Per-type row counts for the status line: `{ same, mod, del, add, diff }`. */
export function diffStats(rows) {
  const stats = { same: 0, mod: 0, del: 0, add: 0, diff: 0 };
  for (const row of rows) stats[row.type] = (stats[row.type] ?? 0) + 1;
  return stats;
}
