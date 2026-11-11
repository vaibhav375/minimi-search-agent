// HTTP layer: static UI, conversation history, and one streaming chat endpoint (Server-Sent Events).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runTurn } from "./agent.ts";
import { loadDeps, env } from "./config.ts";

const deps = loadDeps();

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const STATIC: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/lib/marked.esm.js", "text/javascript"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.es.mjs", "text/javascript"],
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

async function chat(req: IncomingMessage, res: ServerResponse) {
  let input: { text?: unknown; conversationId?: unknown; timezone?: unknown; locale?: unknown };
  try {
    input = (await readJson(req)) as typeof input;
  } catch {
    return json(res, 400, { error: "Invalid JSON body." });
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 4000) return json(res, 400, { error: "Message must be 1 to 4000 characters." });

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const turn = runTurn(deps, {
    text,
    conversationId: Number.isInteger(input.conversationId) ? (input.conversationId as number) : undefined,
    timezone: typeof input.timezone === "string" ? input.timezone : undefined,
    locale: typeof input.locale === "string" ? input.locale : undefined,
  });
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
    if (req.method === "GET" && url.pathname === "/api/conversations") return json(res, 200, deps.store.listConversations());
    const match = url.pathname.match(/^\/api\/conversations\/(\d+)$/);
    if (req.method === "GET" && match) return json(res, 200, deps.store.messages(Number(match[1])));
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res);
    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
    else res.end();
  }
});

server.listen(env.port, "127.0.0.1", () => {
  console.log(`Chat agent running at http://localhost:${env.port}  (model ${env.model}, fallback ${env.fallbackModel || "none"})`);
});
