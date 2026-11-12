// HTTP layer: static UI, conversation history, and one streaming chat endpoint (Server-Sent Events).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runTurn, safeTimezone } from "./agent.ts";
import { loadDeps, env } from "./config.ts";
import { loadDemoHistory } from "./demo.ts";

const deps = loadDeps();

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const STATIC: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/lib/marked.esm.js", "text/javascript"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.es.mjs", "text/javascript"],
  "/vendor/gsap.js": ["node_modules/gsap/dist/gsap.min.js", "text/javascript"],
  "/vendor/lenis.js": ["node_modules/lenis/dist/lenis.min.js", "text/javascript"],
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 32_000): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("body too large");
  }
  return JSON.parse(body);
}

// Each browser sends a random id it generated; history is filed under it. It separates visitors on a
// public deployment but it is not a login: anyone holding the id can read that history.
function storeFor(req: IncomingMessage) {
  const id = req.headers["x-visitor"];
  return deps.store.scoped(typeof id === "string" && /^[\w-]{8,64}$/.test(id) ? id : "local");
}

// ponytail: in-memory per-address daily cap so a public demo cannot drain the free API quotas;
// resets on restart. Move to the database (or real auth) if this ever serves real users.
const DAILY_TURNS = 60;
const turnsToday = new Map<string, { day: string; count: number }>();
function overDailyCap(req: IncomingMessage): boolean {
  const address = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  const entry = turnsToday.get(address);
  if (!entry || entry.day !== day) {
    turnsToday.set(address, { day, count: 1 });
    return false;
  }
  return ++entry.count > DAILY_TURNS;
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  let input: { text?: unknown; conversationId?: unknown; timezone?: unknown; locale?: unknown };
  try {
    input = (await readJson(req)) as typeof input;
  } catch {
    return json(res, 400, { error: "Invalid JSON body." });
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 4000) return json(res, 400, { error: "Message must be 1 to 4000 characters." });
  if (overDailyCap(req)) return json(res, 429, { error: `This demo allows ${DAILY_TURNS} questions a day per visitor. Come back tomorrow.` });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no", // tell hosting proxies not to buffer the stream
  });
  const turn = runTurn(
    { ...deps, store: storeFor(req) },
    {
      text,
      conversationId: Number.isInteger(input.conversationId) ? (input.conversationId as number) : undefined,
      timezone: typeof input.timezone === "string" ? input.timezone : undefined,
      locale: typeof input.locale === "string" ? input.locale : undefined,
    },
  );
  // ponytail: a closed tab does not cancel the turn; it finishes and is saved. Add AbortSignal plumbing if that wastes quota.
  for await (const event of turn) {
    if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return res.writeHead(200, { "content-type": type }).end(await readFile(root(file)));
    }
    if (req.method === "GET" && url.pathname === "/api/conversations") return json(res, 200, storeFor(req).listConversations());
    const match = url.pathname.match(/^\/api\/conversations\/(\d+)$/);
    if (req.method === "GET" && match) return json(res, 200, storeFor(req).messages(Number(match[1])));
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res);
    if (req.method === "POST" && url.pathname === "/api/demo") {
      const timezone = safeTimezone(url.searchParams.get("tz") ?? undefined);
      return json(res, 200, { added: loadDemoHistory(storeFor(req), new Date(), timezone) });
    }
    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
    else res.end();
  }
});

// Local runs listen on this machine only; a host sets HOST=0.0.0.0 to accept outside traffic.
server.listen(env.port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Chat agent running at http://localhost:${env.port}  (model ${env.model}, fallback ${env.fallbackModel || "none"})`);
});
