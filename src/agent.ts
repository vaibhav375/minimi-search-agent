// One chat turn: recall (code) -> model <-> web_search loop (capped) -> cited answer -> stored.
// It is an async generator of UI events, so the HTTP layer only forwards them and tests can
// drive it with a fake model and a fake search.
import type { Store, Source } from "./store.ts";
import type { Complete, Message } from "./llm.ts";
import { FriendlyError } from "./llm.ts";
import { SearchArgs, type Search } from "./search.ts";
import { recall } from "./recall.ts";
import { SYSTEM_PROMPT, contextBlock } from "./prompt.ts";

export type AgentEvent =
  | { type: "conversation"; id: number; title: string }
  | { type: "status"; text: string }
  | { type: "search"; query: string; results: Omit<Source, "query">[] }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: number; sources: Source[] }
  | { type: "error"; message: string };

export interface Deps {
  store: Store;
  complete: Complete;
  search: Search;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TurnInput {
  conversationId?: number;
  text: string;
  timezone?: string;
  locale?: string;
}

const MAX_HOPS = 3; // model calls per turn (at most two search rounds); the last one may not call tools
const MAX_SEARCHES = 10; // ponytail: hard cap per turn so one question cannot burn the free daily quota
const HISTORY_MESSAGES = 10; // ponytail: older turns are dropped, not summarised; add compaction if chats get long

export function safeTimezone(tz?: string): string {
  try {
    if (tz) return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {}
  return "UTC";
}

const stripCitations = (s: string) => s.replace(/\s?\[\d+\]/g, "");

// Some open models, when they want to search but the tool is not on offer (or they fumble the format),
// write the call out as text: "<tool_call> <function=web_search> <parameter=query> ... </tool_call>".
const LEAKED_CALL = /^<(tool_call|function[=\s>])/i;
const LEAKED_MARKUP = /<tool_call>[\s\S]*?(<\/tool_call>|$)|<function=[\s\S]*?(<\/function>|$)/gi;

// Turns a search request written as text back into a real tool call, so it can still be run.
export function parseLeakedCalls(text: string) {
  return text
    .split(/<function=/i)
    .slice(1)
    .filter((block) => /^web_search>/i.test(block))
    .map((block, i) => {
      const args: Record<string, unknown> = {};
      for (const m of block.matchAll(/<parameter=([\w-]+)>([\s\S]*?)(?=<parameter=|<\/parameter>|<\/function>|<\/tool_call>|$)/gi)) {
        const raw = m[2].trim();
        const value = /^(\[.*\]|true|false)$/s.test(raw) ? JSON.parse(raw) : raw;
        if (value !== "" && !(Array.isArray(value) && !value.length)) args[m[1]] = value;
      }
      return { id: `text_call_${i}`, type: "function" as const, function: { name: "web_search", arguments: JSON.stringify(args) } };
    })
    .filter((c) => c.function.arguments !== "{}");
}

// Added before the last model call of a turn: models answer instead of asking for more searches.
const FINAL_STEP =
  "(Note from the app, not the user: you have used all the searches for this question. Write your final answer now from the search results above, citing them. If something is still missing, say what you could not verify. Do not call tools.)";
// Some open models cite as 【1】 or 【1†source】; normalise to [1] so one citation format reaches the UI.
const normaliseCitations = (s: string) => s.replace(/【(\d+)(?:†[^】]*)?】/g, "[$1]");

export async function* runTurn(deps: Deps, input: TurnInput): AsyncGenerator<AgentEvent> {
  const { store } = deps;
  const started = Date.now();
  const now = deps.now?.() ?? new Date();
  const timezone = safeTimezone(input.timezone);
  const text = input.text.trim();

  // 1. Conversation and history (text only: earlier turns' search results are not resent).
  let conversationId = input.conversationId;
  if (!conversationId || !store.conversationExists(conversationId)) {
    conversationId = store.createConversation(text.length > 60 ? text.slice(0, 57).trimEnd() + "…" : text, now);
  }
  yield { type: "conversation", id: conversationId, title: store.conversationTitle(conversationId) };
  const history: Message[] = store
    .messages(conversationId, HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.role === "assistant" ? stripCitations(m.content) : m.content }));
  // Saved before the model runs, so a question whose answer fails is still in history and recall.
  store.addMessage({ conversationId, role: "user", content: text, at: now, timezone });

  // 2. Recall past conversations, in code, before the model runs.
  const memory = recall(store, text, now, timezone, conversationId, input.locale);
  if (memory) yield { type: "status", text: memory.shortStatus };

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: `${contextBlock(now, timezone, memory?.block)}\n\n${text}` },
  ];

  // 3. Tool loop. Sources are numbered across the whole turn so [n] in the answer is unambiguous.
  const sources: Source[] = [];
  const numberOf = new Map<string, number>();
  let answer = "";
  let leakRetries = 0;
  let searches = 0;
  let tokens = 0;
  let model = "";
  try {
    // One model call, streamed. A search request written out as text is held back, never shown.
    async function* callModel(allowTools: boolean) {
      let message;
      let text = "";
      let shown = false;
      let leaked = false;
      const show = function* (delta: string) {
        if (!shown && answer && !answer.endsWith("\n")) {
          answer += "\n\n";
          yield { type: "text" as const, delta: "\n\n" };
        }
        shown = true;
        answer += delta;
        yield { type: "text" as const, delta };
      };
      for await (const chunk of deps.complete({ messages, allowTools })) {
        if (chunk.type === "status") yield chunk;
        else if (chunk.type === "message") {
          message = chunk.message;
          tokens += chunk.tokens;
          model = chunk.model;
        } else {
          text += chunk.delta;
          if (leaked) continue;
          if (shown) {
            yield* show(chunk.delta);
            continue;
          }
          const start = text.trimStart();
          if (LEAKED_CALL.test(start)) leaked = true;
          else if (!(start.length < 12 && start.startsWith("<"))) yield* show(text); // "<" could still become a leak: wait
        }
      }
      if (!shown && !leaked && text.trim()) yield* show(text);
      return { message, text, leaked };
    }

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const allowTools = hop < MAX_HOPS - 1 && searches < MAX_SEARCHES;
      if (!allowTools && hop > 0 && !messages.some((m) => m.content === FINAL_STEP)) messages.push({ role: "user", content: FINAL_STEP });
      const { message, text, leaked } = yield* callModel(allowTools);
      let calls = (message?.tool_calls ?? []).filter((c) => c.type === "function");
      if (leaked && !calls.length && allowTools) calls = parseLeakedCalls(text);
      if (leaked && !calls.length) {
        // Asked for a search it cannot have (or wrote nothing usable): try once more, then stop cleanly.
        if (leakRetries++ === 0) {
          if (!messages.some((m) => m.content === FINAL_STEP)) messages.push({ role: "user", content: FINAL_STEP });
          hop--;
          continue;
        }
        break;
      }
      if (!allowTools || !calls.length) break;

      messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
      const jobs = calls.map((call) => {
        const parsed = (() => {
          try {
            return SearchArgs.safeParse(JSON.parse(call.function.arguments || "{}"));
          } catch {
            return null;
          }
        })();
        if (!parsed?.success) return { call, error: "Invalid arguments: pass at least a 'query' string." };
        if (searches >= MAX_SEARCHES) return { call, error: "Search budget for this turn is used up. Answer with what you have." };
        searches++;
        return { call, args: parsed.data };
      });
      for (const j of jobs) {
        if (!j.args) continue;
        const notes = [j.args.published_after && `since ${j.args.published_after}`, j.args.fresh && j.args.domains?.length && "live", j.args.domains?.join(", ")].filter(Boolean);
        yield { type: "status", text: `Searching: ${j.args.query}${notes.length ? ` (${notes.join("; ")})` : ""}` };
      }

      const results = await Promise.all(
        jobs.map(async (j) => (j.args ? { ...j, hits: await deps.search(j.args).catch((e: Error) => e) } : j)),
      );
      for (const r of results) {
        let content: string;
        if (!("hits" in r) || !r.hits) content = r.error ?? "Error.";
        else if (r.hits instanceof Error) content = `Search failed (${r.hits.message}). Try a different query or answer with what you have.`;
        else if (!r.hits.length) content = "No results. Try a broader query.";
        else {
          const numbered = r.hits.map((h) => {
            let n = numberOf.get(h.url);
            if (!n) {
              n = sources.length + 1;
              numberOf.set(h.url, n);
              sources.push({ n, url: h.url, title: h.title, published: h.published, query: r.args!.query });
            }
            return { n, ...h };
          });
          yield { type: "search", query: r.args!.query, results: numbered.map(({ n, url, title, published }) => ({ n, url, title, published })) };
          content = numbered.map((h) => `[${h.n}] ${h.title} | ${h.url} | published ${h.published ?? "unknown"}\n${h.text}`).join("\n\n");
        }
        messages.push({ role: "tool", tool_call_id: r.call.id, content });
      }
    }
  } catch (err) {
    deps.log?.(`turn failed after ${Date.now() - started}ms: ${(err as Error).message}`);
    yield {
      type: "error",
      message: err instanceof FriendlyError ? err.message : "Something went wrong talking to the model. Please try again.",
    };
    return;
  }

  // 4. Keep only citations that point at a real source; store the answer with what it cited.
  const valid = new Set(sources.map((s) => s.n));
  const cleaned = normaliseCitations(answer.replace(LEAKED_MARKUP, "")).replace(/\s?\[(\d+)\]/g, (m, n) => (valid.has(Number(n)) ? m : "")).trim();
  if (!cleaned) {
    yield {
      type: "error",
      message: leakRetries
        ? "I ran out of searches before I could finish this answer. Ask again, or narrow the question."
        : "The model returned an empty answer. Please try again.",
    };
    return;
  }
  const cited = new Set([...cleaned.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const usedSources = sources.filter((s) => cited.has(s.n));
  const messageId = store.addMessage({ conversationId, role: "assistant", content: cleaned, at: deps.now?.() ?? new Date(), timezone });
  store.addSources(messageId, usedSources);
  deps.log?.(
    `turn conv=${conversationId} model=${model} recall=${memory ? "yes" : "no"} searches=${searches} sources=${sources.length} cited=${usedSources.length} tokens=${tokens} ${Date.now() - started}ms`,
  );
  yield { type: "done", messageId, sources: usedSources };
}
