import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  blindSpotCopy,
  breakingCopy,
  electionResultsCopy,
  eveningCopy,
} from "../_shared/pushFormat.ts";

// Runs every 20 minutes. It sends, in order: the local 12:30 "3 stories"
// push, the local 6pm edition (an "across the map" push on good days),
// high-consensus breaking news, then one-sided-coverage blind spots.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-praxis-cron-secret",
};

const FALLBACK_TIMEZONE = "America/New_York";
const BREAKING_MIN_PUBLISHERS = 5;
const BREAKING_MAX_AGE_HOURS = 4;
const BREAKING_MIN_SCORE = 1.7;
const SPLIT_MIN_PUBLISHERS = 3;
const SPLIT_MAX_AGE_HOURS = 12;
const SPLIT_MIN_SCORE = 1.5;
// 2-3 a day (Ayuka, 2026-10-29): 8am + 6pm, a third only when it earns it.
const DAILY_CAP = 3;

// Election Day (Ayuka, 2026-11-03): the 6pm edition leads with an election
// story, and one results push may go out from 7pm to midnight local, past
// the usual 10pm quiet hour, when 3+ outlets report a call. Streak pushes
// don't count toward its cap; news pushes still max out at 3.
const ELECTION_DAY = "2026-11-03";
const ELECTION_STORY = /\b(midterms?|elections?|ballots?|voters?|voting|polls?|turnout)\b/i;
const ELECTION_CALL =
  /\b(wins?|won|projected|projects|called|defeats?|flips?|retains?|keeps?|holds?|captures?|concedes?|victory|re-?elected|control of)\b/i;
const ELECTION_CONTEST =
  /\b(midterms?|elections?|race|seat|governor|majority|control of (the )?(house|senate)|house control|senate control)\b/i;
const RESULTS_MIN_PUBLISHERS = 3;
const RESULTS_MAX_AGE_HOURS = 3;
// Across the map (Ayuka, 2026-11-07): one story from the outlets that sit
// farthest apart on the bias map, opened in its own swipe screen. It takes
// the 6pm slot on days with a good spread, at most every other day.
const SIDES_MAX_AGE_HOURS = 24;
const SIDES_MIN_SCORE = 1.0;
// Closest pair of the three must be at least this far apart on the map
// (x and y both run -1..1), and the three must reach both sides of center.
const SIDES_MIN_SPREAD = 0.5;
const SIDES_SIDE_X = 0.2;
const SIDES_EVERY_HOURS = 48;
// "3 stories right now" (Ayuka, 2026-11-07): the day's three most-covered
// stories at 12:30 local, only on days when there are three.
const THREE_MAX_AGE_HOURS = 24;
const THREE_MIN_PUBLISHERS = 2;
const OPINION_Y = -0.45;

type Article = {
  article_id: string;
  cluster_id: number | string;
  publisher: string;
  title: string;
  ts_pub: string;
  score: number;
  x: number | null;
  y: number | null;
  lede?: string | null;
  cluster_summary: string;
  reasons?: string[];
  topics?: string[];
};

type Cluster = {
  id: string;
  articles: Article[];
  publishers: Set<string>;
  newest: number;
  maxScore: number;
  lead: Article;
  xs: number[];
};

function nyDateKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
    .format(d);
}

function localTime(timezone: string): { hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date());
    return {
      hour: Number(parts.find((p) => p.type === "hour")?.value),
      minute: Number(parts.find((p) => p.type === "minute")?.value),
    };
  } catch {
    return null; // bad timezone string — skip rather than send at the wrong time
  }
}

// Two headlines about the same story rarely match verbatim (the morning
// digest led with "Judge says Trump can't demolish Kennedy Center" and the
// blind spot re-pushed it as "Thousands protest closure of the Kennedy
// Center", 2026-09-19). Sharing ≥2 significant words is close enough to
// count as the same story. Everyday political words never count.
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

function sharesStoryWith(title: string, digestTexts: string[]): boolean {
  const words = significantWords(title);
  for (const text of digestTexts) {
    let shared = 0;
    for (const word of significantWords(text)) {
      if (words.has(word) && ++shared >= 2) return true;
    }
  }
  return false;
}

function withinHours(timestamp: number, hours: number): boolean {
  return Number.isFinite(timestamp) &&
    timestamp >= Date.now() - hours * 3600000;
}

function parseForcedTime(
  value: unknown,
): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

async function chunkedExpoSend(messages: unknown[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages.slice(i, i + 100)),
    });
    // Tickets were never read, so a rejected push looked sent (2026-11-07).
    // Log refusals; the function's logs are the only place they show up.
    const tickets = await response.json().catch(() => null);
    for (const ticket of tickets?.data ?? []) {
      if (ticket?.status === "error") {
        console.warn("[send-news-push] expo ticket error", JSON.stringify(ticket));
      }
    }
  }
}

function mapDistance(a: Article, b: Article): number {
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));
}

function sameStory(a: Article, b: Article): boolean {
  const words = significantWords(a.title);
  for (const word of significantWords(b.title)) {
    if (words.has(word)) return true;
  }
  return false;
}

// Names too common to tie two articles to one event.
const ANCHOR_STOPWORDS = new Set([
  "America", "American", "Americans", "Biden", "Congress", "Democrat",
  "Democratic", "Democrats", "Donald", "GOP", "House", "Monday", "President",
  "Republican", "Republicans", "Saturday", "Senate", "States", "Sunday",
  "Thursday", "Trump", "Tuesday", "United", "Vance", "Wednesday", "Friday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December", "Nov", "Oct", "Sept",
]);

// The proper names in the summary's first sentence (the event itself:
// "Florida", "Oval Office"), minus the sentence's opening word.
function summaryAnchors(summary: string): Set<string> {
  // Split after a word of 3+ lowercase letters so "Nov." or "U.S." never
  // ends the sentence.
  const first = summary.split(/(?<=[a-z]{3}[.!?])\s+(?=[A-Z])/)[0] ?? "";
  const words = first.split(/\s+/).slice(1)
    .map((w) => w.replace(/[’']s$/, "").replace(/[^A-Za-z]/g, ""))
    .filter((w) => /^[A-Z][a-z]{2,}$/.test(w) && !ANCHOR_STOPWORDS.has(w));
  return new Set(words);
}

// An article belongs to the event when its headline or lede names it.
// Caught on the first dry run (11/07): "Tennessee votes to ban property
// taxes" sat in the Florida property-tax cluster and shared words with it.
function namesEvent(article: Article, anchors: Set<string>): boolean {
  const text = `${article.title} ${article.lede ?? ""}`;
  for (const word of text.split(/\s+/)) {
    if (anchors.has(word.replace(/[’']s$/, "").replace(/[^A-Za-z]/g, ""))) return true;
  }
  return false;
}

// The three outlets on one story that sit farthest apart on the map: the
// trio whose closest pair is farthest apart. Null unless the spread is real
// (both sides of center, closest pair >= SIDES_MIN_SPREAD). Only articles
// that name the event count, every pair of headlines must share a word and
// every headline must match the summary, which keeps loose clusters (the
// 11/06 "elections" grab-bag) out. Left to right.
function acrossTheMap(cluster: Cluster): Article[] | null {
  const anchors = summaryAnchors(cluster.articles[0]?.cluster_summary ?? "");
  if (anchors.size === 0) return null;
  const byPublisher = new Map<string, Article>();
  for (const article of cluster.articles) {
    if (typeof article.x !== "number" || typeof article.y !== "number") continue;
    if (!namesEvent(article, anchors)) continue;
    const current = byPublisher.get(article.publisher);
    if (!current || article.score > current.score) {
      byPublisher.set(article.publisher, article);
    }
  }
  const pool = [...byPublisher.values()];
  let best: Article[] | null = null;
  let bestMin = 0;
  let bestSum = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const trio = [pool[i], pool[j], pool[k]];
        const d = [
          mapDistance(trio[0], trio[1]),
          mapDistance(trio[0], trio[2]),
          mapDistance(trio[1], trio[2]),
        ];
        const min = Math.min(...d);
        const sum = d[0] + d[1] + d[2];
        if (min > bestMin || (min === bestMin && sum > bestSum)) {
          best = trio;
          bestMin = min;
          bestSum = sum;
        }
      }
    }
  }
  if (!best || bestMin < SIDES_MIN_SPREAD) return null;
  if (!best.some((a) => (a.x ?? 0) <= -SIDES_SIDE_X)) return null;
  if (!best.some((a) => (a.x ?? 0) >= SIDES_SIDE_X)) return null;
  if (
    !sameStory(best[0], best[1]) || !sameStory(best[0], best[2]) ||
    !sameStory(best[1], best[2])
  ) return null;
  // Ayuka: "make sure before you send one that they're all related". Each
  // headline must also share two significant words with the story summary.
  const summary = significantWords(cluster.articles[0]?.cluster_summary ?? "");
  for (const article of best) {
    let shared = 0;
    for (const word of significantWords(article.title)) {
      if (summary.has(word)) shared += 1;
    }
    if (shared < 2) return null;
  }
  return best.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
}

// The headline a story is shown by in the 3-stories push: the shortest one
// that is not an opinion piece, a column ("… | Name") or a video/podcast page.
function plainHeadline(cluster: Cluster): Article {
  const plain = cluster.articles.filter((a) =>
    (a.y ?? 0) > OPINION_Y && !/\s\|\s/.test(a.title) &&
    !/\b(video|podcast|live)\b\s*$/i.test(a.title) && !/^watch:/i.test(a.title)
  );
  const pool = plain.length > 0 ? plain : cluster.articles;
  return [...pool].sort((a, b) => a.title.length - b.title.length)[0];
}

// The evening title is the lead's own strongest topic (see kicker). Looked
// up only for leads about to be sent, once per lead per run; on any failure
// the lead keeps the feed's reasons as the fallback label.
const topicLookups = new Map<string, Promise<Article>>();
function withTopics(lead: Article, apiBase: string): Promise<Article> {
  const key = String(lead.article_id);
  let pending = topicLookups.get(key);
  if (!pending) {
    pending = fetch(`${apiBase}/v1/graph/article/${encodeURIComponent(key)}`, {
      headers: { "X-API-Key": Deno.env.get("RECOMMENDER_API_KEY") ?? "" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((focus) => {
        const topics = Array.isArray(focus?.topics)
          ? focus.topics.filter((t: unknown): t is string => typeof t === "string")
          : [];
        return topics.length > 0 ? { ...lead, topics } : lead;
      })
      .catch(() => lead);
    topicLookups.set(key, pending);
  }
  return pending;
}

function groupClusters(articles: Article[]): Cluster[] {
  const grouped = new Map<string, Cluster>();
  for (const article of articles) {
    const id = String(article.cluster_id);
    const published = Date.parse(article.ts_pub);
    const current = grouped.get(id);
    if (current) {
      current.articles.push(article);
      current.publishers.add(article.publisher);
      current.newest = Math.max(current.newest, published);
      if (article.score > current.maxScore) {
        current.maxScore = article.score;
        current.lead = article;
      }
      if (typeof article.x === "number") current.xs.push(article.x);
      continue;
    }
    grouped.set(id, {
      id,
      articles: [article],
      publishers: new Set([article.publisher]),
      newest: published,
      maxScore: article.score,
      lead: article,
      xs: typeof article.x === "number" ? [article.x] : [],
    });
  }
  return [...grouped.values()];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const secret = Deno.env.get("PRAXIS_CRON_SECRET");
  if (secret && req.headers.get("x-praxis-cron-secret") !== secret) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (Deno.env.get("PRAXIS_NEWS_ENABLED") === "false") {
    return new Response(JSON.stringify({ skipped: "disabled" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let forcedTime: { hour: number; minute: number } | null = null;
  let dry = Deno.env.get("PRAXIS_NEWS_DRY_RUN") === "true";
  try {
    const body = await req.json();
    // Test controls require the configured cron secret, just as the digest's do.
    if (secret && req.headers.get("x-praxis-cron-secret") === secret) {
      forcedTime = parseForcedTime(body?.force_local_time);
      if (body?.dry === true) dry = true;
    }
  } catch {
    // no/invalid body — the normal cron case
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const apiBase = (Deno.env.get("RECOMMENDER_API_URL") ?? "").replace(
      /\/$/,
      "",
    );
    const feedResponse = await fetch(`${apiBase}/v1/fallback-articles`, {
      headers: { "X-API-Key": Deno.env.get("RECOMMENDER_API_KEY") ?? "" },
    });
    if (!feedResponse.ok) {
      throw new Error(
        `fallback articles request failed: ${feedResponse.status}`,
      );
    }
    const feed = await feedResponse.json();
    const clusters = groupClusters((feed?.articles ?? []) as Article[]);

    const { data: tokens } = await supabase
      .from("push_tokens")
      .select("user_id, token, timezone");
    if (!tokens || tokens.length === 0) {
      return new Response(
        JSON.stringify({
          sent: 0,
          news: 0,
          three: 0,
          sides: 0,
          breaking: 0,
          split: 0,
          guests: 0,
          dry,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const eveningByUser = new Map<string, string[]>();
    const middayByUser = new Map<string, string[]>();
    const middayGuestTokens: string[] = [];
    const activeByUser = new Map<string, string[]>();
    const resultsByUser = new Map<string, string[]>();
    const electionDay = nyDateKey() === ELECTION_DAY;
    const guestTokens: string[] = [];
    // A device that registered before sign-in leaves a guest row behind with
    // the same token as its account row; sending to both double-pushes the
    // phone (seen on the digest, 2026-09-19). The account row wins.
    const ownedTokens = new Set(
      tokens.filter((t) => t.user_id).map((t) => t.token),
    );
    for (const token of tokens) {
      const time = forcedTime ?? localTime(token.timezone ?? FALLBACK_TIMEZONE);
      if (!time) continue;
      const evening = time.hour === 18 && time.minute < 20;
      const midday = time.hour === 12 && time.minute >= 20 && time.minute < 40;
      const quiet = time.hour >= 22 || time.hour <= 6;
      if (!token.user_id) {
        if (evening && !ownedTokens.has(token.token)) {
          guestTokens.push(token.token);
        }
        if (midday && !ownedTokens.has(token.token)) {
          middayGuestTokens.push(token.token);
        }
        continue;
      }
      if (midday) {
        const list = middayByUser.get(token.user_id) ?? [];
        list.push(token.token);
        middayByUser.set(token.user_id, list);
      }
      if (evening) {
        const list = eveningByUser.get(token.user_id) ?? [];
        list.push(token.token);
        eveningByUser.set(token.user_id, list);
      }
      if (!quiet) {
        const list = activeByUser.get(token.user_id) ?? [];
        list.push(token.token);
        activeByUser.set(token.user_id, list);
      }
      if (electionDay && time.hour >= 19 && time.hour <= 23) {
        const list = resultsByUser.get(token.user_id) ?? [];
        list.push(token.token);
        resultsByUser.set(token.user_id, list);
      }
    }

    const userIds = [
      ...new Set([
        ...eveningByUser.keys(),
        ...middayByUser.keys(),
        ...activeByUser.keys(),
        ...resultsByUser.keys(),
      ]),
    ];
    const { data: profiles } = userIds.length > 0
      ? await supabase.from("profiles").select("id, notify_news").in(
        "id",
        userIds,
      )
      : { data: [] };
    const since48h = new Date(Date.now() - 48 * 3600000).toISOString();
    const { data: recentPushes } = userIds.length > 0
      ? await supabase
        .from("push_log")
        .select("user_id, push_type, sent_at, meta")
        .in("user_id", userIds)
        .gte("sent_at", since48h)
      : { data: [] };
    const { data: alertedRows } = await supabase
      .from("push_log")
      .select("meta->>cluster_id")
      .not("meta->>cluster_id", "is", null)
      .limit(10000);
    const alertedClusters = new Set(
      (alertedRows ?? []).map((row) =>
        String(
          (row as Record<string, unknown>).cluster_id ??
            (row as Record<string, unknown>)["meta->>cluster_id"],
        )
      ),
    );

    const today = nyDateKey();
    const messages: unknown[] = [];
    const logRows: Array<
      { user_id: string; push_type: string; meta: Record<string, unknown> }
    > = [];
    let news = 0;
    let three = 0;
    let sides = 0;
    let breaking = 0;
    let split = 0;
    let guests = 0;

    const mine = (userId: string) =>
      (recentPushes ?? []).filter((row) => row.user_id === userId);
    const sentToday = (rows: typeof recentPushes, type: string) =>
      (rows ?? []).some((row) =>
        row.push_type === type && nyDateKey(new Date(row.sent_at)) === today
      );
    const sentWithin = (
      rows: typeof recentPushes,
      type: string,
      hours: number,
    ) =>
      (rows ?? []).some((row) =>
        row.push_type === type &&
        Date.now() - Date.parse(row.sent_at) < hours * 3600000
      );
    // Everything the user's digest said today — source titles when the log
    // has them (meta.titles, logged from 2026-09-19 on), the sent line always.
    const digestTextsFor = (rows: typeof recentPushes) => {
      const texts: string[] = [];
      for (const row of rows ?? []) {
        if (row.push_type !== "digest") continue;
        if (nyDateKey(new Date(row.sent_at)) !== today) continue;
        const meta = (row.meta ?? {}) as Record<string, unknown>;
        if (Array.isArray(meta.titles)) {
          for (const title of meta.titles) {
            if (typeof title === "string") texts.push(title);
          }
        }
        if (typeof meta.line === "string") texts.push(meta.line);
      }
      return texts;
    };
    const dailyCapped = (userId: string, rows: typeof recentPushes) =>
      (rows ?? []).filter((row) =>
            ["digest", "streak", "news", "breaking", "split"].includes(
              row.push_type,
            ) &&
            nyDateKey(new Date(row.sent_at)) === today
          ).length +
          logRows.filter((row) =>
            row.user_id === userId &&
            ["digest", "streak", "news", "breaking", "split"].includes(
              row.push_type,
            )
          ).length >= DAILY_CAP;

    const pushesToday = (userId: string, rows: typeof recentPushes) =>
      (rows ?? []).filter((row) =>
        ["digest", "streak", "news", "breaking", "split"].includes(row.push_type) &&
        nyDateKey(new Date(row.sent_at)) === today
      ).length +
      logRows.filter((row) =>
        row.user_id === userId &&
        ["digest", "streak", "news", "breaking", "split"].includes(row.push_type)
      ).length;
    // Clusters this user was pushed in the last 48 hours, any push type.
    const seenClusters = (rows: typeof recentPushes) => {
      const seen = new Set<string>();
      for (const row of rows ?? []) {
        const meta = (row.meta ?? {}) as Record<string, unknown>;
        if (meta.cluster_id != null) seen.add(String(meta.cluster_id));
        if (meta.cluster_id_2 != null) seen.add(String(meta.cluster_id_2));
        if (Array.isArray(meta.cluster_ids)) {
          for (const id of meta.cluster_ids) seen.add(String(id));
        }
      }
      return seen;
    };

    // 0. 3 stories right now: the three most-covered fresh stories, distinct
    // from each other and from what this user was already pushed. Needs a
    // slot left for the 6pm edition, so only when at most one push went out.
    const threeCandidates = clusters
      .filter((cluster) =>
        cluster.publishers.size >= THREE_MIN_PUBLISHERS &&
        withinHours(cluster.newest, THREE_MAX_AGE_HOURS)
      )
      .sort((a, b) =>
        b.publishers.size - a.publishers.size || b.maxScore - a.maxScore
      );
    const pickThree = (exclude: Set<string>, digestTexts: string[]) => {
      const picked: Array<{ cluster: Cluster; article: Article }> = [];
      for (const cluster of threeCandidates) {
        if (exclude.has(cluster.id)) continue;
        const article = plainHeadline(cluster);
        if (sharesStoryWith(article.title, digestTexts)) continue;
        if (picked.some((p) => sharesStoryWith(article.title, [p.article.title]))) continue;
        picked.push({ cluster, article });
        if (picked.length === 3) return picked;
      }
      return null;
    };
    const threeCopy = (picked: Array<{ article: Article }>) => ({
      title: "3 stories right now",
      body: picked.map((p, i) => `${i + 1}  ${p.article.title.trim()}`).join("\n"),
    });
    for (const profile of profiles ?? []) {
      const userTokens = middayByUser.get(profile.id);
      if (!userTokens || profile.notify_news === false) continue;
      const rows = mine(profile.id);
      if (pushesToday(profile.id, rows) > DAILY_CAP - 2) continue;
      if (rows.some((row) =>
        row.push_type === "news" && nyDateKey(new Date(row.sent_at)) === today &&
        (row.meta as Record<string, unknown> | null)?.slot === "midday"
      )) continue;
      const picked = pickThree(seenClusters(rows), digestTextsFor(rows));
      if (!picked || picked[0].cluster.publishers.size < 3) continue;
      const copy = threeCopy(picked);
      for (const token of userTokens) {
        messages.push({
          to: token,
          ...copy,
          data: {
            type: "news",
            articleId: picked[0].article.article_id,
            clusterId: picked[0].article.cluster_id,
          },
          sound: "default",
        });
        three += 1;
      }
      logRows.push({
        user_id: profile.id,
        push_type: "news",
        meta: {
          slot: "midday",
          kind: "three",
          cluster_id: picked[0].article.cluster_id,
          cluster_ids: picked.map((p) => p.article.cluster_id),
          article_ids: picked.map((p) => p.article.article_id),
          line: copy.body,
        },
      });
    }
    {
      const picked = middayGuestTokens.length > 0 ? pickThree(new Set(), []) : null;
      if (picked && picked[0].cluster.publishers.size >= 3) {
        const copy = threeCopy(picked);
        for (const token of middayGuestTokens) {
          messages.push({
            to: token,
            ...copy,
            data: {
              type: "news",
              articleId: picked[0].article.article_id,
              clusterId: picked[0].article.cluster_id,
            },
            sound: "default",
          });
          three += 1;
          guests += 1;
        }
      }
    }

    // Across the map candidates for the 6pm slot, best spread first.
    const sidesCandidates = clusters
      .filter((cluster) =>
        cluster.maxScore >= SIDES_MIN_SCORE &&
        withinHours(cluster.newest, SIDES_MAX_AGE_HOURS)
      )
      .map((cluster) => ({ cluster, trio: acrossTheMap(cluster) }))
      .filter((c): c is { cluster: Cluster; trio: Article[] } => c.trio !== null)
      // The topic line is the most central outlet's own headline; nothing
      // here can write a neutral label (the project's OpenAI key is dead).
      .map((c) => ({
        ...c,
        topic: [...c.trio].sort((a, b) => Math.abs(a.x ?? 0) - Math.abs(b.x ?? 0))[0]
          .title.trim().replace(/[.\s]+$/, ""),
      }))
      .sort((a, b) => b.cluster.maxScore - a.cluster.maxScore);
    const sidesMessage = (cluster: Cluster, trio: Article[], topic: string, to: string) => {
      const names = trio.map((a) => a.publisher);
      return {
        to,
        title: topic,
        body: `${trio.length} outlets from across the map: ${names.join(", ")}. See how each covers it →`,
        data: {
          type: "news",
          view: "sides",
          articleId: trio[0].article_id,
          articleIds: trio.map((a) => a.article_id),
          clusterId: cluster.id,
          topic,
          summary: (cluster.articles[0]?.cluster_summary ?? "").slice(0, 400),
        },
        sound: "default",
      };
    };

    const isElection = (cluster: Cluster) =>
      electionDay && ELECTION_STORY.test(cluster.lead.title);
    const eveningCandidates = clusters
      .filter((cluster) =>
        (cluster.maxScore >= 1.5 || (isElection(cluster) && cluster.maxScore >= 1.0)) &&
        withinHours(cluster.newest, 12)
      )
      .sort((a, b) =>
        Number(isElection(b)) - Number(isElection(a)) || b.maxScore - a.maxScore
      );

    // 1. Evening edition: one fresh cluster not sent to them in 48 hours.
    // One story per push (Ayuka, 2026-10-29): two stacked headlines read as
    // a clump on the lock screen.
    for (const profile of profiles ?? []) {
      const userTokens = eveningByUser.get(profile.id);
      if (!userTokens || profile.notify_news === false) continue;
      if ((mine(profile.id) ?? []).some((row) =>
        row.push_type === "news" && nyDateKey(new Date(row.sent_at)) === today &&
        (row.meta as Record<string, unknown> | null)?.slot !== "midday"
      )) continue;
      // Both stories of a past edition count as "already seen".
      const recentClusters = new Set<string>();
      for (const row of mine(profile.id)) {
        const meta = (row.meta ?? {}) as Record<string, unknown>;
        if (meta.cluster_id != null) recentClusters.add(String(meta.cluster_id));
        if (meta.cluster_id_2 != null) recentClusters.add(String(meta.cluster_id_2));
      }
      const digestTexts = digestTextsFor(mine(profile.id));
      const sidesRecently = mine(profile.id).some((row) =>
        (row.meta as Record<string, unknown> | null)?.kind === "sides" &&
        Date.now() - Date.parse(row.sent_at) < SIDES_EVERY_HOURS * 3600000
      );
      const sidesPick = sidesRecently ? undefined : sidesCandidates.find(({ cluster, trio }) =>
        !recentClusters.has(cluster.id) &&
        !trio.some((a) => sharesStoryWith(a.title, digestTexts))
      );
      if (sidesPick) {
        let line = "";
        for (const token of userTokens) {
          const message = sidesMessage(sidesPick.cluster, sidesPick.trio, sidesPick.topic, token);
          line = message.body;
          messages.push(message);
          sides += 1;
        }
        logRows.push({
          user_id: profile.id,
          push_type: "news",
          meta: {
            slot: "evening",
            kind: "sides",
            cluster_id: sidesPick.cluster.id,
            article_ids: sidesPick.trio.map((a) => a.article_id),
            title: sidesPick.topic,
            line,
          },
        });
        continue;
      }
      const selected = eveningCandidates.filter((cluster) =>
        !recentClusters.has(cluster.id) &&
        !sharesStoryWith(cluster.lead.title, digestTexts)
      );
      if (selected.length < 1) continue;
      const [first] = selected;
      const copy = eveningCopy(await withTopics(first.lead, apiBase));
      const line = copy.body;
      for (const token of userTokens) {
        messages.push({
          to: token,
          ...copy,
          data: {
            type: "news",
            articleId: first.lead.article_id,
            clusterId: first.lead.cluster_id,
          },
          sound: "default",
        });
        news += 1;
      }
      logRows.push({
        user_id: profile.id,
        push_type: "news",
        meta: {
          slot: "evening",
          cluster_id: first.lead.cluster_id,
          article_id: first.lead.article_id,
          line,
        },
      });
    }
    if (eveningCandidates.length >= 1) {
      const [first] = eveningCandidates;
      const guestCopy = guestTokens.length > 0
        ? eveningCopy(await withTopics(first.lead, apiBase))
        : null;
      for (const token of guestTokens) {
        messages.push({
          to: token,
          ...guestCopy,
          data: {
            type: "news",
            articleId: first.lead.article_id,
            clusterId: first.lead.cluster_id,
          },
          sound: "default",
        });
        news += 1;
        guests += 1;
      }
    }

    // 2. Breaking: a new, broad, high-score cluster, no more than once per user per day.
    const breakingCluster = clusters
      .filter((cluster) =>
        cluster.publishers.size >= BREAKING_MIN_PUBLISHERS &&
        withinHours(cluster.newest, BREAKING_MAX_AGE_HOURS) &&
        cluster.maxScore >= BREAKING_MIN_SCORE &&
        !alertedClusters.has(cluster.id)
      )
      .sort((a, b) =>
        b.publishers.size - a.publishers.size || b.maxScore - a.maxScore
      )[0];
    if (breakingCluster) {
      for (const profile of profiles ?? []) {
        const userTokens = activeByUser.get(profile.id);
        const rows = mine(profile.id);
        if (
          !userTokens || profile.notify_news === false ||
          dailyCapped(profile.id, rows) || sentWithin(rows, "breaking", 24)
        ) continue;
        const hasRecentDigest = rows.some((row) =>
          row.push_type === "digest" &&
          Date.now() - Date.parse(row.sent_at) < 2 * 3600000
        );
        if (hasRecentDigest) continue;
        if (sharesStoryWith(breakingCluster.lead.title, digestTextsFor(rows))) {
          continue; // the digest already told them this story today
        }
        const copy = breakingCopy(breakingCluster.lead);
        const line = copy.body;
        for (const token of userTokens) {
          messages.push({
            to: token,
            ...copy,
            data: {
              type: "breaking",
              articleId: breakingCluster.lead.article_id,
              clusterId: breakingCluster.lead.cluster_id,
            },
            sound: "default",
          });
          breaking += 1;
        }
        logRows.push({
          user_id: profile.id,
          push_type: "breaking",
          meta: {
            cluster_id: breakingCluster.lead.cluster_id,
            article_id: breakingCluster.lead.article_id,
            publishers: breakingCluster.publishers.size,
            line,
          },
        });
      }
      alertedClusters.add(breakingCluster.id);
    }

    // 2b. Election results: the best-covered fresh call, once per user tonight.
    const callOf = (cluster: Cluster) =>
      cluster.articles
        .filter((a) => ELECTION_CALL.test(a.title) && ELECTION_CONTEST.test(a.title))
        .sort((a, b) => b.score - a.score)[0];
    const resultsCluster = electionDay
      ? clusters
        .filter((cluster) =>
          cluster.publishers.size >= RESULTS_MIN_PUBLISHERS &&
          withinHours(cluster.newest, RESULTS_MAX_AGE_HOURS) &&
          !alertedClusters.has(cluster.id) && callOf(cluster)
        )
        .sort((a, b) =>
          b.publishers.size - a.publishers.size || b.maxScore - a.maxScore
        )[0]
      : undefined;
    if (resultsCluster) {
      const lead = callOf(resultsCluster)!;
      const copy = electionResultsCopy(lead);
      const newsToday = (userId: string, rows: typeof recentPushes) =>
        (rows ?? []).filter((row) =>
          ["digest", "news", "breaking", "split"].includes(row.push_type) &&
          nyDateKey(new Date(row.sent_at)) === today
        ).length +
        logRows.filter((row) =>
          row.user_id === userId &&
          ["digest", "news", "breaking", "split"].includes(row.push_type)
        ).length;
      for (const profile of profiles ?? []) {
        const userTokens = resultsByUser.get(profile.id);
        const rows = mine(profile.id);
        if (
          !userTokens || profile.notify_news === false ||
          newsToday(profile.id, rows) >= DAILY_CAP ||
          sentWithin(rows, "breaking", 6) ||
          logRows.some((row) => row.user_id === profile.id && row.push_type === "breaking")
        ) continue;
        for (const token of userTokens) {
          messages.push({
            to: token,
            ...copy,
            data: {
              type: "breaking",
              articleId: lead.article_id,
              clusterId: lead.cluster_id,
            },
            sound: "default",
          });
          breaking += 1;
        }
        logRows.push({
          user_id: profile.id,
          push_type: "breaking",
          meta: {
            kind: "election_results",
            cluster_id: lead.cluster_id,
            article_id: lead.article_id,
            publishers: resultsCluster.publishers.size,
            line: copy.body,
          },
        });
      }
      alertedClusters.add(resultsCluster.id);
    }

    // 3. Blind spot: a new cluster covered only by publishers on one side.
    const splitCluster = clusters
      .map((cluster) => ({
        cluster,
        side: cluster.articles.length === cluster.xs.length &&
            cluster.xs.every((x) => x <= -0.3)
          ? "left" as const
          : cluster.articles.length === cluster.xs.length &&
              cluster.xs.every((x) => x >= 0.3)
          ? "right" as const
          : null,
      }))
      .filter(({ cluster, side }) =>
        cluster.publishers.size >= SPLIT_MIN_PUBLISHERS && side !== null &&
        withinHours(cluster.newest, SPLIT_MAX_AGE_HOURS) &&
        cluster.maxScore >= SPLIT_MIN_SCORE &&
        !alertedClusters.has(cluster.id)
      )
      .sort((a, b) =>
        b.cluster.publishers.size - a.cluster.publishers.size ||
        b.cluster.maxScore - a.cluster.maxScore
      )[0];
    if (splitCluster?.side) {
      const { cluster, side } = splitCluster;
      const copy = blindSpotCopy(cluster.lead, side);
      const line = copy.body;
      for (const profile of profiles ?? []) {
        const userTokens = activeByUser.get(profile.id);
        const rows = mine(profile.id);
        if (
          !userTokens || profile.notify_news === false ||
          dailyCapped(profile.id, rows) || sentToday(rows, "split")
        ) continue;
        // Same guards the breaking path has: never inside the digest's
        // 2-hour window, never the story the digest already led with
        // (both fired together on 2026-09-19 and it read as spam).
        const hasRecentDigest = rows.some((row) =>
          row.push_type === "digest" &&
          Date.now() - Date.parse(row.sent_at) < 2 * 3600000
        );
        if (hasRecentDigest) continue;
        if (sharesStoryWith(cluster.lead.title, digestTextsFor(rows))) continue;
        for (const token of userTokens) {
          messages.push({
            to: token,
            ...copy,
            data: {
              type: "split",
              articleId: cluster.lead.article_id,
              clusterId: cluster.lead.cluster_id,
            },
            sound: "default",
          });
          split += 1;
        }
        logRows.push({
          user_id: profile.id,
          push_type: "split",
          meta: {
            cluster_id: cluster.lead.cluster_id,
            article_id: cluster.lead.article_id,
            side,
            line,
          },
        });
      }
    }

    // A dry run sends nothing AND logs nothing: a logged dry row would count
    // as "already sent" for dedupe, caps, and the alerted-cluster set, and
    // silently block the next real send. The would-be rows come back in the
    // response instead.
    if (!dry) {
      if (messages.length > 0) await chunkedExpoSend(messages);
      if (logRows.length > 0) await supabase.from("push_log").insert(logRows);
    }

    return new Response(
      JSON.stringify({
        sent: dry ? 0 : messages.length,
        news,
        three,
        sides,
        breaking,
        split,
        guests,
        dry,
        ...(dry ? { preview: logRows, wouldSend: messages.length } : {}),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
