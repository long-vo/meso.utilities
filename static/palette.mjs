// meso.utilities — command-palette filtering and ranking. Pure logic, imported
// by the palette UI (palette.js) and by the parity tests.

/** True when every character of `word` appears in `text`, in order. */
function isSubsequence(word, text) {
  let matched = 0;
  for (const char of text) {
    if (char === word[matched]) matched++;
    if (matched === word.length) return true;
  }
  return word.length === 0;
}

/**
 * Score a command against a query. Every whitespace-separated query word must
 * match the title or a keyword; a title substring outranks a keyword match,
 * which outranks an in-order subsequence of the title. Earlier matches rank
 * higher. Returns -1 when the command does not match, 0 for an empty query.
 */
export function scoreCommand(command, query) {
  const trimmed = String(query ?? "").trim().toLowerCase();
  if (trimmed === "") return 0;
  const title = String(command.title ?? "").toLowerCase();
  const keywords = (command.keywords ?? []).map((keyword) => String(keyword).toLowerCase());
  let total = 0;
  for (const word of trimmed.split(/\s+/)) {
    let best = -1;
    const inTitle = title.indexOf(word);
    if (inTitle !== -1) best = 100 - Math.min(inTitle, 50);
    for (const keyword of keywords) {
      const inKeyword = keyword.indexOf(word);
      if (inKeyword !== -1) best = Math.max(best, 60 - Math.min(inKeyword, 30));
    }
    if (best === -1 && isSubsequence(word, title)) best = 20;
    if (best === -1) return -1;
    total += best;
  }
  return total;
}

/**
 * Filter and rank commands for a query. Non-matching commands are dropped;
 * ties keep their registration order (page commands are registered first, so
 * they stay on top for an empty query).
 */
export function filterCommands(commands, query) {
  return commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}
