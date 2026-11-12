import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { recall, resolveDates, isRecall, keywords } from "../src/recall.ts";

// Thursday 12 November 2026, 14:00 in London.
const NOW = new Date("2026-11-12T14:00:00Z");
const TZ = "Europe/London";
const dates = (text: string, now = NOW, tz = TZ) => resolveDates(text, now, tz).flatMap((r) => r.dates);

test("the three sample questions resolve to the right days", () => {
  assert.deepEqual(dates("What did I ask you on 3 November? Is your answer still correct today?"), ["2026-11-03"]);
  assert.deepEqual(dates("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), ["2026-11-10", "2026-11-03"]);
  assert.deepEqual(dates("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"), ["2026-11-09"]);
});

test("relative and partial dates resolve to the past", () => {
  assert.deepEqual(dates("yesterday"), ["2026-11-11"]);
  assert.deepEqual(dates("what did we talk about last week"), ["2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02"]);
  assert.deepEqual(dates("on 20 November")[0], "2025-11-20"); // still ahead this year, so last year's
  assert.equal(dates("in March").at(-1), "2026-03-01");
  assert.deepEqual(dates("on 3/11"), ["2026-11-03"]); // day-first outside the US
  assert.deepEqual(dates("tomorrow's weather"), []);
  assert.deepEqual(dates("what's new in Node 26 for 2026?"), []);
});

test("the user's time zone decides what 'yesterday' is", () => {
  // 01:30 UTC on Thu 12 Nov is still Wed 11 Nov in Los Angeles.
  assert.deepEqual(dates("yesterday", new Date("2026-11-12T01:30:00Z"), "America/Los_Angeles"), ["2026-11-10"]);
});

test("recall cues fire on references to the past, not on fresh questions", () => {
  assert.ok(isRecall("Last Tuesday I asked you about Postgres hosting"));
  assert.ok(isRecall("On Monday we shortlisted 5 CRM tools"));
  assert.ok(isRecall("What did I ask you on 3 November?"));
  assert.ok(!isRecall("What happened in AI news yesterday?"));
  assert.ok(!isRecall("hey, thanks!"));
  assert.deepEqual(keywords("Last Tuesday I asked you about Postgres hosting. Has any pricing changed?"), ["postgres", "hosting", "pricing"]);
});

function seeded() {
  const s = new Store(":memory:");
  const add = (title: string, at: string, q: string, a: string, sources = true) => {
    const c = s.createConversation(title, new Date(at));
    s.addMessage({ conversationId: c, role: "user", content: q, at: new Date(at), timezone: TZ });
    const m = s.addMessage({ conversationId: c, role: "assistant", content: a, at: new Date(at), timezone: TZ });
    if (sources) s.addSources(m, [{ n: 1, url: "https://neon.com/pricing", title: "Neon pricing", published: "2026-10-01", query: "neon pricing" }]);
    return c;
  };
  const postgres = add("Cheapest Postgres hosting", "2026-11-03T10:00:00Z", "Which Postgres hosting is cheapest for a side project?", "Neon's free plan [1] is cheapest.");
  const crm = add("CRM shortlist", "2026-11-09T09:00:00Z", "Shortlist 5 CRM tools for a 20-person sales team", "HubSpot, Pipedrive, Attio, Zoho, Salesforce Starter.");
  const weather = add("Weather", "2026-11-10T08:00:00Z", "Will it rain in London?", "Yes.", false);
  return { s, postgres, crm, weather };
}

test("store: keyword search and date lookup", () => {
  const { s, postgres, crm } = seeded();
  assert.deepEqual(s.searchConversations(["postgres"]).map((h) => h.id), [postgres]);
  assert.deepEqual(s.conversationsOnDates(["2026-11-09"]).map((h) => h.id), [crm]);
  assert.equal(s.messages(postgres)[1].sources[0].url, "https://neon.com/pricing");
});

test("recall picks the topic match among candidate days and strips old citation numbers", () => {
  const { s } = seeded();
  const r = recall(s, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", NOW, TZ)!;
  assert.match(r.status, /Tuesday 10 November 2026 or Tuesday 3 November 2026/);
  assert.match(r.block, /Cheapest Postgres hosting/);
  assert.doesNotMatch(r.block, /Weather/); // same candidate day, wrong topic: left out
  assert.match(r.block, /https:\/\/neon\.com\/pricing/);
  assert.match(r.block, /published_after "2026-11-03"/);
  assert.doesNotMatch(r.block, /\[1\]/);
});

test("recall says plainly when nothing exists on the date", () => {
  const { s } = seeded();
  const r = recall(s, "What did I ask you on 5 November?", NOW, TZ)!;
  assert.match(r.status, /NO conversations on that date/);
  assert.match(r.status, /Nearest dates/);
  assert.equal(recall(new Store(":memory:"), "What did I ask you on 5 November?", NOW, TZ)!.status.includes("history is empty"), true);
});

test("recall does not run for ordinary questions", () => {
  const { s } = seeded();
  assert.equal(recall(s, "What's the cheapest Postgres host today?", NOW, TZ), null);
});

test("visitors cannot list, open or recall each other's conversations", async () => {
  const { loadDemoHistory } = await import("../src/demo.ts");
  const base = new Store(":memory:");
  const alice = base.scoped("alice-0001"), bob = base.scoped("bob-00002");
  assert.equal(loadDemoHistory(alice, NOW, TZ), 3);
  assert.equal(loadDemoHistory(alice, NOW, TZ), 0); // loading twice adds nothing
  const mine = alice.listConversations();
  assert.equal(mine.length, 3);
  assert.equal(bob.listConversations().length, 0);
  assert.deepEqual(bob.messages(mine[0].id), []);
  assert.equal(bob.conversationExists(mine[0].id), false);
  assert.match(recall(alice, "What did I ask you on 3 November?", NOW, TZ)!.status, /Found 1 past conversation/);
  assert.match(recall(bob, "What did I ask you on 3 November?", NOW, TZ)!.status, /history is empty/);
  // The sample history lands on the days the sample questions point at.
  assert.match(recall(alice, "On Monday we shortlisted 5 CRM tools", NOW, TZ)!.block, /CRM/);
  assert.match(recall(alice, "Last Tuesday I asked you about Postgres hosting", NOW, TZ)!.block, /Postgres/);
});
