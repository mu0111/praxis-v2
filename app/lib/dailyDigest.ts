import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { Article } from '../hooks/useFeedArticles';
import { supabase } from '../services/supabase';

const DAILY_DIGEST_STORAGE_KEY = 'praxis.mobileDailyDigest.v1';
const DAILY_DIGEST_DISMISSAL_STORAGE_KEY = 'praxis.mobileDigestDismissed.v1';
const DAILY_DIGEST_OPEN_REQUEST_KEY = 'praxis.mobileDigestOpenRequest.v1';
const DAILY_DIGEST_PANEL_HINT_STORAGE_KEY = 'praxis.mobileDigestPanelHint.v1';
const DAILY_DIGEST_STORY_COUNT = 5;
const DAILY_DIGEST_SELECTOR_VERSION = 7;
const memoryStorage = new Map<string, string>();
const dismissalMemoryStorage = new Map<string, string>();
const openRequestMemoryStorage = new Map<string, string>();
let digestMutationQueue: Promise<void> = Promise.resolve();

export interface DailyDigestState {
  date: string;
  articleIds: number[];
  completedIds: number[];
  // Saved copies of the digest stories. The top-news pool rotates all day,
  // so without these the digest was re-picked (and progress lost) as soon
  // as one of its stories fell out of the pool. Web keeps the same snapshot.
  articlesSnapshot?: Article[];
}

export interface DailyDigestFeed {
  state: DailyDigestState;
  displayArticles: Article[];
  digestArticles: Article[];
  completedCount: number;
  totalCount: number;
  isComplete: boolean;
}

interface DailyDigestDismissalState {
  date: string;
  selectorVersion: number;
  dismissed: boolean;
}

const getTodayKey = () => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
};

const readStorageValue = async () => {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(DAILY_DIGEST_STORAGE_KEY);
    }
    return memoryStorage.get(DAILY_DIGEST_STORAGE_KEY) ?? null;
  }

  try {
    return await AsyncStorage.getItem(DAILY_DIGEST_STORAGE_KEY);
  } catch (error) {
    console.warn('[dailyDigest] Failed to read state', error);
    return null;
  }
};

const writeStorageValue = async (state: DailyDigestState) => {
  const value = JSON.stringify(state);

  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(DAILY_DIGEST_STORAGE_KEY, value);
      return;
    }
    memoryStorage.set(DAILY_DIGEST_STORAGE_KEY, value);
    return;
  }

  try {
    await AsyncStorage.setItem(DAILY_DIGEST_STORAGE_KEY, value);
  } catch (error) {
    console.warn('[dailyDigest] Failed to write state', error);
  }
};

const ARTICLE_CATEGORIES: NonNullable<Article['category']>[] = [
  'business', 'tech', 'environment', 'sports', 'world',
];

// Accepts a mobile Article or a web NewsArticle (the canonical snapshot on
// the server is written by whichever client created the day's digest first)
// and returns a mobile Article, or null if it cannot be rendered.
export const normalizeSnapshotArticle = (raw: unknown): Article | null => {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, any>;
  const id = Number(c.id ?? c.article_id);
  const url = typeof c.url === 'string' ? c.url : '';
  if (!Number.isFinite(id) || id <= 0 || !url) return null;

  const publisherObject = c.publisher && typeof c.publisher === 'object' ? c.publisher : null;
  const publisherName: string | null =
    typeof publisherObject?.name === 'string' ? publisherObject.name
      : typeof c.publisher === 'string' ? c.publisher
        : typeof c.author === 'string' ? c.author
          : typeof c.source === 'string' ? c.source
            : null;
  const stringList = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const topics = stringList(c.topics).length > 0 ? stringList(c.topics) : stringList(c.meta?.topics);

  return {
    id,
    title: typeof c.title === 'string' ? c.title : 'Untitled',
    lede: typeof c.lede === 'string' ? c.lede
      : typeof c.subtitle === 'string' ? c.subtitle
        : typeof c.excerpt === 'string' ? c.excerpt
          : null,
    image_url: typeof c.image_url === 'string' ? c.image_url
      : typeof c.image === 'string' ? c.image
        : null,
    url,
    ts_pub: typeof c.ts_pub === 'string' ? c.ts_pub
      : typeof c.publishedAt === 'string' ? c.publishedAt
        : new Date().toISOString(),
    x: typeof c.x === 'number' && Number.isFinite(c.x) ? c.x : 0,
    y: typeof c.y === 'number' && Number.isFinite(c.y) ? c.y : 0,
    publisher: publisherName
      ? { name: publisherName, domain: typeof publisherObject?.domain === 'string' ? publisherObject.domain : '' }
      : null,
    topics,
    source: typeof c.source === 'string' ? c.source : publisherName ?? 'Unknown',
    category: ARTICLE_CATEGORIES.includes(c.category) ? c.category : 'world',
    meta: c.meta && typeof c.meta === 'object' ? c.meta : null,
    reasons: stringList(c.reasons).length > 0 ? stringList(c.reasons) : undefined,
  };
};

const normalizeState = (raw: Partial<DailyDigestState> | null | undefined): DailyDigestState => ({
  date: typeof raw?.date === 'string' ? raw.date : getTodayKey(),
  articleIds: Array.isArray(raw?.articleIds)
    ? raw.articleIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : [],
  completedIds: Array.isArray(raw?.completedIds)
    ? raw.completedIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : [],
  articlesSnapshot: Array.isArray(raw?.articlesSnapshot)
    ? raw.articlesSnapshot
        .map(normalizeSnapshotArticle)
        .filter((article): article is Article => Boolean(article))
    : [],
});

export const readDailyDigestState = async (): Promise<DailyDigestState> => {
  const raw = await readStorageValue();
  if (!raw) {
    return { date: getTodayKey(), articleIds: [], completedIds: [] };
  }

  try {
    return normalizeState(JSON.parse(raw) as Partial<DailyDigestState>);
  } catch (error) {
    console.warn('[dailyDigest] Failed to parse state', error);
    return { date: getTodayKey(), articleIds: [], completedIds: [] };
  }
};

export const readDailyDigestDismissal = async (): Promise<boolean> => {
  try {
    const raw = Platform.OS === 'web'
      ? typeof window !== 'undefined' && window.sessionStorage
        ? window.sessionStorage.getItem(DAILY_DIGEST_DISMISSAL_STORAGE_KEY)
        : dismissalMemoryStorage.get(DAILY_DIGEST_DISMISSAL_STORAGE_KEY) ?? null
      : dismissalMemoryStorage.get(DAILY_DIGEST_DISMISSAL_STORAGE_KEY) ?? null;
    if (!raw) return false;

    const state = JSON.parse(raw) as Partial<DailyDigestDismissalState>;
    return (
      state.date === getTodayKey() &&
      state.selectorVersion === DAILY_DIGEST_SELECTOR_VERSION &&
      state.dismissed === true
    );
  } catch (error) {
    console.warn('[dailyDigest] Failed to read dismissal state', error);
    return false;
  }
};

export const writeDailyDigestDismissal = async (dismissed: boolean) => {
  const value = JSON.stringify({
    date: getTodayKey(),
    selectorVersion: DAILY_DIGEST_SELECTOR_VERSION,
    dismissed,
  } satisfies DailyDigestDismissalState);

  try {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(DAILY_DIGEST_DISMISSAL_STORAGE_KEY, value);
        return;
      }
    }
    dismissalMemoryStorage.set(DAILY_DIGEST_DISMISSAL_STORAGE_KEY, value);
  } catch (error) {
    console.warn('[dailyDigest] Failed to write dismissal state', error);
  }
};

// A lightweight, session-only handoff lets Graph reopen today's Digest
// without adding another persistent Feed control.
// Graph "Apply" while the Digest is on screen (Ayuka, 2026-09-21 voice 2031):
// applying a Top News range keeps isTopNewsActive true, so the Digest stayed
// put and the new range never showed. The Graph raises this flag; the feed
// consumes it when it handles the next explicit request and dismisses the
// Digest for the day, exactly as the pill tap does. In-memory on purpose: it
// only ever needs to survive one navigation.
let digestExitRequested = false;

export const requestDailyDigestExit = () => {
  digestExitRequested = true;
};

export const consumeDailyDigestExitRequest = (): boolean => {
  const requested = digestExitRequested;
  digestExitRequested = false;
  return requested;
};

// Writers can also notify live subscribers: a push tapped while the feed is
// ALREADY focused never re-runs its focus effect, so without this the
// request sat unconsumed and fired on a later, unrelated tab switch
// ("randomly brings me to my old daily digest" — Ayuka, 2026-09-15).
const openRequestListeners = new Set<() => void>();

export const subscribeDailyDigestOpenRequest = (listener: () => void) => {
  openRequestListeners.add(listener);
  return () => {
    openRequestListeners.delete(listener);
  };
};

export const readDailyDigestOpenRequest = async (): Promise<boolean> => {
  try {
    const raw = Platform.OS === 'web'
      ? typeof window !== 'undefined' && window.sessionStorage
        ? window.sessionStorage.getItem(DAILY_DIGEST_OPEN_REQUEST_KEY)
        : openRequestMemoryStorage.get(DAILY_DIGEST_OPEN_REQUEST_KEY) ?? null
      : openRequestMemoryStorage.get(DAILY_DIGEST_OPEN_REQUEST_KEY) ?? null;
    return raw === getTodayKey();
  } catch (error) {
    console.warn('[dailyDigest] Failed to read open request', error);
    return false;
  }
};

export const writeDailyDigestOpenRequest = async (requested: boolean) => {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.sessionStorage) {
      if (requested) {
        window.sessionStorage.setItem(DAILY_DIGEST_OPEN_REQUEST_KEY, getTodayKey());
      } else {
        window.sessionStorage.removeItem(DAILY_DIGEST_OPEN_REQUEST_KEY);
      }
      return;
    }

    if (requested) {
      openRequestMemoryStorage.set(DAILY_DIGEST_OPEN_REQUEST_KEY, getTodayKey());
    } else {
      openRequestMemoryStorage.delete(DAILY_DIGEST_OPEN_REQUEST_KEY);
    }
  } catch (error) {
    console.warn('[dailyDigest] Failed to write open request', error);
  } finally {
    if (requested) openRequestListeners.forEach((listener) => listener());
  }
};

// Starting a new guest session should not inherit a prior signed-in user's
// completed rundown from this device.
export const resetDailyDigestForNewGuest = async () => {
  await writeStorageValue({
    date: getTodayKey(),
    articleIds: [],
    completedIds: [],
  });
  await writeDailyDigestDismissal(false);
  await writeDailyDigestOpenRequest(false);
};

export const readDailyDigestPanelHint = async (): Promise<boolean> => {
  try {
    if (Platform.OS === 'web') {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(DAILY_DIGEST_PANEL_HINT_STORAGE_KEY) === getTodayKey()
        : memoryStorage.get(DAILY_DIGEST_PANEL_HINT_STORAGE_KEY) === getTodayKey();
    }

    return await AsyncStorage.getItem(DAILY_DIGEST_PANEL_HINT_STORAGE_KEY) === getTodayKey();
  } catch (error) {
    console.warn('[dailyDigest] Failed to read panel hint', error);
    return false;
  }
};

export const writeDailyDigestPanelHint = async () => {
  const today = getTodayKey();
  try {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(DAILY_DIGEST_PANEL_HINT_STORAGE_KEY, today);
        return;
      }
      memoryStorage.set(DAILY_DIGEST_PANEL_HINT_STORAGE_KEY, today);
      return;
    }

    await AsyncStorage.setItem(DAILY_DIGEST_PANEL_HINT_STORAGE_KEY, today);
  } catch (error) {
    console.warn('[dailyDigest] Failed to write panel hint', error);
  }
};

// The digest used to re-pick from the top of the pool with no memory, so a
// story that stayed highly ranked came back day after day (The Hill's AI
// policy series, 2026-09-19). Remember the last three days of picks and
// skip them — by id, and by near-identical title, since the same story
// returns under a fresh headline. Mirrors the server's push dedupe.
const DIGEST_HISTORY_STORAGE_KEY = 'praxis.mobileDigestHistory.v1';
const DIGEST_HISTORY_DAYS = 3;

interface DigestHistoryEntry {
  date: string;
  articleIds: number[];
  titles: string[];
}

const historyMemoryStorage = new Map<string, string>();

const readDigestHistory = async (): Promise<DigestHistoryEntry[]> => {
  let raw: string | null = null;
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.localStorage) {
      raw = window.localStorage.getItem(DIGEST_HISTORY_STORAGE_KEY);
    } else {
      raw = historyMemoryStorage.get(DIGEST_HISTORY_STORAGE_KEY) ?? null;
    }
  } else {
    try {
      raw = await AsyncStorage.getItem(DIGEST_HISTORY_STORAGE_KEY);
    } catch (error) {
      console.warn('[dailyDigest] Failed to read digest history', error);
    }
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.date === 'string') : [];
  } catch {
    return [];
  }
};

const writeDigestHistory = async (entries: DigestHistoryEntry[]) => {
  const value = JSON.stringify(entries);
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(DIGEST_HISTORY_STORAGE_KEY, value);
    } else {
      historyMemoryStorage.set(DIGEST_HISTORY_STORAGE_KEY, value);
    }
    return;
  }
  try {
    await AsyncStorage.setItem(DIGEST_HISTORY_STORAGE_KEY, value);
  } catch (error) {
    console.warn('[dailyDigest] Failed to write digest history', error);
  }
};

const TITLE_STOPWORDS = new Set([
  'about', 'administration', 'after', 'against', 'america', 'american',
  'americans', 'amid', 'among', 'announces', 'because', 'before', 'being',
  'between', 'biden', 'breaking', 'calls', 'claims', 'congress', 'could',
  'court', 'democrat', 'democrats', 'during', 'every', 'federal', 'first',
  'former', 'house', 'might', 'nation', 'national', 'officials', 'other',
  'president', 'report', 'republican', 'republicans', 'says', 'senate',
  'should', 'state', 'states', 'their', 'there', 'these', 'things', 'times',
  'today', 'trump', 'under', 'vance', 'warns', 'white', 'whose', 'world',
  'would', 'years',
]);

const significantTitleWords = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 5 && !TITLE_STOPWORDS.has(word)),
  );

const isNearDuplicateTitle = (title: string, recentTitles: string[]): boolean => {
  const words = significantTitleWords(title);
  for (const recent of recentTitles) {
    let shared = 0;
    for (const word of significantTitleWords(recent)) {
      if (words.has(word) && ++shared >= 2) return true;
    }
  }
  return false;
};

interface DigestExclusions {
  ids: Set<number>;
  titles: string[];
}

const buildDigestExclusions = (history: DigestHistoryEntry[], today: string): DigestExclusions => {
  const ids = new Set<number>();
  const titles: string[] = [];
  for (const entry of history) {
    if (entry.date === today) continue; // today's own picks are not repeats
    for (const id of entry.articleIds ?? []) ids.add(id);
    for (const title of entry.titles ?? []) if (typeof title === 'string') titles.push(title);
  }
  return { ids, titles };
};

const scoreArticleForDigest = (article: Article, index: number) => {
  const hasSummary = article.meta?.summary || article.lede;
  const hasImage = article.image_url;
  const topicCount = article.topics?.length ?? 0;

  return (
    1000 - index +
    (hasSummary ? 30 : 0) +
    (hasImage ? 20 : 0) +
    Math.min(topicCount, 4) * 4
  );
};

const selectDigestArticles = (articles: Article[], exclusions?: DigestExclusions) => {
  const seenSources = new Set<string>();
  const selected: Article[] = [];
  const candidates = articles
    .filter((article) => article.url)
    .map((article, index) => ({
      article,
      score: scoreArticleForDigest(article, index),
      source: (article.publisher?.name || article.source || '').toLowerCase(),
    }))
    .sort((left, right) => right.score - left.score);

  const isRecentRepeat = (article: Article) =>
    Boolean(
      exclusions &&
        (exclusions.ids.has(article.id) ||
          (article.title && isNearDuplicateTitle(article.title, exclusions.titles))),
    );

  candidates.forEach((candidate) => {
    if (selected.length >= DAILY_DIGEST_STORY_COUNT) return;
    if (candidate.source && seenSources.has(candidate.source)) return;
    if (isRecentRepeat(candidate.article)) return;
    selected.push(candidate.article);
    if (candidate.source) seenSources.add(candidate.source);
  });

  candidates.forEach((candidate) => {
    if (selected.length >= DAILY_DIGEST_STORY_COUNT) return;
    if (selected.some((article) => article.id === candidate.article.id)) return;
    if (isRecentRepeat(candidate.article)) return;
    selected.push(candidate.article);
  });

  // A thin pool beats a short digest: only if skipping repeats leaves fewer
  // than five stories do repeats become eligible again.
  candidates.forEach((candidate) => {
    if (selected.length >= DAILY_DIGEST_STORY_COUNT) return;
    if (selected.some((article) => article.id === candidate.article.id)) return;
    selected.push(candidate.article);
  });

  return selected;
};

// Resolves a digest from preferred ids (stored or canonical), using the
// live pool first and saved snapshots second, then tops up to five stories
// and keeps only the completions that still belong to the digest. Mirrors
// the web's buildDigestFeedFromSelection.
const finalizeDigestSelection = async (
  articles: Article[],
  preferredIds: number[],
  snapshot: Article[],
  completedIds: number[],
): Promise<DailyDigestFeed> => {
  const today = getTodayKey();
  const history = await readDigestHistory();
  const exclusions = buildDigestExclusions(history, today);
  const articleById = new Map(articles.map((article) => [article.id, article]));
  const snapshotById = new Map(snapshot.map((article) => [article.id, article]));
  const resolve = (id: number) => articleById.get(id) ?? snapshotById.get(id);

  const digestArticles: Article[] = preferredIds.length > 0
    ? preferredIds
        .map(resolve)
        .filter((article): article is Article => Boolean(article))
    : selectDigestArticles(articles, exclusions);
  const has = (id: number) => digestArticles.some((article) => article.id === id);

  if (digestArticles.length < DAILY_DIGEST_STORY_COUNT) {
    for (const article of snapshot) {
      if (digestArticles.length >= DAILY_DIGEST_STORY_COUNT) break;
      if (!has(article.id)) digestArticles.push(article);
    }
    for (const article of selectDigestArticles(articles.filter((candidate) => !has(candidate.id)), exclusions)) {
      if (digestArticles.length >= DAILY_DIGEST_STORY_COUNT) break;
      digestArticles.push(article);
    }
  }

  const digestIds = digestArticles.map((article) => article.id);
  const nextCompletedIds = completedIds.filter((id) => digestIds.includes(id));
  const state: DailyDigestState = {
    date: today,
    articleIds: digestIds,
    completedIds: nextCompletedIds,
    articlesSnapshot: digestArticles,
  };

  await writeStorageValue(state);

  // Record today's picks so the next days can avoid repeating them.
  const nextHistory = [
    ...history.filter((entry) => entry.date !== today),
    {
      date: today,
      articleIds: digestIds,
      titles: digestArticles.map((article) => article.title).filter((t): t is string => Boolean(t)),
    },
  ]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-DIGEST_HISTORY_DAYS);
  await writeDigestHistory(nextHistory);

  const digestIdSet = new Set(digestIds);
  const remainingArticles = articles.filter((article) => !digestIdSet.has(article.id));

  return {
    state,
    // Keep the digest sequence stable while it is being read. Removing a
    // completed card shifts the deck underneath an active swipe gesture.
    displayArticles: [...digestArticles, ...remainingArticles],
    digestArticles,
    completedCount: nextCompletedIds.length,
    totalCount: digestArticles.length,
    isComplete: digestArticles.length > 0 && nextCompletedIds.length >= digestArticles.length,
  };
};

export const buildDailyDigestFeed = async (articles: Article[]): Promise<DailyDigestFeed> => {
  const today = getTodayKey();
  const currentState = await readDailyDigestState();
  const isToday = currentState.date === today;

  return finalizeDigestSelection(
    articles,
    isToday ? currentState.articleIds : [],
    isToday ? currentState.articlesSnapshot ?? [] : [],
    isToday ? currentState.completedIds : [],
  );
};

interface CanonicalDailyDigestPayload {
  article_ids?: unknown;
  digest_articles_snapshot?: unknown;
}

export const buildCanonicalDailyDigestFeed = async (
  articles: Article[],
): Promise<DailyDigestFeed> => {
  const localFeed = await buildDailyDigestFeed(articles);
  if (localFeed.digestArticles.length === 0) return localFeed;

  try {
    const { data, error } = await supabase.functions.invoke<CanonicalDailyDigestPayload>(
      'get-or-create-daily-digest',
      {
        body: {
          digestDate: getTodayKey(),
          selectorVersion: DAILY_DIGEST_SELECTOR_VERSION,
          digestArticleIds: localFeed.digestArticles.map((article) => String(article.id)),
          digestArticlesSnapshot: localFeed.digestArticles,
        },
      },
    );

    if (error) throw error;

    const canonicalIds = Array.isArray(data?.article_ids)
      ? data.article_ids.map(Number).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    if (canonicalIds.length === 0) return localFeed;

    const canonicalSnapshot = Array.isArray(data?.digest_articles_snapshot)
      ? data.digest_articles_snapshot
          .map(normalizeSnapshotArticle)
          .filter((article): article is Article => Boolean(article))
      : [];

    // The canonical digest is fixed for the day, so once it is stored
    // locally every later launch resolves the same five stories, from the
    // live pool when present and from the saved copies when not.
    return finalizeDigestSelection(
      articles,
      canonicalIds,
      [...canonicalSnapshot, ...localFeed.digestArticles],
      localFeed.state.completedIds,
    );
  } catch (error) {
    console.warn('[dailyDigest] Canonical digest unavailable; using local selection', error);
    return localFeed;
  }
};

export const markDailyDigestArticleComplete = async (
  articleId: number,
): Promise<DailyDigestState> => {
  const mutation = digestMutationQueue.then(async () => {
    const state = await readDailyDigestState();
    if (!state.articleIds.includes(articleId) || state.completedIds.includes(articleId)) {
      return state;
    }

    const nextState = {
      ...state,
      completedIds: [...state.completedIds, articleId],
    };

    await writeStorageValue(nextState);
    return nextState;
  });

  // Keep writes ordered even if one storage operation fails, so quick swipes
  // cannot race and overwrite another completed Digest story.
  digestMutationQueue = mutation.then(() => undefined, () => undefined);
  return mutation;
};

export const DAILY_DIGEST_TOTAL_STORIES = DAILY_DIGEST_STORY_COUNT;
