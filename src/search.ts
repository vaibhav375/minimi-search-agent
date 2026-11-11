// The agent's one tool: web search, backed by Exa. Exa returns query-relevant excerpts and a
// published date in the same call, filters by publish date (for "since Tuesday") and can bypass
// its cache (for evergreen pages such as pricing, whose publish date never changes).
import { z } from "zod";

export const SearchArgs = z.object({
  query: z.string().trim().min(2).max(300),
  published_after: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date like 2026-11-03")
    .optional(),
  domains: z.array(z.string().min(3).max(100)).max(5).optional(),
  fresh: z.boolean().optional(),
});
export type SearchArgs = z.infer<typeof SearchArgs>;

export interface SearchHit {
  url: string;
  title: string;
  published: string | null; // YYYY-MM-DD when the page states one
  text: string;
}

// published_before is for internal callers only (the seed script); the model's tool schema does not offer it.
export type Search = (args: SearchArgs & { published_before?: string }) => Promise<SearchHit[]>;

const RESULTS_PER_SEARCH = 3; // ponytail: small on purpose; free model tiers cap tokens per minute
const EXCERPT_CHARS = 400;

export function exaSearch(apiKey: string): Search {
  return async ({ query, published_after, published_before, domains, fresh }) => {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: RESULTS_PER_SEARCH,
        ...(published_after ? { startPublishedDate: new Date(published_after).toISOString() } : {}),
        ...(published_before ? { endPublishedDate: new Date(published_before).toISOString() } : {}),
        ...(domains?.length ? { includeDomains: domains.map((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "")) } : {}),
        // A live re-read costs seconds, so it is honoured only for a specific site (a vendor's pricing page),
        // where a cached copy could hide an edit. News searches are fresh enough from the index.
        contents: { highlights: { maxCharacters: EXCERPT_CHARS }, ...(fresh && domains?.length ? { maxAgeHours: 0 } : {}) },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`search service returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      results?: { url: string; title?: string | null; publishedDate?: string | null; highlights?: string[]; text?: string }[];
    };
    return (body.results ?? []).map((r) => ({
      url: r.url,
      title: (r.title || new URL(r.url).hostname).trim(),
      published: r.publishedDate ? r.publishedDate.slice(0, 10) : null,
      text: (r.highlights?.join(" … ") || r.text || "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS + 100),
    }));
  };
}
