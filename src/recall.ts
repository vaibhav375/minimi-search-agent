// Recall of past conversations. The agent's only tool is web search, so memory is not a tool:
// this runs in code before every model call, takes milliseconds, and hands the model a
// <memory> block that says plainly what was (or was not) found.
import * as chrono from "chrono-node";
import { type Store, type StoredMessage, localDate } from "./store.ts";

export interface DateRef {
  phrase: string;
  dates: string[]; // YYYY-MM-DD in the user's time zone, newest first
}

export interface Recall {
  status: string; // one line for the model (and, shortened, for the UI)
  shortStatus: string;
  block: string; // the full <memory> block
}

// ---- date arithmetic on YYYY-MM-DD strings (calendar days, no time zone involved) ----
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const weekdayMon0 = (d: string) => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function formatDay(d: string, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: style, day: "numeric", month: style, ...(style === "long" ? { year: "numeric" } : {}),
  }).format(new Date(d + "T00:00:00Z")).replace(",", "");
}

// The user's wall-clock "now" as a Date in this process's zone, so chrono reasons in the user's calendar.
function wallClock(now: Date, timezone: string): Date {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(now).map((x) => [x.type, Number(x.value)]),
  );
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
}

// Resolve every date expression in `text` to concrete past local dates.
// "on 3 November" -> that day (last year's if it is still ahead); "on Monday" -> the most recent past Monday;
// "last Tuesday" said on a Thursday -> both this week's and last week's Tuesday (it is ambiguous, so look up both);
// "last week" / "two weeks ago" -> that Monday-to-Sunday week; "in March" / "this month" -> that month.
export function resolveDates(text: string, now: Date, timezone: string, locale = "en-GB"): DateRef[] {
  const today = localDate(now, timezone);
  const parser = locale === "en-US" ? chrono.en : chrono.en.GB; // 3/11 is 3 Nov outside the US
  const refs: DateRef[] = [];
  for (const r of parser.parse(text, wallClock(now, timezone), { forwardDate: false })) {
    const phrase = r.text;
    const parsed = ymd(r.start.date());
    // A date still ahead this year ("on 20 November" said on the 12th) means last year's. Not for bare
    // weekdays: the parser may pick next week's Monday, which steps back by weeks, not a year.
    const yearGiven = r.start.isCertain("year");
    const base = !yearGiven && parsed > today ? String(Number(parsed.slice(0, 4)) - 1) + parsed.slice(4) : parsed;

    let dates: string[];
    if (r.start.isCertain("weekday") && !r.start.isCertain("day")) {
      let d = parsed;
      while (d >= today) d = addDays(d, -7); // the most recent one before today
      dates = [d];
      const weekStart = addDays(today, -weekdayMon0(today));
      if (/\blast\b/i.test(phrase) && d >= weekStart) dates.push(addDays(d, -7));
    } else if (/\bweeks?\b/i.test(phrase)) {
      const monday = addDays(base, -weekdayMon0(base));
      dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    } else if (/\bmonths?\b/i.test(phrase) || (r.start.isCertain("month") && !r.start.isCertain("day"))) {
      const first = base.slice(0, 8) + "01";
      dates = Array.from({ length: 31 }, (_, i) => addDays(first, i)).filter((d) => d.slice(0, 7) === first.slice(0, 7));
    } else {
      dates = [base];
    }
    dates = dates.filter((d) => d <= today).sort().reverse();
    if (dates.length) refs.push({ phrase, dates });
  }
  // "Is that still correct today?" names today only as the comparison point, not as the day to recall.
  const past = refs.filter((r) => r.dates.some((d) => d < today));
  return past.length ? past : refs;
}

// '"last Tuesday" means Tuesday 10 November 2026 or Tuesday 3 November 2026'
export function describeDates(refs: DateRef[]): string {
  return refs
    .map((r) => {
      const days = r.dates.length > 2 ? `${formatDay(r.dates.at(-1)!)} to ${formatDay(r.dates[0])}` : r.dates.map((d) => formatDay(d)).join(" or ");
      return `"${r.phrase}" means ${days}`;
    })
    .join("; ");
}

// Phrases that mean "this refers to something we said before". Biased towards firing: a wasted
// lookup costs milliseconds, a missed one makes the agent claim it has no memory.
const RECALL_CUE =
  /\b(i|we)\s+(asked|told|said|talked|discussed|shortlisted|compared|looked|chatted|mentioned|decided|picked|chose|researched)\b|\byou\s+(said|told|recommended|suggested|answered|mentioned|found|gave|listed|picked)\b|\b(did|have|had)\s+(i|we|you)\b|\b(earlier|previous|last|our|that)\s+(conversation|chat|discussion|answer|question|session|list|shortlist)\b|\blast time\b|\bsince then\b|\bstill (correct|true|accurate|valid|right|the case|current)\b|\bremember\b|\bany of (them|those|these)\b/i;

export const isRecall = (text: string) => RECALL_CUE.test(text);

const STOP = new Set(
  ("the and for are but not you your yours with this that those these was were what when where which who whom why how has have had " +
    "did does doing done can could would should will shall may might must any all some our ours they them their there then than " +
    "into from about since still today yesterday tomorrow ago last next week weeks month months year years day days asked ask told " +
    "said answer answers correct true changed change changes anything something shipped big new latest again also just like " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october " +
    "november december morning afternoon evening talked discussed shortlisted compared looked chatted mentioned remember earlier " +
    "previous conversation chat time is it its me my we us of on in at to by a an as or if so up out be been being do i " +
    "mon tue tues wed thu thur thurs fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec").split(" "),
);

export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [];
  return [...new Set(words.map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))].slice(0, 12);
}

const stripCitations = (s: string) => s.replace(/\s?\[\d+\]/g, "");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " …[truncated]" : s);

function renderConversation(title: string, messages: StoredMessage[], note: string): string {
  const day = messages[0] ? formatDay(messages[0].localDate) : "";
  const lines = messages.map((m) => {
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: m.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(m.createdAt));
    const who = m.role === "user" ? "User" : "Assistant";
    return `[${formatDay(m.localDate, "short")} ${time}] ${who}: ${clip(stripCitations(m.content), m.role === "user" ? 500 : 1200)}`;
  });
  const sources = messages.flatMap((m) => m.sources.map((s) => ({ ...s, retrieved: m.localDate })));
  const seen = new Set<string>();
  const sourceLines = sources
    .filter((s) => !seen.has(s.url) && seen.add(s.url))
    .slice(0, 8)
    .map((s) => `- ${s.title} | ${s.url}${s.published ? ` | published ${s.published}` : ""} | retrieved ${formatDay(s.retrieved, "short")}`);
  return [
    `<conversation title="${title.replaceAll('"', "'")}" date="${day}"${note ? ` note="${note}"` : ""}>`,
    ...lines,
    ...(sourceLines.length ? ["Sources the assistant used then:", ...sourceLines] : []),
    "</conversation>",
  ].join("\n");
}

const MAX_CONVERSATIONS = 2; // ponytail: fixed cap keeps the prompt inside free-tier token limits; rank smarter if users keep many same-day chats
const MAX_MESSAGES = 8;

export function recall(store: Store, text: string, now: Date, timezone: string, excludeConversationId?: number, locale?: string): Recall | null {
  if (!isRecall(text)) return null;
  const refs = resolveDates(text, now, timezone, locale);

  const terms = keywords(text);
  const allDates = [...new Set(refs.flatMap((r) => r.dates))];
  const resolved = describeDates(refs);

  let hits = allDates.length ? store.conversationsOnDates(allDates, excludeConversationId) : store.searchConversations(terms, excludeConversationId);
  let note = "";
  let status: string;
  let shortStatus: string;

  if (allDates.length && hits.length) {
    const scores = store.keywordScores(hits.map((h) => h.id), terms);
    // If some conversations on those dates match the topic, the others are noise: drop them.
    if (scores.size) hits = hits.filter((h) => scores.has(h.id));
    hits = hits.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
    const list = hits.slice(0, 5).map((h) => `"${h.title}" (${h.dates.map((d) => formatDay(d)).join(", ")})`).join("; ");
    status = `${resolved}. Found ${hits.length} past conversation${hits.length > 1 ? "s" : ""} on ${hits.length > 1 ? "those dates" : "that date"}: ${list}.` +
      (hits.length > MAX_CONVERSATIONS ? ` Showing the ${MAX_CONVERSATIONS} that best match the topic.` : "");
    shortStatus = `Recalled ${hits.slice(0, MAX_CONVERSATIONS).map((h) => `“${h.title}” (${formatDay(h.dates[0], "short")})`).join(", ")}`;
  } else if (allDates.length) {
    const nearest = store.nearestDates(allDates[0], excludeConversationId);
    const byTopic = store.searchConversations(terms, excludeConversationId, 1);
    status = `${resolved}. There are NO conversations on ${allDates.length > 1 ? "those dates" : "that date"}.` +
      (nearest.length ? ` Nearest dates that have conversations: ${nearest.map((n) => `${formatDay(n.date)} ("${n.titles.join('", "')}")`).join("; ")}.` : " The history is empty.") +
      (byTopic.length ? ` The closest match by topic is "${byTopic[0].title}" on ${byTopic[0].dates.map((d) => formatDay(d)).join(", ")}, shown below; it is NOT on the date the user gave, so say so.` : "");
    hits = byTopic;
    note = "closest topic match, not on the requested date";
    shortStatus = `No conversation on ${refs.map((r) => r.dates.map((d) => formatDay(d, "short")).join(" or ")).join(", ")}` + (byTopic.length ? ` — closest: “${byTopic[0].title}”` : "");
  } else if (hits.length) {
    status = `No date given; searched past conversations for: ${terms.join(", ") || "(no keywords)"}. Best matches: ${hits.map((h) => `"${h.title}" (${formatDay(h.dates[0])})`).join("; ")}.`;
    shortStatus = `Recalled “${hits[0].title}” (${formatDay(hits[0].dates[0], "short")})`;
  } else {
    status = `No date given and no past conversation matches: ${terms.join(", ") || "(no keywords)"}. Tell the user you could not find it.`;
    shortStatus = "No matching past conversation";
  }

  const conversations = hits.slice(0, MAX_CONVERSATIONS).map((h) => {
    const all = store.messages(h.id);
    const onDay = allDates.length && !note ? all.filter((m) => allDates.includes(m.localDate)) : all;
    return renderConversation(h.title, (onDay.length ? onDay : all).slice(0, MAX_MESSAGES), note);
  });

  // Weaker models skip the date filter unless told the exact value; spell it out.
  const since = hits[0]?.dates[0];
  const sinceLine = since && !note
    ? `For "has anything changed since then", the reference date is ${formatDay(since)}: use published_after "${since}" on searches for news and announcements.`
    : "";

  return { status, shortStatus, block: ["<memory>", `Lookup: ${status}`, ...(sinceLine ? [sinceLine] : []), ...conversations, "</memory>"].join("\n") };
}

// The Memory tab's search: one box that takes keywords and date phrases together ("last Tuesday postgres").
// Dates go through the same resolver the agent uses, and the reply says how they were read.
export function searchMemory(
  store: Store,
  query: string,
  range: { from?: string; to?: string },
  now: Date,
  timezone: string,
  locale?: string,
) {
  const refs = query.trim() ? resolveDates(query, now, timezone, locale) : [];
  const terms = keywords(query);
  const dates = [...new Set(refs.flatMap((r) => r.dates))];
  return { interpreted: refs.length ? describeDates(refs) : null, terms, items: store.browse({ ...range, dates, terms }) };
}
