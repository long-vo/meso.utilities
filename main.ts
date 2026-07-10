/**
 * meso.utilities — a small Deno web app that ports the Slack `/sanitize-text`
 * command to the browser. It serves a single-page UI plus a JSON API, both
 * backed by the same masking logic in `src/sanitize.mjs`.
 *
 * Runtime: Deno (Deno.serve). Deployable to Deno Deploy with no build step.
 * Local: `deno task start` (or `deno task dev` for watch mode).
 *
 * Routes:
 *   GET  /               -> the utilities hub / master page (static/index.html)
 *   GET  /<tool>/        -> a tool page (static/<tool>/index.html); the bare
 *                           path (/<tool>) redirects to the slash form
 *   GET  /styles.css     -> shared stylesheet
 *   GET  /theme.js       -> shared theme toggle
 *   GET  /app.js         -> sanitizer UI logic
 *   GET  /sanitize.mjs   -> shared masking module (imported by the browser)
 *   GET  /poker.mjs      -> shared poker-room module (imported by the browser)
 *   POST /api/sanitize   -> { json, fields?, keepLast? } => { sanitized, pretty, stats }
 *   POST /api/sanitize-log -> { log, keepLast?, maskAll?, redact?, fields? } => { text, stats }
 *   GET  /api/poker/ws   -> WebSocket upgrade for a scrum-poker room
 *   GET  /health         -> liveness probe
 */
import { runSanitize, runSanitizeLog } from "./src/sanitize.mjs";
import { handlePokerSocket } from "./src/poker-server.ts";

const STATIC_DIR = new URL("./static/", import.meta.url);
const SRC_DIR = new URL("./src/", import.meta.url);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Read a file relative to a base directory URL and return it as a Response.
 * Returns null if the file does not exist, so callers can fall through to 404.
 * The leading path is sanitized to keep requests inside the base directory.
 */
async function serveFile(baseUrl: URL, name: string): Promise<Response | null> {
  if (name.includes("..") || name.includes("\0")) return null;
  try {
    const fileUrl = new URL(name, baseUrl);
    const data = await Deno.readFile(fileUrl);
    return new Response(data, {
      headers: {
        "content-type": contentTypeFor(name),
        "cache-control": "no-cache",
      },
    });
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** POST /api/sanitize — mask a payload and return the result as JSON. */
async function handleApiSanitize(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  if (payload.json === undefined || payload.json === null) {
    return json({ error: 'Missing "json" field (a JSON string or value to sanitize).' }, 400);
  }

  // `json` may be a raw JSON string or an already-parsed value; the shared
  // pipeline expects text, so stringify non-strings first.
  const jsonText = typeof payload.json === "string" ? payload.json : JSON.stringify(payload.json);
  const fields = payload.fields ?? "";
  const keepLast = payload.keepLast ?? 0;

  const result = runSanitize(jsonText, fields, keepLast);
  if (!result.ok) return json({ error: result.error }, 400);

  return json({
    sanitized: result.sanitized,
    pretty: result.pretty,
    fields: result.fields,
    keepLast: result.keepLast,
    stats: result.stats,
  });
}

/** POST /api/sanitize-log — mask every JSON block embedded in log text. */
async function handleApiSanitizeLog(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  if (typeof payload.log !== "string") {
    return json({ error: 'Missing "log" field (the log text to sanitize).' }, 400);
  }

  const result = runSanitizeLog(payload.log, {
    keepLast: payload.keepLast ?? 0,
    // maskAll defaults on (opt out with false); redact is opt-in (default off)
    // so it never touches loose IDs in plain log lines unless asked.
    maskAll: payload.maskAll !== false,
    redact: payload.redact === true,
    fields: (payload.fields ?? []) as string | string[],
  });

  return json({ text: result.text, stats: result.stats });
}

async function handler(req: Request): Promise<Response> {
  const { pathname, search } = new URL(req.url);

  if (req.method === "POST" && pathname === "/api/sanitize") {
    return await handleApiSanitize(req);
  }

  if (req.method === "POST" && pathname === "/api/sanitize-log") {
    return await handleApiSanitizeLog(req);
  }

  if (req.method === "GET" && pathname === "/api/poker/ws") {
    return handlePokerSocket(req);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/health") {
      return json({ status: "ok", service: "meso.utilities", time: new Date().toISOString() });
    }
    if (pathname === "/" || pathname === "/index.html") {
      return (await serveFile(STATIC_DIR, "index.html")) ?? notFound();
    }
    // Shared browser modules live in src/ — the same files the server imports.
    if (pathname === "/sanitize.mjs" || pathname === "/poker.mjs") {
      return (await serveFile(SRC_DIR, pathname.slice(1))) ?? notFound();
    }
    const asset = pathname.replace(/^\/+/, "");
    if (asset) {
      const res = await serveFile(STATIC_DIR, asset);
      if (res) return res;
      // Tool pages live in subfolders (static/<tool>/index.html). Serve the
      // trailing-slash form and redirect the bare path so relative asset URLs
      // (../styles.css) resolve consistently.
      if (pathname.endsWith("/")) {
        const index = await serveFile(STATIC_DIR, asset + "index.html");
        if (index) return index;
      } else if (!asset.includes(".")) {
        const index = await serveFile(STATIC_DIR, asset + "/index.html");
        if (index) {
          // Keep the query string — invite links like /poker?room=QK7M rely on it.
          return new Response(null, {
            status: 301,
            headers: { location: `${pathname}/${search}` },
          });
        }
      }
    }
  }

  return notFound();
}

// Deno Deploy provides the port; locally we honour $PORT and default to 8000.
const port = Number(Deno.env.get("PORT")) || 8000;
Deno.serve({
  port,
  onListen: ({ port }) => console.log(`meso.utilities on http://localhost:${port}`),
}, handler);
