// Push copy for every news push, in one place so the dry-run script and the
// send functions can never drift apart.
//
// Format approved by Ayuka 2026-10-29 (work/praxis/notifications-review-2026-10-29.md §6):
// one story per push, a short label in the title, the full headline as the
// body (never cut with "…"), and the Blind Spot lean as the subtitle.

export type PushCopy = { title: string; subtitle?: string; body: string };

export type FeedArticle = {
  article_id: string | number;
  cluster_id: string | number;
  title: string;
  lede?: string | null;
  image_url?: string | null;
  url?: string | null;
  reasons?: string[];
  // The article's own topics, strongest first (/v1/graph/article/{id}).
  topics?: string[];
  meta?: { summary?: string } | null;
};

const DIGEST_MINUTES = 6;
const MAX_KICKER_LENGTH = 22;
// About two lines of push body on an iPhone lock screen.
const SHORT_HEADLINE_LENGTH = 90;
// How far down the ranked feed the digest looks for a short headline.
const LEAD_SEARCH_DEPTH = 8;

// iOS shows about four lines of body on the lock screen. Real headlines run
// up to ~190 characters, so this only catches pathological titles.
const MAX_HEADLINE_LENGTH = 200;

export function headline(title: string): string {
  let clean = title.replace(/\s+/g, " ").trim();
  if (clean.length > MAX_HEADLINE_LENGTH) {
    clean = clean.slice(0, MAX_HEADLINE_LENGTH).replace(/\s+\S*$/, "");
  }
  return /[.?!…"'”’]$/.test(clean) ? clean : `${clean}.`;
}

// The label is the article's strongest topic short enough to sit in the
// title. The feed's reasons ("topics: Economy, Elections") are only the broad
// buckets the story was filed under, alphabetical, so they are the fallback:
// a rally story came out as "Economy" (2026-11-01).
export function kicker(article: FeedArticle): string | null {
  const own = (article.topics ?? []).map((t) => t.trim())
    .find((t) => t.length > 0 && t.length <= MAX_KICKER_LENGTH);
  if (own) return own;
  for (const reason of article.reasons ?? []) {
    const match = /^topics:\s*(.+)$/i.exec(reason);
    if (!match) continue;
    const topic = match[1].split(",").map((t) => t.trim())
      .find((t) => t.length > 0 && t.length <= MAX_KICKER_LENGTH);
    if (topic) return topic;
  }
  return null;
}

export function weekday(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" })
      .format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
    }).format(new Date());
  }
}

// Shorter format, Ayuka 2026-10-31 ("they seem long"): the count and time sit
// in the title, the body is one headline and nothing else.
export function digestCopy(lead: FeedArticle | null, timezone: string): PushCopy {
  const title = `Your ${weekday(timezone)} 5 · ${DIGEST_MINUTES} min`;
  if (!lead) return { title, body: "Every side of today's news, in 5 stories." };
  return { title, body: headline(lead.title) };
}

export function winbackCopy(): PushCopy {
  return {
    title: "Your feed's been busy",
    body: `5 stories whenever you're back, about ${DIGEST_MINUTES} minutes.`,
  };
}

export function eveningCopy(lead: FeedArticle): PushCopy {
  return { title: kicker(lead) ?? "This evening", body: headline(lead.title) };
}

export function breakingCopy(lead: FeedArticle): PushCopy {
  return { title: "Breaking", body: headline(lead.title) };
}

export function blindSpotCopy(lead: FeedArticle, side: "left" | "right"): PushCopy {
  return {
    title: "Blind Spot",
    subtitle: `Only ${side}-leaning outlets so far`,
    body: headline(lead.title),
  };
}

// Evening streak saver (Ayuka 11/03: louder, Duolingo-style; "a few minutes,
// stay informed / get smarter"). Flame + number + loss framing in the title,
// rotated body lines. Streaks reset at New York midnight (digestStreak.ts).
export const STREAK_LINES = [
  () => "Don't let it go to 0. A few minutes to stay informed.",
  () => "A few minutes today keeps it alive. Get smarter, keep your streak.",
  (n: number) => `Day ${n + 1} is a few minutes away.`,
  () => "Every side of today's news, in a few minutes. Don't lose it.",
];

export function streakCopy(streak: number, lineIdx: number): PushCopy {
  return {
    title: `🔥 Your ${streak}-day streak ends tonight`,
    body: STREAK_LINES[lineIdx](streak),
  };
}

// Last call at 10:30pm New York, 90 minutes before the streak resets.
export function streakLastCallCopy(streak: number): PushCopy {
  return {
    title: `⏰ 90 minutes left on your 🔥 ${streak}`,
    body: streak >= 30
      ? `Last call. Don't lose ${streak} days. A few minutes saves it.`
      : "Last call. A few minutes saves your streak.",
  };
}

// Mirrors the app's digest pick (app/lib/dailyDigest.ts scoreArticleForDigest
// + isNearDuplicateTitle), so the morning push leads with the story the
// digest opens on: feed order first, a bonus for a summary, an image and
// topics, and nothing that repeats a recent digest.
const TITLE_STOPWORDS = new Set([
  "about", "administration", "after", "against", "america", "american",
  "americans", "amid", "among", "announces", "because", "before", "being",
  "between", "biden", "breaking", "calls", "claims", "congress", "could",
  "court", "democrat", "democrats", "during", "every", "federal", "first",
  "former", "house", "might", "nation", "national", "officials", "other",
  "president", "report", "republican", "republicans", "says", "senate",
  "should", "state", "states", "their", "there", "these", "things", "times",
  "today", "trump", "under", "vance", "warns", "white", "whose", "world",
  "would", "years",
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((word) => word.length >= 5 && !TITLE_STOPWORDS.has(word)),
  );
}

export function sharesStoryWith(title: string, otherTitles: string[]): boolean {
  const words = significantWords(title);
  for (const text of otherTitles) {
    let shared = 0;
    for (const word of significantWords(text)) {
      if (words.has(word) && ++shared >= 2) return true;
    }
  }
  return false;
}

export function pickDigestLead(
  articles: FeedArticle[],
  recentTitles: string[],
): FeedArticle | null {
  const ranked = articles
    .filter((article) => article.url && article.title)
    .map((article, index) => {
      const topics = (article.reasons ?? []).flatMap((r) =>
        /^topics:/i.test(r) ? r.replace(/^topics:\s*/i, "").split(",") : []
      ).length;
      return {
        article,
        score: 1000 - index +
          (article.meta?.summary || article.lede ? 30 : 0) +
          (article.image_url ? 20 : 0) +
          Math.min(topics, 4) * 4,
      };
    })
    .sort((a, b) => b.score - a.score);
  const fresh = ranked.filter(({ article }) =>
    !sharesStoryWith(article.title, recentTitles)
  );
  // Prefer a top story whose headline fits in about two lock-screen lines;
  // a long headline is never cut, it just loses the lead slot.
  const short = fresh.slice(0, LEAD_SEARCH_DEPTH).find(({ article }) =>
    headline(article.title).length <= SHORT_HEADLINE_LENGTH
  );
  return (short ?? fresh[0] ?? ranked[0])?.article ?? null;
}
