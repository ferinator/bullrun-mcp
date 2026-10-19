/**
 * One story reported by several outlets is one event. The event feed stores every
 * article it finds, so Tesla's 2026 China door recall arrived five times (NYT,
 * Mashable, moomoo, Reuters, BBC) under headlines with little wording in common,
 * and read as five recalls.
 *
 * A report is folded into a story when, of the same event type and found in the same
 * crawl as the story's first report, its headline shares two topical words with that
 * headline (china + door),
 * or one plus at least four words of text that are rare among the company's events.
 * Generic newsroom words (investigation, recall, regulators, lawsuit, faces) are
 * never topical, and a report is compared with the story's first report only, never
 * with whatever joined it: matching any member chained Apple's UK App Store suit,
 * an AirTag case and the EU tax dispute into one "story". Folding hides nothing:
 * folded reports stay listed, headline and link, under the event that represents
 * them.
 */

export interface FoldableEvent {
  eventType: string | null;
  headline: string | null;
  summary: string | null;
  sourceUrl: string | null;
  discoveredAt: string | null;
}

export interface FoldedEvent<T extends FoldableEvent> {
  event: T;
  alsoReportedAs: Array<{ headline: string | null; sourceUrl: string | null }>;
}

const STOPWORDS = new Set([
  "that", "this", "with", "from", "have", "been", "will", "would", "said", "says", "over",
  "after", "into", "about", "their", "which", "other", "others", "also", "more", "than", "they",
  "were", "when", "what", "where", "while", "could", "should", "there", "these", "those", "your",
  "year", "years", "time", "first", "most", "some", "such", "only", "just", "like", "news",
  "read", "full", "according", "report", "reports", "reported", "under", "three", "including",
  "already", "still", "without", "least", "last", "next", "against", "between", "because",
]);

/** Words any regulatory, legal or corporate story uses: never evidence of the same story. */
const GENERIC = new Set([
  "investigation", "investigate", "investigates", "investigating", "probe", "lawsuit", "suit",
  "recall", "recalled", "regulator", "regulatory", "regulation", "federal", "nhtsa", "agency",
  "open", "opens", "opened", "launch", "launche", "launched", "vehicle", "cars", "million",
  "billion", "company", "companie", "group", "employee", "worker", "customer", "people",
  "market", "share", "stock", "price", "deal", "plan", "update", "latest", "world", "global",
  "safety", "risk", "issue", "problem", "case", "court", "filing", "statement", "announced",
  "face", "faces", "claim", "action", "class", "challenge", "legal", "dispute", "settle",
  "settlement", "deny", "denial", "wins", "lose", "loses", "sales", "sale", "corporation", "inc",
  // Layoff coverage words: every round of cuts uses them (Apple's sales-team cuts and
  // its separate Vision Pro/Siri cuts both "rare layoffs").
  "job", "jobs", "cut", "cuts", "layoff", "layoffs", "rare", "hit", "hits", "shake", "workforce",
  "staff", "team", "teams", "role", "roles",
]);

/** Same crawl: reports of one story are found together. */
const SAME_STORY_DAYS = 3;

function tokens(text: string | null, companyWords: Set<string>): string[] {
  const out: string[] = [];
  const cleaned = (text ?? "").toLowerCase().replace(/[\u2019']s\b/g, "").replace(/[^a-z0-9]+/g, " ");
  for (const raw of cleaned.split(" ")) {
    if (raw.length < 4 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    const word = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (!companyWords.has(word) && !companyWords.has(raw)) out.push(word);
  }
  return out;
}

function daysApart(a: string | null, b: string | null): number {
  const left = a ? Date.parse(a) : NaN;
  const right = b ? Date.parse(b) : NaN;
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) / 86_400_000 : 0;
}

interface Report {
  /** Every content word of headline and summary. */
  words: Set<string>;
  /** Topical words of the headline: what the story is about. */
  anchors: Set<string>;
}

/**
 * Fold `rows` (already in display order: the first report of a story represents
 * it). `companyName` keeps the company's own name from counting as a shared detail.
 */
export function foldDuplicateEvents<T extends FoldableEvent>(rows: T[], companyName: string | null): FoldedEvent<T>[] {
  const companyWords = new Set(tokens(companyName, new Set()));
  const reports: Report[] = rows.map((row) => ({
    words: new Set([...tokens(row.headline, companyWords), ...tokens(row.summary, companyWords)]),
    anchors: new Set(tokens(row.headline, companyWords).filter((word) => !GENERIC.has(word))),
  }));
  const documentFrequency = new Map<string, number>();
  for (const { words } of reports) for (const word of words) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  // A word most of the company's events use says nothing about which story an article
  // tells. The floor matters when one story dominates a short list: its five reports
  // all say "china", which is what they have in common, not noise.
  const rareLimit = Math.max(5, Math.floor(rows.length * 0.4));

  const sameStory = (first: number, candidate: number): boolean => {
    if (rows[first].eventType !== rows[candidate].eventType) return false;
    if (daysApart(rows[first].discoveredAt, rows[candidate].discoveredAt) > SAME_STORY_DAYS) return false;
    let anchors = 0;
    for (const word of reports[first].anchors) if (reports[candidate].anchors.has(word)) anchors++;
    if (anchors >= 2) return true;
    if (anchors === 0) return false;
    let rare = 0;
    for (const word of reports[first].words) {
      if (reports[candidate].words.has(word) && !GENERIC.has(word) && (documentFrequency.get(word) ?? 0) <= rareLimit) rare++;
    }
    return rare >= 4;
  };

  const stories: Array<{ first: number; folded: FoldedEvent<T> }> = [];
  rows.forEach((row, index) => {
    const story = stories.find(({ first }) => sameStory(first, index));
    if (story) story.folded.alsoReportedAs.push({ headline: row.headline, sourceUrl: row.sourceUrl });
    else stories.push({ first: index, folded: { event: row, alsoReportedAs: [] } });
  });
  return stories.map(({ folded }) => folded);
}
