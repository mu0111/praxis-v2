import AsyncStorage from '@react-native-async-storage/async-storage';
import { Dimensions, Platform } from 'react-native';
import { supabase } from '../services/supabase';

// Mobile port of card-page/src/lib/analytics.ts. Event names, payload shapes and
// event_version stay identical to web so the server-side KPI views count both
// platforms; only the environment adapters (storage, device context, routing)
// differ. Web uses zod for payload validation — call sites here are typed, so
// validation is limited to the guards below rather than adding a dependency.

const DEVICE_KEY = 'analytics_device_id';
const EVENT_VERSION = 1;

const ARTICLE_TOPIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'at',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'as', 'it', 'that', 'this',
]);

export type FeedMode = 'top_news' | 'personalized' | 'query';
export type Surface =
  | 'home_feed'
  | 'article_detail'
  | 'preferences'
  | 'auth'
  | 'saved_articles'
  | 'read_articles'
  | 'search'
  | 'profile'
  | 'leaderboard'
  | 'graph'
  | 'other';
export type BiasBucket = 'left' | 'center' | 'right';
export type CompletionMethod = 'swipe' | 'open' | 'detail_page';

export type AnalyticsEventName =
  | 'page_view'
  | 'session_start'
  | 'push_open'
  | 'session_end'
  | 'signup'
  | 'sign_in'
  | 'article_impression'
  | 'article_open'
  | 'article_read_complete'
  | 'bookmark_add'
  | 'bookmark_remove'
  | 'ai_analysis_open'
  | 'preferences_apply'
  | 'feed_load'
  | 'ui_stall'
  | 'app_error';

// The mobile feed uses 'top-news'; the analytics schema (and web) use 'top_news'.
export const normalizeFeedMode = (mode: string | null | undefined): FeedMode | undefined => {
  if (!mode) return undefined;
  if (mode === 'top-news') return 'top_news';
  if (mode === 'top_news' || mode === 'personalized' || mode === 'query') return mode;
  return undefined;
};

const generateId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let cachedDeviceId: string | null = null;
const getDeviceId = async () => {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const existing = await AsyncStorage.getItem(DEVICE_KEY);
    if (existing) {
      cachedDeviceId = existing;
      return existing;
    }
    const next = generateId();
    await AsyncStorage.setItem(DEVICE_KEY, next);
    cachedDeviceId = next;
    return next;
  } catch {
    return null;
  }
};

// Sessions are app-lifecycle scoped (foreground stretches), managed in memory by
// startSession/endSession via the AppState listener in app/_layout.tsx.
let sessionId: string | null = null;
let sessionStart: number | null = null;

const getSessionId = (createIfMissing: boolean) => {
  if (sessionId) return sessionId;
  if (!createIfMissing) return null;
  sessionId = generateId();
  return sessionId;
};

// expo-router pathname, pushed in by the tracker in app/_layout.tsx.
let currentPath = '/';
export const setCurrentAnalyticsPath = (path: string) => {
  currentPath = path || '/';
};

export const getCurrentAnalyticsPath = () => currentPath;

const getDeviceContext = () => {
  const { width, height } = Dimensions.get('window');
  const isMobile = Platform.OS !== 'web' || width < 768;
  return {
    device_type: isMobile ? 'mobile' : 'desktop',
    os: Platform.OS,
    viewport_width: Math.round(width),
    viewport_height: Math.round(height),
  };
};

const inferSurface = (path: string): Surface => {
  if (path === '/' || path === '/index') return 'home_feed';
  if (path.startsWith('/article/')) return 'article_detail';
  if (path.startsWith('/login') || path.startsWith('/signup')) return 'auth';
  if (path.startsWith('/saved') || path.startsWith('/modal/saved-articles')) return 'saved_articles';
  if (path.startsWith('/modal/read-articles')) return 'read_articles';
  if (path.startsWith('/search')) return 'search';
  if (path.startsWith('/profile')) return 'profile';
  if (path.startsWith('/modal/leaderboard')) return 'leaderboard';
  if (path.startsWith('/graph')) return 'graph';
  return 'other';
};

const removeUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, removeUndefined(entry)]),
    );
  }
  return value;
};

const ARTICLE_EVENTS = new Set<AnalyticsEventName>([
  'article_impression',
  'article_open',
  'article_read_complete',
  'bookmark_add',
  'bookmark_remove',
  'ai_analysis_open',
]);

type TrackOverrides = {
  userId?: string | null;
  sessionId?: string | null;
  createSession?: boolean;
};

export const trackEvent = async (
  eventName: AnalyticsEventName,
  properties: Record<string, unknown>,
  overrides: TrackOverrides = {},
) => {
  try {
    if (ARTICLE_EVENTS.has(eventName) && !properties.article_id) {
      console.warn('analytics_event_validation_failed', { eventName, properties });
      return;
    }

    const { data } = await supabase.auth.getSession();
    const userId = overrides.userId ?? data.session?.user?.id ?? null;
    const eventSessionId =
      overrides.sessionId ?? getSessionId(overrides.createSession ?? false);
    const deviceId = await getDeviceId();

    const enrichedProperties = removeUndefined({
      ...properties,
      ...getDeviceContext(),
      event_version: EVENT_VERSION,
      current_path: currentPath,
      surface: properties.surface ?? inferSurface(currentPath),
      auth_state: userId ? 'authenticated' : 'anonymous',
    });

    await supabase.from('analytics_events').insert({
      event_name: eventName,
      user_id: userId,
      session_id: eventSessionId,
      device_id: deviceId,
      properties: enrichedProperties as Record<string, unknown>,
    });
  } catch (error) {
    console.warn('analytics_event_failed', { eventName, error });
  }
};

export type ArticleAnalyticsContext = {
  articleId: string;
  title?: string | null;
  source?: string | null;
  url?: string | null;
  articleTopic?: string | null;
  biasScore?: number | null;
  biasBucket?: BiasBucket | null;
  articleX?: number | null;
  articleY?: number | null;
  surface?: Surface;
  feedMode?: FeedMode;
  positionInFeed?: number;
  topics?: string[];
};

type ArticleAnalyticsSource = {
  id: string | number;
  title?: string | null;
  source?: string | null;
  url?: string | null;
  category?: string | null;
  x?: number | null;
  y?: number | null;
  meta?: Record<string, unknown> | null;
};

const normalizeArticleTopic = (value: string | null | undefined) => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const deriveArticleTopic = (
  article: Pick<ArticleAnalyticsSource, 'title' | 'category' | 'meta'>,
) => {
  const meta = article.meta ?? {};
  const typedMeta = meta as Record<string, unknown>;
  const directTopic = normalizeArticleTopic(
    typeof typedMeta.topic === 'string' ? typedMeta.topic : null,
  );
  if (directTopic) return directTopic;

  const primaryTopic = normalizeArticleTopic(
    typeof typedMeta.primary_topic === 'string' ? typedMeta.primary_topic : null,
  );
  if (primaryTopic) return primaryTopic;

  const clusterTopic = normalizeArticleTopic(
    typeof typedMeta.cluster_topic === 'string' ? typedMeta.cluster_topic : null,
  );
  if (clusterTopic) return clusterTopic;

  const clusterId = normalizeArticleTopic(
    typeof typedMeta.cluster_id === 'string'
      ? typedMeta.cluster_id
      : typeof typedMeta.cluster_id === 'number'
        ? String(typedMeta.cluster_id)
        : null,
  );
  if (clusterId) return clusterId;

  if (Array.isArray(typedMeta.topics)) {
    const firstTopic = typedMeta.topics.find(
      (entry): entry is string =>
        typeof entry === 'string' && normalizeArticleTopic(entry) !== null,
    );
    const normalized = normalizeArticleTopic(firstTopic);
    if (normalized) return normalized;
  }

  const fromTitle = (article.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !ARTICLE_TOPIC_STOPWORDS.has(word))
    .slice(0, 3)
    .join('-');
  if (fromTitle) return fromTitle;

  return normalizeArticleTopic(article.category) ?? 'unknown';
};

export const deriveBiasScore = (x: number | null | undefined) => {
  if (typeof x !== 'number' || Number.isNaN(x)) return null;
  return Math.round(Math.max(-1, Math.min(1, x)) * 100);
};

// Raw map position, kept alongside the derived bias fields: bias_score
// collapses x and drops y entirely, and the profile month-map (and its
// tappable dots) needs both axes per read.
const normalizeCoordinate = (value: number | null | undefined) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.round(Math.max(-1, Math.min(1, value)) * 1000) / 1000;
};

export const deriveBiasBucket = (biasScore: number | null | undefined) => {
  if (typeof biasScore !== 'number' || Number.isNaN(biasScore)) return null;
  if (biasScore < -10) return 'left' as const;
  if (biasScore > 10) return 'right' as const;
  return 'center' as const;
};

export const buildArticleAnalyticsContext = (
  article: ArticleAnalyticsSource,
  extras: Omit<
    ArticleAnalyticsContext,
    | 'articleId'
    | 'title'
    | 'source'
    | 'url'
    | 'articleTopic'
    | 'biasScore'
    | 'biasBucket'
    | 'articleX'
    | 'articleY'
  > = {},
): ArticleAnalyticsContext => {
  const biasScore = deriveBiasScore(article.x);

  return {
    articleId: String(article.id),
    title: article.title ?? null,
    source: article.source ?? null,
    url: article.url ?? null,
    articleTopic: deriveArticleTopic(article),
    biasScore,
    biasBucket: deriveBiasBucket(biasScore),
    articleX: normalizeCoordinate(article.x),
    articleY: normalizeCoordinate(article.y),
    ...extras,
  };
};

const buildArticlePayload = (context: ArticleAnalyticsContext) => ({
  article_id: context.articleId,
  title: context.title ?? null,
  source: context.source ?? null,
  url: context.url ?? null,
  article_topic: context.articleTopic ?? null,
  bias_score: context.biasScore ?? null,
  bias_bucket: context.biasBucket ?? null,
  article_x: context.articleX ?? null,
  article_y: context.articleY ?? null,
  surface: context.surface,
  feed_mode: context.feedMode,
  position_in_feed: context.positionInFeed,
  topics: context.topics,
});

// Where the next session came from. The push tap handler sets it and the
// session_start that follows consumes it. A tap on an already-open app never
// starts a session, so the "from a push" question is answered by push_open
// events (same session id), not by this field alone — and a cold start whose
// session begins before the tap replay resolves still gets the push_open.
let pendingSessionSource: { source: string; push_type?: string } | null = null;

export const setPendingSessionSource = (source: string, pushType?: string) => {
  pendingSessionSource = { source, ...(pushType ? { push_type: pushType } : {}) };
};

export const trackPushOpen = async (
  pushType: string,
  articleId?: string | number | null,
) => {
  // Only stamp the pending source when no session is live: a tap on an open
  // app belongs to the current session (the push_open row carries its id),
  // and a stale flag would mislabel a LATER organic session as push-driven.
  // Cold starts can still race startSession — the push_open/session_id join
  // stays the exact source of truth for "from a push".
  if (!sessionId) setPendingSessionSource('push', pushType);
  await trackEvent('push_open', {
    push_type: pushType,
    article_id: articleId == null ? null : String(articleId),
  });
};

export const startSession = async () => {
  if (sessionId) return;
  const nextSessionId = getSessionId(true);
  sessionStart = Date.now();
  const attribution = pendingSessionSource ?? { source: 'organic' };
  pendingSessionSource = null;
  await trackEvent('session_start', { ...attribution }, { sessionId: nextSessionId, createSession: true });
};

export const endSession = async () => {
  if (!sessionId || !sessionStart) return;
  const durationSeconds = Math.max(0, Math.round((Date.now() - sessionStart) / 1000));
  const endingSessionId = sessionId;
  sessionId = null;
  sessionStart = null;
  await trackEvent(
    'session_end',
    { duration_seconds: durationSeconds },
    { sessionId: endingSessionId },
  );
};

export const trackPageView = async (path: string) => {
  setCurrentAnalyticsPath(path);
  await trackEvent(
    'page_view',
    { path, surface: inferSurface(path) },
    { createSession: true },
  );
};

export const trackArticleImpression = async (context: ArticleAnalyticsContext) => {
  await trackEvent('article_impression', buildArticlePayload(context));
};

export const trackArticleOpen = async (context: ArticleAnalyticsContext) => {
  await trackEvent('article_open', buildArticlePayload(context));
};

export const trackArticleReadComplete = async (
  context: ArticleAnalyticsContext & { completionMethod: CompletionMethod },
) => {
  await trackEvent('article_read_complete', {
    ...buildArticlePayload(context),
    completion_method: context.completionMethod,
  });
};

export const trackBookmarkChange = async (
  action: 'bookmark_add' | 'bookmark_remove',
  context: ArticleAnalyticsContext,
) => {
  await trackEvent(action, buildArticlePayload(context));
};

export const trackAIAnalysisOpen = async (context: ArticleAnalyticsContext) => {
  await trackEvent('ai_analysis_open', buildArticlePayload(context));
};

export const trackAuth = async (event: 'sign_in' | 'signup', method: string) => {
  await trackEvent(event, { method });
};

export const trackFeedLoad = async (context: {
  feedMode: FeedMode;
  articleCount: number;
  sourceCount?: number;
  topicCount?: number;
}) => {
  await trackEvent('feed_load', {
    feed_mode: context.feedMode,
    article_count: context.articleCount,
    source_count: context.sourceCount,
    topic_count: context.topicCount,
  });
};
