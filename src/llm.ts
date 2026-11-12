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

export function openAICompatible(cfg: {
  baseURL: string;
  apiKey: string;
  model: string;
  fallbackModel?: string;
  client?: Pick<OpenAI, "chat">; // injectable for tests
}): Complete {
  const client = cfg.client ?? new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, maxRetries: 0, timeout: 60_000 });
  const models = [cfg.model, ...(cfg.fallbackModel && cfg.fallbackModel !== cfg.model ? [cfg.fallbackModel] : [])];
  const parkedUntil = new Map<string, number>(); // model -> when its rate limit resets (shared by all turns)

  return async function* complete({ messages, allowTools }) {
    const avoid = new Set<string>(); // models that produced a malformed tool call during this call
    let badToolCalls = 0;
    let serverErrors = 0;

    while (true) {
      const usable = avoid.size < models.length ? models.filter((m) => !avoid.has(m)) : models;
      const model = usable.find((m) => (parkedUntil.get(m) ?? 0) <= Date.now());
      if (!model) {
        const wait = Math.min(...usable.map((m) => parkedUntil.get(m)!)) - Date.now();
        if (wait > MAX_WAIT_MS) throw new FriendlyError("The free model tier is rate-limited right now. Please try again in a minute.");
        if (wait >= 3000) yield { type: "status", text: `Free-tier limit reached, waiting ${Math.ceil(wait / 1000)}s` };
        await sleep(wait);
        continue;
      }

      let streamedText = false;
      try {
        const stream = client.chat.completions.stream({
          model,
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
        yield { type: "message", message: final.choices[0].message, model, tokens: final.usage?.total_tokens ?? 0 };
        return;
      } catch (err) {
        if (streamedText) throw err; // never retry once the user has seen part of an answer
        if (err instanceof OpenAI.RateLimitError) {
          const retryAfterS = Number(err.headers?.get("retry-after")) || 20;
          parkedUntil.set(model, Date.now() + retryAfterS * 1000);
          if (usable.some((m) => (parkedUntil.get(m) ?? 0) <= Date.now())) {
            yield { type: "status", text: "Free-tier limit reached, switching model" };
          }
          continue;
        }
        if (err instanceof OpenAI.APIError && BAD_TOOL_CALL.test(err.message) && badToolCalls < 2) {
          if (badToolCalls++ === 1) avoid.add(model); // second glitch in a row: let the other model try
          continue;
        }
        if (err instanceof OpenAI.AuthenticationError) throw new FriendlyError("The model API key was rejected. Check LLM_API_KEY in .env.");
        const serverSide = err instanceof OpenAI.APIConnectionError || (err instanceof OpenAI.APIError && (err.status ?? 0) >= 500);
        if (serverSide && serverErrors++ === 0) {
          await sleep(1000);
          continue;
        }
        throw err;
      }
    }
  };
}
