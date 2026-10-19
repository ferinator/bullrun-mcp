// One story from several outlets is one event; different stories stay apart.
// Headlines are the real ones stored for TSLA and AAPL on 2026-10-19; summaries are
// shortened but keep the words that matter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldDuplicateEvents } from "../dist/tools/eventFolding.js";

const at = "2026-08-31T12:47:00Z";
const ev = (eventType, headline, summary, discoveredAt = at) =>
  ({ eventType, headline, summary, sourceUrl: `https://example.invalid/${encodeURIComponent(headline.slice(0, 20))}`, discoveredAt, publishedAt: null });

const tesla = [
  ev("RECALL_SAFETY", "In China's Biggest Car Recall, Tesla and 8 Others Will Address Door ...",
    "China's State Administration for Market Regulation said Tesla and eight Chinese automakers, Xiaomi among them, would recall cars over door handles."),
  ev("RECALL_SAFETY", "Federal Register :: Tesla, Inc., Denial of Petition for Decision of Inconsequential Noncompliance",
    "NHTSA's analysis of inconsequential noncompliance focuses on the safety risk to individuals."),
  ev("RECALL_SAFETY", "Tesla recalls 3 million cars in China over 'hidden' door ...",
    "The company recalled 2,975,910 vehicles in the country over its emergency mechanical door release, which the Chinese regulator found difficult to identify."),
  ev("RECALL_SAFETY", "Tesla and others begin record vehicle recall in China",
    "It concerns 2.98 million imported and China-made Model 3 and Model Y vehicles, the company told the State Administration for Market Regulation; door handle release."),
  ev("RECALL_SAFETY", "Why Tesla has been caught up in a massive car recall in China",
    "The latest Xiaomi SU7 models come with new door handles that can be opened without power; Tesla's mechanical door release was found hard to use in China."),
  ev("RECALL_SAFETY", "Tesla Autopilot Lawsuit [2026 Investigation] | TorHoerman Law",
    "After a three-year probe, NHTSA connected Autopilot use to 13 fatal crashes and required a software recall covering two million vehicles."),
];

test("five outlets' reports of one recall fold into one event", () => {
  const folded = foldDuplicateEvents(tesla, "Tesla, Inc.");
  assert.equal(folded.length, 3);
  const china = folded.find((f) => /Biggest Car Recall/.test(f.event.headline));
  assert.equal(china.alsoReportedAs.length, 3);
  assert.ok(china.alsoReportedAs.every((r) => /China/.test(r.headline)));
  assert.equal(folded.find((f) => /Autopilot/.test(f.event.headline)).alsoReportedAs.length, 0);
  assert.equal(folded.find((f) => /Federal Register/.test(f.event.headline)).alsoReportedAs.length, 0);
});

test("two rounds of layoffs at one company stay two events", () => {
  const apple = [
    ev("RESTRUCTURING", "Apple Cuts Jobs Across Its Sales Organization in Rare Layoff - Bloomberg.com",
      "Apple is cutting dozens of jobs across its sales organization, including account managers who serve businesses, schools and government agencies."),
    ev("RESTRUCTURING", "Apple cuts jobs across its sales organization in rare layoff - Los Angeles Times",
      "Apple is making cuts across its sales organization, eliminating dozens of account managers who serve businesses, schools and government agencies."),
    ev("RESTRUCTURING", "Apple's rare Bay Area layoffs hit Vision Pro and Siri teams ...",
      "Apple is laying off 147 employees in the Bay Area, mostly in the Vision Pro and Siri units, according to a WARN filing."),
    ev("RESTRUCTURING", "Apple Cuts 147 Bay Area Jobs, Mostly in Vision Pro and Siri Units",
      "A WARN notice shows 147 Bay Area roles cut, mostly in the Vision Pro and Siri units."),
  ];
  const folded = foldDuplicateEvents(apple, "Apple Inc.");
  assert.deepEqual(folded.map((f) => f.alsoReportedAs.length), [1, 1]);
});

test("reports found in different crawls are not folded", () => {
  const later = ev("RECALL_SAFETY", "Tesla recalls nearly 3 million cars in China over door escape design",
    "Tesla's door release recall in China, issued with the State Administration for Market Regulation.", "2026-10-15T08:00:00Z");
  const folded = foldDuplicateEvents([tesla[0], later], "Tesla, Inc.");
  assert.equal(folded.length, 2);
});
