// Sample history for first-time visitors. The memory questions ("what did I ask you on 3 November?")
// need past conversations, which a new visitor does not have. demo/history.json holds three real
// agent runs; this files them under the visitor on the dates the sample questions point at.
import { readFileSync } from "node:fs";
import type { Store, Source } from "./store.ts";
import { resolveDates } from "./recall.ts";

interface DemoConversation {
  when: string; // a date phrase, resolved against today: "on Monday", "on 3 November"
  question: string;
  answer: string;
  sources: Source[];
}

const titleOf = (q: string) => (q.length > 60 ? q.slice(0, 57).trimEnd() + "…" : q);

// Returns how many conversations were added (0 if this visitor already has them).
export function loadDemoHistory(store: Store, now: Date, timezone: string): number {
  const demo = JSON.parse(readFileSync(new URL("../demo/history.json", import.meta.url), "utf8")) as DemoConversation[];
  const existing = new Set(store.listConversations().map((c) => c.title));
  let added = 0;
  for (const d of demo) {
    const date = resolveDates(d.when, now, timezone)[0]?.dates[0];
    if (!date || existing.has(titleOf(d.question))) continue;
    const at = new Date(`${date}T10:00:00Z`);
    const conversationId = store.createConversation(titleOf(d.question), at);
    store.addMessage({ conversationId, role: "user", content: d.question, at, timezone: "UTC" });
    const messageId = store.addMessage({ conversationId, role: "assistant", content: d.answer, at, timezone: "UTC" });
    store.addSources(messageId, d.sources);
    added++;
  }
  return added;
}
