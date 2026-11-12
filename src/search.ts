// The agent's one tool: web search. Exa is the index: fast, query-relevant excerpts with publish dates,
// and a publish-date filter (for "since Tuesday"). Firecrawl, when configured, reads a named site's
// page live in a real browser (pricing pages are often rendered by JavaScript and edited in place),
// and each provider stands in for the other when it fails or finds nothing.
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

const cleanDomain = (d: string) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const mdy = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

// The lines of a long page most relevant to the query, kept in page order, up to `max` characters.
// Lines are scored by the query words they contain (rarer words count more); for price questions, lines
// with prices score higher too. Keeps a whole rendered pricing page down to the part the model needs.
export function excerpt(markdown: string, query: string, max: number, siteWords: string[] = []): string {
  // The site's own name (e.g. "neon" on neon.com) is on every line of its pages, so it is not a signal.
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !siteWords.includes(w));
  const wantsPrice = /pric|cost|plan|seat|tier|\$|per month/i.test(query);
  const lines = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> their text
    .split(/\n+/)
    .map((l) => l.replace(/[#*_>`|]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2 && !/^[-:\s]+$/.test(l));
  // A word on most lines (usually the product's own name) says little about any one line.
  const lowered = lines.map((l) => l.toLowerCase());
  const weight = new Map(words.map((w) => [w, lowered.filter((l) => l.includes(w)).length > lines.length * 0.3 ? 0.25 : 1]));
  const scored = lines.map((line, i) => {
    let score = words.reduce((sum, w) => sum + (lowered[i].includes(w) ? weight.get(w)! : 0), 0);
    if (wantsPrice && /[$€£₹]\s?\d|\d\s?(\/|per)\s?(mo|month|user|seat|year)/i.test(line)) score += 2;
    return { line, i, score };
  });
  const top = Math.max(0, ...scored.map((x) => x.score));
  const picked: typeof scored = [];
  let length = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (picked.length && (x.score === 0 || x.score < top / 2)) break;
    if (length + x.line.length > max) continue;
    picked.push(x);
    length += x.line.length + 3;
  }
  if (!picked.length) return markdown.replace(/\s+/g, " ").trim().slice(0, max);
  return picked.sort((a, b) => a.i - b.i).map((x) => x.line).join(" … ");
}

export function firecrawlSearch(apiKey: string): Search {
  return async ({ query, published_after, published_before, domains, fresh }) => {
    const live = !!(fresh && domains?.length);
    const siteWords = (domains ?? []).flatMap((d) => cleanDomain(d).toLowerCase().split(/[.-]/));
    const range = [published_after && `cd_min:${mdy(published_after)}`, published_before && `cd_max:${mdy(published_before)}`].filter(Boolean);
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        limit: live ? 2 : RESULTS_PER_SEARCH,
        ...(domains?.length ? { includeDomains: domains.map(cleanDomain) } : {}),
        ...(range.length ? { tbs: `cdr:1,${range.join(",")}` } : {}),
        // Rendered page text; a live read skips Firecrawl's cache so an edited page is seen as it is now.
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true, ...(live ? { maxAge: 0 } : {}) },
      }),
      signal: AbortSignal.timeout(live ? 45_000 : 25_000),
    });
    if (!res.ok) throw new Error(`Firecrawl returned HTTP ${res.status}`);
    type Item = { url: string; title?: string; description?: string; markdown?: string; date?: string; metadata?: { publishedTime?: string; title?: string } };
    const body = (await res.json()) as { data?: Item[] | { web?: Item[] } };
    const items = Array.isArray(body.data) ? body.data : (body.data?.web ?? []);
    const hits = items.map((r) => {
      const date = r.metadata?.publishedTime ?? r.date;
      return {
        url: r.url,
        title: (r.title || r.metadata?.title || new URL(r.url).hostname).trim(),
        published: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString().slice(0, 10) : null,
        text: excerpt(r.markdown || r.description || "", query, live ? 700 : EXCERPT_CHARS, siteWords),
      };
    });
    // Firecrawl's date filter is loose; drop results whose stated date is outside the range asked for.
    const from = published_after?.slice(0, 10), to = published_before?.slice(0, 10);
    return hits.filter((h) => !h.published || ((!from || h.published >= from) && (!to || h.published <= to)));
  };
}

// Which provider answers a search: Firecrawl first for a live read of a named site, Exa first otherwise;
// the other one takes over if the first fails or finds nothing.
export function webSearch(exa: Search, firecrawl?: Search): Search {
  return async (args) => {
    const [first, second] = firecrawl && args.fresh && args.domains?.length ? [firecrawl, exa] : [exa, firecrawl];
    try {
      const hits = await first(args);
      if (hits.length || !second) return hits;
    } catch (err) {
      if (!second) throw err;
      console.error(`Search provider failed, trying the other one: ${(err as Error).message}`);
    }
    return second(args);
  };
}
