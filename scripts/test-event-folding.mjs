// One story from several outlets is one event; different stories stay apart.
// Headlines are the real ones stored for TSLA and AAPL; summaries are shortened
// but keep the words that matter. Additional minimal pairs protect the evidence
// required to fold reports with different headlines or classifications.
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

// Production events 579–581, diagnosed on 2026-10-20. Yahoo names Cybercab only
// in its summary; Ars has a different eventType from the two other outlets.
const cybercab = [
  {
    id: 579, eventType: "REGULATORY_LEGAL",
    headline: "Federal Regulators Open Investigation After Tesla Launches Car With No Steering Wheel",
    summary: "Context on the broader regulatory backdrop is covered in our companion piece, Tesla Falls 3% as Cybercab Launch Leaves Deployment Questions Unanswered, according to 24/7 Wall St.. Tesla also has at least two other active NHTSA investigations into its self-driving systems, covering at least nine documented crashes including a fatal pedestrian collision, plus scrutiny over allegedly slow crash reporting.",
    sourceUrl: "https://finance.yahoo.com/technology/articles/federal-regulators-open-investigation-tesla-142100471.html",
    discoveredAt: "2026-09-06T14:17:56.801406+02:00", publishedAt: null, severity: "WATCH",
  },
  {
    id: 580, eventType: "RECALL_SAFETY",
    headline: "Tesla’s Cybercab has been deployed, and it’s already under investigation",
    summary: "The investigation, called an Audit Query, will examine the data and process that Tesla used to make that determination, according to a government filing. In a statement, NHTSA Administrator Jonathan Morrison said his agency fully supports the safe development and deployment of automated vehicles.",
    sourceUrl: "https://arstechnica.com/cars/2026/09/teslas-cybercab-has-been-deployed-and-its-already-under-investigation",
    discoveredAt: "2026-09-06T14:17:56.804163+02:00", publishedAt: null, severity: "HIGH",
  },
  {
    id: 581, eventType: "REGULATORY_LEGAL",
    headline: "NHTSA Opens Probe Into Tesla's Cybercab Rollout",
    summary: "Mounted police watch as a Tesla Cybercab drives by during the Robotaxi launch event in Austin, Texas. Federal regulators have opened an investigation into Tesla and the company’s steering-wheel-free Cybercab to determine whether it complies with safety standards. Tesla launched the Cybercab, a two-seater gold coupe without pedals or mirrors, saying Thursday that customers in Austin, Texas can book rides through its Robotaxi ride-hailing app.",
    sourceUrl: "https://www.wsj.com/business/autos/nhtsa-opens-probe-into-teslas-cybercab-rollout-06aa6eac",
    discoveredAt: "2026-09-06T14:17:56.805726+02:00", publishedAt: null, severity: "WATCH",
  },
];

test("the Cybercab investigation folds in all six orders and preserves every report", () => {
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const input = order.map((index) => cybercab[index]);
    const before = structuredClone(input);
    const folded = foldDuplicateEvents(input, "Tesla, Inc.");
    assert.equal(folded.length, 1, `order ${order}`);
    assert.strictEqual(folded[0].event, input[0]);
    assert.equal(folded[0].event.eventType, before[0].eventType);
    assert.deepEqual(folded[0].alsoReportedAs, input.slice(1).map(({ headline, sourceUrl }) => ({ headline, sourceUrl })));
    assert.deepEqual(input, before);
  }
});

test("one rare headline subject supports matching investigation kinds", () => {
  const input = [
    ev("REGULATORY_LEGAL", "Tesla Cybercab probe", null),
    ev("REGULATORY_LEGAL", "Tesla Cybercab inquiry", null),
  ];
  assert.equal(foldDuplicateEvents(input, "Tesla, Inc.").length, 1);
});

test("cross-classification folding requires the safety/legal pair and investigation headlines", () => {
  const pairs = [
    [ev("RECALL_SAFETY", "Tesla Cybercab steering recall", null),
      ev("REGULATORY_LEGAL", "Tesla Cybercab steering lawsuit", null)],
    [ev("RECALL_SAFETY", "Tesla Cybercab steering recall", null),
      ev("REGULATORY_LEGAL", "Tesla Cybercab steering recall", null)],
    [cybercab[1], { ...cybercab[2], eventType: "PARTNERSHIP" }],
    [ev("RECALL_SAFETY", "Tesla Cybercab steering decision", "Federal investigation"),
      ev("REGULATORY_LEGAL", "Tesla Cybercab steering decision", "Federal investigation")],
  ];
  for (const pair of pairs) {
    assert.equal(foldDuplicateEvents(pair, "Tesla, Inc.").length, 2, pair.map((e) => e.headline).join(" / "));
  }
});

test("matching summaries cannot replace topical evidence from a headline", () => {
  const summary = "Cybercab deployment steering wheel Austin";
  const input = [
    ev("REGULATORY_LEGAL", "Tesla under investigation", summary),
    ev("REGULATORY_LEGAL", "Federal regulators open probe into Tesla", summary),
  ];
  assert.equal(foldDuplicateEvents(input, "Tesla, Inc.").length, 2);
});

test("a subject found only across headline and summary needs a second rare detail", () => {
  const input = [
    ev("REGULATORY_LEGAL", "Tesla Cybercab investigation", null),
    ev("REGULATORY_LEGAL", "NHTSA opens probe into Tesla", "Cybercab"),
  ];
  assert.equal(foldDuplicateEvents(input, "Tesla, Inc.").length, 2);
});

test("a subject common across the feed cannot unlock the lower investigation threshold", () => {
  const input = [
    ev("REGULATORY_LEGAL", "Acme snowfall probe", "Offices Chicago Angeles"),
    ev("REGULATORY_LEGAL", "Acme snowfall inquiry", "Offices Chicago Angeles"),
    ...["alpha", "bravo", "delta", "echo"].map((detail) =>
      ev("PARTNERSHIP", `Acme snowfall ${detail}`, null)),
  ];
  const folded = foldDuplicateEvents(input, "Acme Inc.");
  assert.equal(folded.length, input.length);
  assert.strictEqual(folded[0].event, input[0]);
  assert.strictEqual(folded[1].event, input[1]);
});

test("company names and generic investigation words cannot join reports", () => {
  const input = [
    ev("REGULATORY_LEGAL", "Tesla Inc NHTSA probe", "Federal regulators open investigation into Tesla vehicles"),
    ev("REGULATORY_LEGAL", "Federal regulators investigate Tesla", "NHTSA opens probe into Tesla Inc vehicles"),
  ];
  assert.equal(foldDuplicateEvents(input, "Tesla, Inc.").length, 2);
});

test("both investigation matching routes respect the three-day discovery window", () => {
  const later = "2026-09-10T12:17:56Z";
  for (const index of [0, 1]) {
    const input = [cybercab[2], { ...cybercab[index], discoveredAt: later }];
    assert.equal(foldDuplicateEvents(input, "Tesla, Inc.").length, 2);
  }
});

test("a folded investigation cannot bridge two different subjects", () => {
  const input = [
    ev("REGULATORY_LEGAL", "Tesla Cybercab probe", null),
    ev("REGULATORY_LEGAL", "Tesla Cybercab Austin investigation", null),
    ev("REGULATORY_LEGAL", "Tesla Austin inquiry", null),
  ];
  assert.equal(foldDuplicateEvents(input.slice(1), "Tesla, Inc.").length, 1);
  const folded = foldDuplicateEvents(input, "Tesla, Inc.");
  assert.deepEqual(folded.map((f) => f.alsoReportedAs.length), [1, 0]);
  assert.strictEqual(folded[1].event, input[2]);
});

test("probes, investigations and inquiries are investigation headlines too", () => {
  for (const headline of ["NHTSA probes Tesla's Cybercab", "Tesla Cybercab faces two investigations", "Tesla Cybercab inquiries widen"]) {
    const input = [
      ev("RECALL_SAFETY", "Tesla's Cybercab is already under investigation", null),
      ev("REGULATORY_LEGAL", headline, null),
    ];
    assert.equal(foldDuplicateEvents(input, "Tesla, Inc.").length, 1, headline);
  }
});

// Production rows for APP and CPNG, 2026-10-28. A law firm's notice and a news story
// about a different probe of the same company share boilerplate ("investors",
// "securities", "South Korea") but no subject: neither report covers half of the
// topical words in the other's headline.
const permutations = (rows) => rows.length <= 1 ? [rows]
  : rows.flatMap((row, i) => permutations([...rows.slice(0, i), ...rows.slice(i + 1)]).map((rest) => [row, ...rest]));

test("a law firm's notice does not join a news story about another probe", () => {
  const app = [
    ev("REGULATORY_LEGAL", "Rosen Law Firm Encourages MarineMax, Inc. Investors to Inquire About Securities Class Action Investigation – HZO - Business Wire",
      "# **Rosen Law Firm Encourages MarineMax, Inc. Investors to Inquire About Securities Class Action Investigation – HZO** NEW YORK--(BUSINESS WIRE)--Why:Rosen Law Firm, a global investor rights law firm, announces an investigation of potential securities claims on behalf of shareholders of MarineMax, Inc. ## Rosen Law Firm Encourages Tvardi Therapeutics, Inc. Investors to Inquire About Securities Class Action Investigation – TVRD NEW YORK--(BUSINESS WIRE)--Why: Rosen Law Firm, a global investor rights law firm, announces an investigation of potential securities claims on behalf of shareholders of Tvardi Therapeutics, Inc. NEW YORK--(BUSINESS WIRE)--Why: Rosen Law Firm, a global investor rights ",
      "2026-09-15T08:59:05.136974Z"),
    ev("REGULATORY_LEGAL", "Rosen Law Firm Encourages Jefferies Financial Group Inc. Investors to Inquire About Securities Class Action Investigation – JEF - Business Wire",
      "# **Rosen Law Firm Encourages Jefferies Financial Group Inc. Investors to Inquire About Securities Class Action Investigation – JEF** NEW YORK--(BUSINESS WIRE)--Why: Rosen Law Firm, a global investor rights law firm, announces an investigation of potential securities claims on behalf of shareholders of AppLovin Corporation (NASDAQ: APP) resulting from allegations that AppLovin may have issued materially misleading business information to the investing public. NEW YORK--(BUSINESS WIRE)--Why: Rosen Law Firm, a global investor rights law firm, announces an investigation of potential securities claims on behalf of shareholders of Trinseo PLC (NYSE: TSE) resulting from allegations that Trinseo ma",
      "2026-09-15T08:59:05.135775Z"),
    ev("REGULATORY_LEGAL", "Applovin stock tumbles after report of SEC probe into data practices - Investing.com",
      "Stock Markets Investing.com -- Applovin (NASDAQ:APP) shares fell 18% Monday afternoon following a Bloomberg report that the mobile advertising technology company is under investigation by the Securities and Exchange Commission regarding its data-collection practices. The significant stock drop highlights investor concerns about potential regulatory challenges facing the mobile advertising technology provider, which has become a major player in the app monetization and marketing space. 1M 6M Stock market today: S&P 500 hits another closing record as AMD leads tech rally | APP | 587.00 | -14.03% | 14.42M | | ARE | 79.99 | -4.55% | 2.21M | | T | 25.87 | -4.40% | 63.47M |",
      "2026-09-15T08:59:05.134579Z"),
  ];
  const coupang = [
    ev("REGULATORY_LEGAL", "Coupang investors seek US probe over South Korea's handling of data leak - Reuters",
      "By Hyunjoo Jin and Krystal Hu. SAN FRANCSICO/SEOUL, Jan 22 (Reuters) - Two major U.S. investors in Coupang Inc (CPNG.N), opens new tab said on Thursday they have petitioned the U.S. government to investigate the South Korean government and potentially impose trade remedies over what they describe as discriminatory treatment of the e-commerce company. Tech investors Greenoaks and Altimeter said they have also filed arbitration claims against South Korea under the U.S.–Korea Free Trade Agreement (KORUS), accusing Seoul of mounting a campaign against Coupang following a consumer data breach that has caused billions of dollars in losses for investors. The move comes after Coupang reported in N",
      "2026-09-05T11:37:37.089095Z"),
    ev("REGULATORY_LEGAL", "Kaplan Fox Announces an Investigation Into Coupang, Inc. (CPNG) for Potential Securities Law Violations - Markets Financial Content",
      "# Kaplan Fox Announces an Investigation Into Coupang, Inc. NEW YORK, NY - December 13, 2025 (NEWMEDIAWIRE) - Kaplan Fox & Kilsheimer LLP is investigating potential securities violations against Coupang, Inc. On November 20, 2025, *Yonhap News*, a South Korean news agency, published an article stating that Coupang reported to the government “a data leakage incident that exposed the personal information of about 4,500 customers.”. Following this news, the price of Coupang stock fell $0.84 per share, approximately 3%, to close at $26.56 per share. Then, on November 29, 2025, *Yonhap News* reported that Coupang “confirmed personal information from 33.7 million customer accounts was exposed, far ",
      "2026-09-05T11:37:37.087415Z"),
  ];
  for (const [rows, company, story] of [[app, "Applovin Corp - Class A", /SEC probe/], [coupang, "Coupang Inc - Class A", /seek US probe/]]) {
    for (const input of permutations(rows)) {
      const folded = foldDuplicateEvents(input, company);
      const members = folded.find((f) => [f.event, ...f.alsoReportedAs].some((r) => story.test(r.headline)));
      assert.equal(members.alsoReportedAs.length, 0, `${company}: ${input.map((e) => e.headline.slice(0, 30)).join(" / ")}`);
    }
  }
});

test("a shared subject and non-investigation kind do not merge independent actions", () => {
  const pairs = [
    [ev("RESTRUCTURING", "Tesla Austin layoffs", "Engineers dismissed"),
      ev("RESTRUCTURING", "Tesla Austin layoff", "Account managers eliminated")],
    [ev("REGULATORY_LEGAL", "Tesla Texas fined for emissions", null),
      ev("REGULATORY_LEGAL", "Tesla Texas fine for advertising", null)],
    [ev("RECALL_SAFETY", "Tesla Cybercab recall for latch", null),
      ev("RECALL_SAFETY", "Tesla Cybercab recall for software", null)],
  ];
  for (const pair of pairs) {
    assert.equal(foldDuplicateEvents(pair, "Tesla, Inc.").length, 2, pair.map((e) => e.headline).join(" / "));
  }
});
