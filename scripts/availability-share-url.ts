#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * Turn a downloaded vacation workbook into a Team Availability share URL.
 *
 * Written for the unattended refresh: something downloads
 * `mesoneer-Vacation-<year>.xlsx` from SharePoint, this prints a `#share=` URL,
 * and a browser opens it. The payload rides in the URL *fragment*, which is
 * never sent to any server — so the roster goes from this machine straight into
 * that browser's localStorage and is never published. Nothing here writes to
 * the repo, and the workbook must never be committed.
 *
 * The parse is not a reimplementation: it imports the same `xlsx.mjs` and
 * `availability.mjs` the page ships, so what this produces is byte-for-byte
 * what dropping the file on the page would produce.
 *
 *   deno run --allow-read --allow-env scripts/availability-share-url.ts
 *   deno run --allow-read --allow-env scripts/availability-share-url.ts \
 *     --dir ~/Downloads --max-age-min 10 --base https://long-vo.github.io/meso.utilities
 *
 * The URL is the only thing on stdout, so it pipes; everything else is stderr.
 * That URL contains every name and absence in the workbook — treat it like the
 * roster itself and don't paste it anywhere.
 */
import { readWorkbook } from "../static/availability/xlsx.mjs";
import {
  encodeShare,
  packModel,
  parseVacationWorkbook,
  yearFromFilename,
} from "../static/availability/availability.mjs";

const DEFAULT_BASE = "https://long-vo.github.io/meso.utilities";
const DEFAULT_PATTERN = /^mesoneer-Vacation-.*\.xlsx$/i;

/** Minimal flag parsing — no dependency, and every flag here is `--k v`. */
function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1] ?? "";
    i++;
  }
  return out;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  Deno.exit(1);
}

/** `~/Downloads` → an absolute path; Deno does not expand `~` itself. */
function resolveHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = Deno.env.get("HOME");
  if (home === undefined) fail("HOME is not set, so ~ cannot be expanded");
  return home + path.slice(1);
}

/**
 * The most recently modified workbook in `dir`. Chrome deduplicates repeat
 * downloads as `mesoneer-Vacation-2026 (1).xlsx`, so a fixed filename would
 * silently keep reading the first one it ever saved.
 */
async function newestWorkbook(dir: string) {
  const candidates: Array<{ path: string; name: string; modified: Date }> = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !DEFAULT_PATTERN.test(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    const info = await Deno.stat(path);
    if (info.mtime === null) continue;
    candidates.push({ path, name: entry.name, modified: info.mtime });
  }
  candidates.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return candidates[0];
}

const opts = flags(Deno.args);
const dir = resolveHome(opts.dir ?? "~/Downloads");
const base = (opts.base ?? DEFAULT_BASE).replace(/\/+$/, "");
const maxAgeMin = Number(opts["max-age-min"] ?? 10);
if (!Number.isFinite(maxAgeMin) || maxAgeMin < 0) fail("--max-age-min must be a number ≥ 0");

let found;
try {
  found = await newestWorkbook(dir);
} catch (err) {
  fail(`cannot read ${dir}: ${err instanceof Error ? err.message : err}`);
}
if (found === undefined) {
  fail(`no mesoneer-Vacation-*.xlsx in ${dir} — did the download run?`);
}

// A download that quietly failed leaves yesterday's file in place, and parsing
// it would report success with stale data. Age is the only signal we have.
const ageMin = (Date.now() - found.modified.getTime()) / 60_000;
if (maxAgeMin > 0 && ageMin > maxAgeMin) {
  fail(
    `${found.name} is ${Math.round(ageMin)} min old (limit ${maxAgeMin}) — ` +
      "the download probably did not run. Pass --max-age-min 0 to use it anyway.",
  );
}
console.error(`• ${found.name} (${Math.round(ageMin)} min old)`);

const bytes = await Deno.readFile(found.path);
let sheets;
try {
  sheets = await readWorkbook(bytes);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // An expired SharePoint session serves an HTML sign-in page, which Chrome
  // happily saves under the .xlsx name. That is the single most likely failure
  // of an unattended run, and it is worth naming rather than dumping a trace.
  if (message.includes("not a zip archive")) {
    fail(
      `${found.name} is not a workbook — it is most likely a SharePoint sign-in ` +
        "page. Open the download URL in Chrome, sign in, and run again.",
    );
  }
  fail(`could not read ${found.name}: ${message}`);
}

const year = yearFromFilename(found.name) ?? new Date().getFullYear();
let model;
try {
  model = parseVacationWorkbook(sheets, { year });
} catch (err) {
  fail(
    `${found.name} parsed as a workbook but not as a vacation plan: ` +
      `${err instanceof Error ? err.message : err}`,
  );
}
if (model.people.length === 0) {
  fail(`no roster rows found in ${found.name} — has the sheet layout changed?`);
}

console.error(
  `• ${model.people.length} people · ${model.days.length} days · year ${year}` +
    (model.warnings.length > 0 ? ` · ${model.warnings.length} dirty cells` : ""),
);
for (const warning of model.warnings.slice(0, 5)) console.error(`  ! ${warning.message}`);
if (model.warnings.length > 5) {
  console.error(`  ! …and ${model.warnings.length - 5} more (the page lists them all)`);
}

// `replace: true` marks this as the whole year rather than a shared slice, so
// the page swaps its roster instead of merging — otherwise people who left the
// team would survive every refresh. Warnings are dropped: they describe this
// workbook and the page recomputes its own.
const url = `${base}/availability/#share=${await encodeShare({
  v: 1,
  year,
  tags: {},
  replace: true,
  model: packModel({ people: model.people, days: model.days, warnings: [] }),
})}`;

console.error(`• ${(url.length / 1024).toFixed(1)} KB URL — contains names and absences`);
console.log(url);
