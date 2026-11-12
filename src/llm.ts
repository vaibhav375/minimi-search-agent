// Model client for any OpenAI-compatible endpoint (Groq by default; NVIDIA, OpenRouter or a local
// Ollama work by changing env vars). Free tiers rate-limit per model, so a 429 parks that model
// until its limit resets (remembered across turns) and the call moves to the fallback model; if
// both are parked, it waits with a visible status instead of failing.
import OpenAI from "openai";
import { SEARCH_TOOL } from "./prompt.ts";

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionMessage;

export type Chunk =
  | { type: "text"; delta: string }
  | { type: "status"; text: string }
  | { type: "message"; message: AssistantMessage; model: string; tokens: number };

export type Complete = (req: { messages: Message[]; allowTools: boolean }) => AsyncIterable<Chunk>;

export class FriendlyError extends Error {}

const MAX_WAIT_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Groq rejects a generation whose tool call is malformed (garbled name or arguments, or a call when
// tools are off), mid-stream and without an HTTP status. It is a sampling glitch, so it is retried.
const BAD_TOOL_CALL = /tool_use_failed|tool call validation|tool choice is none/i;

interface Route {
  id: string;
  model: string;
  client: Pick<OpenAI, "chat">;
}

// The main model, then a fallback on the same host, then any extra hosts (for example ASI:One).
// A rate-limited route is parked until its limit resets (remembered across turns); any other failure
// before text has been shown moves this call on to the next route.
export function openAICompatible(cfg: {
  baseURL: string;
  apiKey: string;
  model: string;
  fallbackModel?: string;
  extra?: { baseURL: string; apiKey: string; model: string; client?: Pick<OpenAI, "chat"> }[];
  client?: Pick<OpenAI, "chat">; // injectable for tests
}): Complete {
  const make = (baseURL: string, apiKey: string) => new OpenAI({ baseURL, apiKey, maxRetries: 0, timeout: 60_000 });
  const main = cfg.client ?? make(cfg.baseURL, cfg.apiKey);
  const routes: Route[] = [
    { id: `${cfg.baseURL} ${cfg.model}`, model: cfg.model, client: main },
    ...(cfg.fallbackModel && cfg.fallbackModel !== cfg.model ? [{ id: `${cfg.baseURL} ${cfg.fallbackModel}`, model: cfg.fallbackModel, client: main }] : []),
    ...(cfg.extra ?? []).map((e) => ({ id: `${e.baseURL} ${e.model}`, model: e.model, client: e.client ?? make(e.baseURL, e.apiKey) })),
  ];
  const parkedUntil = new Map<string, number>(); // route -> when its rate limit resets

  return async function* complete({ messages, allowTools }) {
    const failed = new Set<string>(); // routes that errored during this call
    let badToolCalls = 0;
    let serverErrors = 0;
    let lastError: unknown;

    while (true) {
      const usable = routes.filter((r) => !failed.has(r.id));
      if (!usable.length) {
        if (lastError instanceof OpenAI.AuthenticationError) throw new FriendlyError("A model API key was rejected. Check the keys in .env.");
        throw lastError;
      }
      const route = usable.find((r) => (parkedUntil.get(r.id) ?? 0) <= Date.now());
      if (!route) {
        const wait = Math.min(...usable.map((r) => parkedUntil.get(r.id)!)) - Date.now();
        if (wait > MAX_WAIT_MS) throw new FriendlyError("The free model tier is rate-limited right now. Please try again in a minute.");
        if (wait >= 3000) yield { type: "status", text: `Free-tier limit reached, waiting ${Math.ceil(wait / 1000)}s` };
        await sleep(wait);
        continue;
      }

      let streamedText = false;
      try {
        const stream = route.client.chat.completions.stream({
          model: route.model,
          messages,
          // On the last step the tool is withheld entirely: some models call it even under tool_choice "none".
          ...(allowTools ? { tools: [SEARCH_TOOL], tool_choice: "auto" as const } : {}),
          max_tokens: 3000,
          temperature: 0.3,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            streamedText = true;
            yield { type: "text", delta };
          }
        }
        const final = await stream.finalChatCompletion();
        yield { type: "message", message: final.choices[0].message, model: route.model, tokens: final.usage?.total_tokens ?? 0 };
        return;
      } catch (err) {
        if (streamedText) throw err; // never retry once the user has seen part of an answer
        const othersReady = () => usable.some((r) => r !== route && (parkedUntil.get(r.id) ?? 0) <= Date.now());
        if (err instanceof OpenAI.RateLimitError) {
          const retryAfterS = Number(err.headers?.get("retry-after")) || 20;
          parkedUntil.set(route.id, Date.now() + retryAfterS * 1000);
          if (othersReady()) yield { type: "status", text: "Free-tier limit reached, switching model" };
          continue;
        }
        // One retry on the same route for a garbled tool call or a server hiccup; after that, move on.
        if (err instanceof OpenAI.APIError && BAD_TOOL_CALL.test(err.message) && badToolCalls++ === 0) continue;
        const serverSide = err instanceof OpenAI.APIConnectionError || (err instanceof OpenAI.APIError && (err.status ?? 0) >= 500);
        if (serverSide && serverErrors++ === 0) {
          await sleep(1000);
          continue;
        }
        console.error(`Model ${route.model} failed: ${(err as Error).message}`);
        failed.add(route.id);
        lastError = err;
        if (othersReady()) yield { type: "status", text: "Model unavailable, switching model" };
      }
    }
  };
}
