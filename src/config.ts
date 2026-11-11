// Configuration from .env, shared by the server and the seed script.
import { Store } from "./store.ts";
import type { Deps } from "./agent.ts";
import { openAICompatible } from "./llm.ts";
import { exaSearch } from "./search.ts";

try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the real environment
}

export const env = {
  baseURL: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1",
  apiKey: process.env.LLM_API_KEY ?? "",
  model: process.env.LLM_MODEL || "qwen/qwen3.8-27b",
  fallbackModel: process.env.LLM_FALLBACK_MODEL ?? "openai/gpt-oss-120b",
  exaKey: process.env.EXA_API_KEY ?? "",
  port: Number(process.env.PORT) || 3000,
};
const missing = [!env.apiKey && "LLM_API_KEY", !env.exaKey && "EXA_API_KEY"].filter(Boolean);
if (missing.length) {
  console.error(`Missing ${missing.join(" and ")}. Copy .env.example to .env and fill it in (see README).`);
  process.exit(1);
}

export function loadDeps(): Deps {
  return {
    store: new Store(process.env.DB_PATH || "data/chat.db"),
    complete: openAICompatible({ ...env, fallbackModel: env.fallbackModel || undefined }),
    search: exaSearch(env.exaKey),
    log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  };
}

