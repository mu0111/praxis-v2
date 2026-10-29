import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const STORAGE_PREFIX = 'praxis.readingActivity.v1';
const memoryStorage = new Map<string, string>();

export interface ReadingActivityEntry {
  articleId: number;
  readAt: string;
  topics: string[];
  title?: string;
}

export interface ReadingActivityDayBucket {
  day: string;
  date: string;
  count: number;
}

export interface ReadingActivitySummary {
  totalArticlesRead: number;
  currentStreak: number;
  readsToday: number;
  readsThisWeek: number;
  weekBuckets: ReadingActivityDayBucket[];
  topTopics: Array<{ topic: string; count: number }>;
}

type ReadingActivityListener = (summary: ReadingActivitySummary) => void;

const listeners = new Map<string, Set<ReadingActivityListener>>();
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// YYYY-MM-DD on the phone's own calendar. toISOString() gives the UTC date,
// so in the US every read after ~8 PM landed on tomorrow's bar and "reads
// today" dropped to 0 (QA 2026-10-28).
export const toLocalDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const buildStorageKey = (userId?: string | null) => `${STORAGE_PREFIX}:${userId ?? 'guest'}`;

const readStorageValue = async (key: string) => {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key);
    }
    return memoryStorage.get(key) ?? null;
  }

  try {
    return await AsyncStorage.getItem(key);
  } catch (error) {
    console.warn('[readingActivity] Failed to read storage', error);
    return null;
  }
};

const writeStorageValue = async (key: string, value: string) => {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
      return;
    }
    memoryStorage.set(key, value);
    return;
  }

  try {
    await AsyncStorage.setItem(key, value);
  } catch (error) {
    console.warn('[readingActivity] Failed to write storage', error);
  }
};

const normalizeEntry = (entry: Partial<ReadingActivityEntry>): ReadingActivityEntry | null => {
  const articleId = Number(entry.articleId);
  if (!Number.isFinite(articleId) || articleId <= 0) return null;

  return {
    articleId,
    readAt: entry.readAt || new Date().toISOString(),
    topics: Array.isArray(entry.topics)
      ? entry.topics.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
      : [],
    title: typeof entry.title === 'string' ? entry.title : undefined,
  };
};

const sortEntries = (entries: ReadingActivityEntry[]) =>
  [...entries].sort((left, right) =>
    new Date(right.readAt).getTime() - new Date(left.readAt).getTime(),
  );

const buildEmptySummary = (): ReadingActivitySummary => {
  const buckets: ReadingActivityDayBucket[] = [];

  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - i);

    buckets.push({
      day: DAY_LABELS[date.getDay()],
      date: toLocalDateKey(date),
      count: 0,
    });
  }

  return {
    totalArticlesRead: 0,
    currentStreak: 0,
    readsToday: 0,
    readsThisWeek: 0,
    weekBuckets: buckets,
    topTopics: [],
  };
};

const buildSummary = (entries: ReadingActivityEntry[]): ReadingActivitySummary => {
  const summary = buildEmptySummary();
  if (entries.length === 0) return summary;

  const dateCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();

  entries.forEach((entry) => {
    const date = new Date(entry.readAt);
    if (Number.isNaN(date.getTime())) return;

    const dateKey = toLocalDateKey(date);
    dateCounts.set(dateKey, (dateCounts.get(dateKey) ?? 0) + 1);

    entry.topics.forEach((topic) => {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    });
  });

  summary.totalArticlesRead = entries.length;
  summary.weekBuckets = summary.weekBuckets.map((bucket) => ({
    ...bucket,
    count: dateCounts.get(bucket.date) ?? 0,
  }));
  summary.readsThisWeek = summary.weekBuckets.reduce((total, bucket) => total + bucket.count, 0);
  summary.readsToday = summary.weekBuckets[summary.weekBuckets.length - 1]?.count ?? 0;
  summary.topTopics = [...topicCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const cursor = new Date(today);
    cursor.setDate(today.getDate() - i);
    const key = toLocalDateKey(cursor);
    if ((dateCounts.get(key) ?? 0) > 0) {
      streak += 1;
      continue;
    }

    break;
  }

  summary.currentStreak = streak;
  return summary;
};

const emitSummary = async (userId?: string | null) => {
  const storageKey = buildStorageKey(userId);
  const scopedListeners = listeners.get(storageKey);
  if (!scopedListeners?.size) return;

  const entries = await readReadingActivityEntries(userId);
  const summary = buildSummary(entries);
  scopedListeners.forEach((listener) => listener(summary));
};

export const readReadingActivityEntries = async (
  userId?: string | null,
): Promise<ReadingActivityEntry[]> => {
  const raw = await readStorageValue(buildStorageKey(userId));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return sortEntries(
      parsed
        .map((entry) => normalizeEntry(entry))
        .filter((entry): entry is ReadingActivityEntry => Boolean(entry)),
    );
  } catch (error) {
    console.warn('[readingActivity] Failed to parse entries', error);
    return [];
  }
};

export const writeReadingActivityEntries = async (
  userId: string | null | undefined,
  entries: ReadingActivityEntry[],
) => {
  const normalized = sortEntries(
    entries
      .map((entry) => normalizeEntry(entry))
      .filter((entry): entry is ReadingActivityEntry => Boolean(entry)),
  );

  await writeStorageValue(buildStorageKey(userId), JSON.stringify(normalized));
  await emitSummary(userId);
  return normalized;
};

export const logArticleRead = async (
  userId: string | null | undefined,
  article: {
    id: number;
    topics?: string[];
    title?: string;
  },
) => {
  const entries = await readReadingActivityEntries(userId);
  const existing = entries.find((entry) => entry.articleId === article.id);

  if (existing) {
    return entries;
  }

  return writeReadingActivityEntries(userId, [
    {
      articleId: article.id,
      readAt: new Date().toISOString(),
      topics: article.topics ?? [],
      title: article.title,
    },
    ...entries,
  ]);
};

export const readReadingActivitySummary = async (
  userId?: string | null,
): Promise<ReadingActivitySummary> => {
  const entries = await readReadingActivityEntries(userId);
  return buildSummary(entries);
};

export const subscribeReadingActivity = (
  userId: string | null | undefined,
  listener: ReadingActivityListener,
) => {
  const storageKey = buildStorageKey(userId);
  const scoped = listeners.get(storageKey) ?? new Set<ReadingActivityListener>();
  scoped.add(listener);
  listeners.set(storageKey, scoped);

  void readReadingActivitySummary(userId).then(listener);

  return () => {
    const next = listeners.get(storageKey);
    if (!next) return;
    next.delete(listener);
    if (next.size === 0) {
      listeners.delete(storageKey);
    }
  };
};

// The server's update_reading_streak RPC increments on every call made on a
// day after a prior read day, so calling it per article inflates streaks by the
// article count. Gate it to once per UTC day per user (UTC matches the RPC's
// CURRENT_DATE). Returns true when the caller should run the RPC.
const STREAK_CLAIM_PREFIX = 'praxis.streakRpcDate.v1';

export const claimDailyStreakUpdate = async (userId: string): Promise<boolean> => {
  const key = `${STREAK_CLAIM_PREFIX}:${userId}`;
  const today = new Date().toISOString().split('T')[0];
  try {
    const last = await AsyncStorage.getItem(key);
    if (last === today) return false;
    await AsyncStorage.setItem(key, today);
  } catch (error) {
    console.warn('[readingActivity] Failed to read/write streak claim', error);
  }
  return true;
};
