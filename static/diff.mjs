// meso.utilities — line-pair diff for the Sanitize JSON tool. Masking never
// adds or removes lines (values change in place), so pairing line N with
// line N is an exact diff of what was hidden. Pure logic (no DOM), imported
// by the browser UI and the parity tests.

/**
 * Pair the lines of two texts positionally. Returns one row per line:
 * `{ before, after, changed }`. When one text has more lines (which masking
 * never causes, but corrupt input might), the missing side is "".
 */
export function pairLineDiff(beforeText, afterText) {
  const before = String(beforeText).split("\n");
  const after = String(afterText).split("\n");
  const length = Math.max(before.length, after.length);
  const rows = [];
  for (let index = 0; index < length; index++) {
    const beforeLine = before[index] ?? "";
    const afterLine = after[index] ?? "";
    rows.push({ before: beforeLine, after: afterLine, changed: beforeLine !== afterLine });
  }
  return rows;
}

/** Number of changed rows in a `pairLineDiff` result. */
export function changedCount(rows) {
  return rows.filter((row) => row.changed).length;
}
