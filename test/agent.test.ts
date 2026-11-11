import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { Store } from "../src/store.ts";
import { runTurn, type AgentEvent } from "../src/agent.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { openAICompatible, type Complete, type Chunk } from "../src/llm.ts";
import type { Search } from "../src/search.ts";

const NOW = new Date("2026-11-12T14:00:00Z");

// A fake model that plays back scripted turns: tool calls first, then a final text answer.
function scripted(turns: ({ calls: object[] } | { text: string })[], seen: unknown[][] = []): Complete {
  let i = 0;
  return async function* ({ messages }): AsyncIterable<Chunk> {
    seen.push(structuredClone(messages));
    const t = turns[i++];
    if ("text" in t) {
      for (const part of t.text.match(/.{1,8}/gs) ?? []) yield { type: "text", delta: part };
      yield { type: "message", model: "fake", tokens: 10, message: { role: "assistant", content: t.text, refusal: null } };
    } else {
      const tool_calls = t.calls.map((args, k) => ({ id: `call_${i}_${k}`, type: "function" as const, function: { name: "web_search", arguments: JSON.stringify(args) } }));
      yield { type: "message", model: "fake", tokens: 10, message: { role: "assistant", content: null, refusal: null, tool_calls } };
    }
  };
}

const fakeSearch: Search = async ({ query }) => [
  { url: `https://${query.split(" ")[0].toLowerCase()}.com/pricing`, title: `${query} page`, published: "2026-11-01", text: `Excerpt about ${query}` },
  { url: "https://shared.example/roundup", title: "Roundup", published: null, text: "Covers everything" },
];

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

test("parallel searches, global source numbering, invalid citations dropped, answer stored", async () => {
  const store = new Store(":memory:");
  const seen: unknown[][] = [];
  const complete = scripted([{ calls: [{ query: "Supabase pricing" }, { query: "Neon pricing", fresh: true }] }, { text: "Supabase is $25 【1†source】, Neon is cheaper [3][2], and [9] is made up." }], seen);
  const events = await collect(runTurn({ store, complete, search: fakeSearch, now: () => NOW }, { text: "Compare Supabase and Neon pricing", timezone: "Europe/London" }));

  const searches = events.filter((e) => e.type === "search");
  assert.equal(searches.length, 2);
  // The shared URL keeps one number across both searches.
  assert.deepEqual(searches.flatMap((s) => s.type === "search" ? s.results.map((r) => r.n) : []), [1, 2, 3, 2]);

  // Both tool results go back before the next model call, each tied to its call id.
  const second = seen[1] as { role: string; tool_call_id?: string }[];
  assert.deepEqual(second.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ["call_1_0", "call_1_1"]);

  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.deepEqual(done.sources.map((s) => s.n), [1, 2, 3]);
  const [, stored] = store.messages(1);
  assert.equal(stored.content, "Supabase is $25 [1], Neon is cheaper [3][2], and is made up.");
  assert.equal(stored.sources.length, 3);
});

test("the date goes into the user turn, the system prompt stays fixed, and recall is injected", async () => {
  const store = new Store(":memory:");
  const old = store.createConversation("Postgres hosting", new Date("2026-11-03T10:00:00Z"));
  store.addMessage({ conversationId: old, role: "user", content: "Cheapest Postgres hosting?", at: new Date("2026-11-03T10:00:00Z"), timezone: "Europe/London" });
  store.addMessage({ conversationId: old, role: "assistant", content: "Neon's free plan.", at: new Date("2026-11-03T10:01:00Z"), timezone: "Europe/London" });

  const seen: unknown[][] = [];
  const events = await collect(runTurn(
    { store, complete: scripted([{ text: "On 3 Nov I said Neon's free plan." }], seen), search: fakeSearch, now: () => NOW },
    { text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", timezone: "Europe/London" },
  ));
  const [system, user] = seen[0] as { role: string; content: string }[];
  assert.equal(system.content, SYSTEM_PROMPT);
  assert.match(user.content, /Now: Thursday 12 November 2026/);
  assert.match(user.content, /Lookup: .*Found 1 past conversation/);
  assert.match(user.content, /Neon's free plan/);
  assert.ok(events.some((e) => e.type === "status" && e.text.startsWith("Recalled")));
});

test("search budget is enforced and the last model call cannot search", async () => {
  const store = new Store(":memory:");
  const many = Array.from({ length: 7 }, (_, i) => ({ query: `item${i} pricing` }));
  let calls = 0;
  const search: Search = async (a) => (calls++, fakeSearch(a));
  const seen: { role: string; content: string }[][] = [];
  const events = await collect(runTurn(
    { store, complete: scripted([{ calls: many }, { calls: many }, { text: "Done [1]." }], seen as unknown[][]), search, now: () => NOW },
    { text: "price check for many items" },
  ));
  assert.equal(calls, 10); // 7 in round one, then only 3 more fit the budget
  assert.equal(seen[2].filter((m) => m.role === "tool" && /budget/.test(m.content)).length, 4);
  assert.equal(seen.length, 3); // two search rounds, then a forced answer
  assert.equal(events.at(-1)!.type, "done");
});

test("a 429 switches to the fallback model before any text is shown", async () => {
  const models: string[] = [];
  const client = {
    chat: {
      completions: {
        stream(params: { model: string }) {
          models.push(params.model);
          if (params.model === "primary") throw new OpenAI.RateLimitError(429, undefined, "limit", new Headers({ "retry-after": "5" }));
          return {
            async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "hi" } }] }; },
            finalChatCompletion: async () => ({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { total_tokens: 3 } }),
          };
        },
      },
    },
  } as unknown as Pick<OpenAI, "chat">;
  const complete = openAICompatible({ baseURL: "", apiKey: "", model: "primary", fallbackModel: "backup", client });
  const chunks: Chunk[] = [];
  for await (const c of complete({ messages: [], allowTools: true })) chunks.push(c);
  assert.deepEqual(models, ["primary", "backup"]);
  assert.equal(chunks[0].type, "status");
  assert.deepEqual(chunks.filter((c) => c.type === "text").map((c) => c.type === "text" && c.delta), ["hi"]);
});

test("a malformed tool call rejected by the host is retried before failing", async () => {
  let n = 0;
  const client = {
    chat: { completions: { stream() {
      if (n++ === 0) throw new OpenAI.APIError(undefined, { code: "tool_use_failed" }, "tool call validation failed: attempted to call tool 'webollar'", undefined);
      return {
        async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "ok" } }] }; },
        finalChatCompletion: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { total_tokens: 1 } }),
      };
    } } },
  } as unknown as Pick<OpenAI, "chat">;
  const chunks: Chunk[] = [];
  for await (const c of openAICompatible({ baseURL: "", apiKey: "", model: "m", client })({ messages: [], allowTools: true })) chunks.push(c);
  assert.equal(n, 2);
  assert.equal(chunks.at(-1)!.type, "message");
});

test("a rate-limited model stays parked across calls instead of being retried first", async () => {
  const models: string[] = [];
  const client = {
    chat: { completions: { stream(params: { model: string }) {
      models.push(params.model);
      if (params.model === "primary") throw new OpenAI.RateLimitError(429, undefined, "limit", new Headers({ "retry-after": "30" }));
      return {
        async *[Symbol.asyncIterator]() {},
        finalChatCompletion: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { total_tokens: 1 } }),
      };
    } } },
  } as unknown as Pick<OpenAI, "chat">;
  const complete = openAICompatible({ baseURL: "", apiKey: "", model: "primary", fallbackModel: "backup", client });
  for (let i = 0; i < 2; i++) for await (const _ of complete({ messages: [], allowTools: true }));
  assert.deepEqual(models, ["primary", "backup", "backup"]);
});
