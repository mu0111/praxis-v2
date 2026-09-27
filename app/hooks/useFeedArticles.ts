import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  ActiveQueryState,
  buildFeedPreferenceSignature,
  readRecommendationRequest,
  RecommendationRequestState,
  TopNewsGraphFilterState,
} from '../lib/newsPreferences';
import {
  getRecommenderConfig,
  getRecommenderHeaders,
} from '../lib/recommenderConfig';
import {
  getMockPersonalizedArticles,
  getMockTopNewsArticles,
  getMockTopicArticles,
} from '../lib/mockPreviewData';
import { supabase } from '../services/supabase';
import { normalizeFeedMode, trackFeedLoad } from '../lib/analytics';

export interface Article {
  id: number;
  title: string;
  lede: string | null;
  image_url: string | null;
  url: string;
  ts_pub: string;
  x: number;
  y: number;
  publisher: { name: string; domain: string } | null;
  topics: string[];
  source?: string;
  category?: 'business' | 'tech' | 'environment' | 'sports' | 'world';
  meta?: {
    summary?: string;
    x_explanation?: string;
    y_explanation?: string;
    topics?: string[];
    [key: string]: any;
  } | null;
  reasons?: string[];
}

type FeedMode = 'top-news' | 'personalized' | 'query';

interface FallbackArticlePayload {
  id?: string | number;
  article_id?: number;
  title?: string;
  subtitle?: string;
  lede?: string;
  publisher?: string;
  source?: string;
  image?: string;
  image_url?: string;
  publishedAt?: string;
  published_at?: string;
  ts_pub?: string;
  url?: string;
  x?: number;
  y?: number;
  topics?: string[];
  category?: Article['category'];
  reasons?: string[];
  meta?: {
    summary?: string;
    x_explanation?: string;
    y_explanation?: string;
    topics?: string[];
    [key: string]: any;
  };
}

interface FeedCacheState {
  articles: Article[];
  currentIndex: number;
  feedMode: FeedMode;
  preferenceSignature: string | null;
}

interface LoadPreferencesParams {
  activeQuery: ActiveQueryState | null;
  recommendationRequest: RecommendationRequestState | null;
  prefetchedQueryArticles?: Article[] | null;
  isTopNewsActive: boolean;
  topNewsGraphFilter: TopNewsGraphFilterState | null;
  profileTopics: string[];
}

const RECENCY_HOURS_PROGRESSION = [168, 336, 504, 720];
const DEFAULT_QUERY_RADIUS = 0.25;
const FEED_CACHE_KEY = '__PRAXIS_MOBILE_FEED_CACHE__';
const FEED_CACHE_STORAGE_KEY = 'praxis.mobileFeedCache.v1';
const LIVE_ARTICLE_CACHE_TTL_MS = 5 * 60 * 1000;
const liveArticleRequestCache = new Map<string, {
  expiresAt: number;
  articles: Article[];
}>();
const EMPTY_FEED_CACHE: FeedCacheState = {
  articles: [],
  currentIndex: 0,
  feedMode: 'top-news',
  preferenceSignature: null,
};

const getFeedCache = (): FeedCacheState => {
  const scope = globalThis as typeof globalThis & {
    [FEED_CACHE_KEY]?: FeedCacheState;
  };

  if (!scope[FEED_CACHE_KEY]) {
    scope[FEED_CACHE_KEY] = { ...EMPTY_FEED_CACHE };
  }

  return scope[FEED_CACHE_KEY]!;
};

const readPersistedFeedCache = (): FeedCacheState => {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return { ...EMPTY_FEED_CACHE };
  }

  try {
    const raw = window.sessionStorage.getItem(FEED_CACHE_STORAGE_KEY);
    if (!raw) {
      return { ...EMPTY_FEED_CACHE };
    }

    const parsed = JSON.parse(raw) as Partial<FeedCacheState>;
    return {
      articles: Array.isArray(parsed.articles) ? parsed.articles as Article[] : [],
      currentIndex: typeof parsed.currentIndex === 'number' ? parsed.currentIndex : 0,
      feedMode:
        parsed.feedMode === 'query' ||
        parsed.feedMode === 'personalized' ||
        parsed.feedMode === 'top-news'
          ? parsed.feedMode
          : 'top-news',
      preferenceSignature:
        typeof parsed.preferenceSignature === 'string'
          ? parsed.preferenceSignature
          : null,
    };
  } catch (error) {
    console.warn('[useFeedArticles] Failed to read cached feed state', error);
    return { ...EMPTY_FEED_CACHE };
  }
};

const persistFeedCache = (next: FeedCacheState) => {
  if (typeof window === 'undefined' || !window.sessionStorage) return;

  try {
    window.sessionStorage.setItem(FEED_CACHE_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('[useFeedArticles] Failed to persist feed state', error);
  }
};

const parseNumericId = (value?: string | number) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Math.floor(Math.random() * 1_000_000_000);
};

const getPoliticalLeanLabel = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Political Lean';
  if (value <= -0.6) return 'Left';
  if (value <= -0.2) return 'Center Left';
  if (value < 0.2) return 'Center';
  if (value < 0.6) return 'Center Right';
  return 'Right';
};

const getReportingTypeLabel = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Reporting Type';
  if (value <= -0.45) return 'Opinion';
  if (value < 0.2) return 'Mixed';
  return 'Hard News';
};

const normalizeArticleCoordinate = (value?: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  if (Math.abs(value) <= 1) {
    return value;
  }

  return Math.max(-1, Math.min(1, value / 100));
};

const isSafePreviewArticle = (article: FallbackArticlePayload) =>
  typeof article.url === 'string' && article.url.includes('example.com/praxis-preview/');

const buildSafePreviewMeta = (article: FallbackArticlePayload) => {
  if (!isSafePreviewArticle(article)) return article.meta || null;

  const x = typeof article.x === 'number' ? normalizeArticleCoordinate(article.x) : undefined;
  const y = typeof article.y === 'number' ? normalizeArticleCoordinate(article.y) : undefined;
  const publisher = article.publisher || article.source || 'This outlet';
  const topics = Array.isArray(article.topics)
    ? article.topics.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
    : Array.isArray(article.meta?.topics)
      ? article.meta.topics.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
      : [];
  const leadTopic = topics[0] || 'this story';
  const secondaryTopic = topics[1] || topics[0] || 'the news cycle';
  const summary = article.meta?.summary || article.lede || article.subtitle;

  return {
    ...article.meta,
    summary,
    topics,
    x_explanation:
      article.meta?.x_explanation ||
      `${publisher} approaches ${leadTopic.toLowerCase()} from a ${getPoliticalLeanLabel(x).toLowerCase()} vantage point, highlighting the tradeoffs and actors it sees as most important.`,
    y_explanation:
      article.meta?.y_explanation ||
      `${publisher} presents ${secondaryTopic.toLowerCase()} in a ${getReportingTypeLabel(y).toLowerCase()} style, shaping whether the piece feels more interpretive or more straight-news.`,
  };
};

const buildSafePreviewReasons = (article: FallbackArticlePayload) => {
  if (Array.isArray(article.reasons) && article.reasons.length > 0) {
    return article.reasons;
  }

  if (!isSafePreviewArticle(article)) {
    return [];
  }

  const reasons = [
    typeof article.publisher === 'string' ? `${article.publisher} coverage` : null,
    typeof article.category === 'string' ? `${article.category} context` : null,
    Array.isArray(article.topics) && article.topics[0]
      ? `${article.topics[0]} relevance`
      : Array.isArray(article.meta?.topics) && article.meta.topics[0]
        ? `${article.meta.topics[0]} relevance`
      : null,
  ].filter((value): value is string => Boolean(value));

  return reasons;
};

const mapFallbackArticle = (article: FallbackArticlePayload): Article => ({
  id: parseNumericId(article.article_id ?? article.id),
  title: article.title || 'Untitled',
  lede: article.lede || article.subtitle || null,
  image_url: article.image_url || article.image || null,
  url: article.url || '',
  ts_pub: article.ts_pub || article.published_at || article.publishedAt || new Date().toISOString(),
  x: normalizeArticleCoordinate(article.x),
  y: normalizeArticleCoordinate(article.y),
  publisher: article.publisher || article.source
    ? {
        name: article.publisher || article.source || 'Unknown',
        domain: '',
      }
    : null,
  topics: Array.isArray(article.topics)
    ? article.topics.filter(Boolean)
    : Array.isArray(article.meta?.topics)
      ? article.meta.topics.filter(Boolean)
      : [],
  source: article.source || article.publisher || 'Unknown',
  category: article.category || 'world',
  meta: buildSafePreviewMeta(article),
  reasons: buildSafePreviewReasons(article),
});

const normalizeRadius = (value?: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_QUERY_RADIUS;
  }

  return Math.min(1, Math.max(0.05, value));
};

const getPromptTermsFromRequest = (
  request: RecommendationRequestState | null,
  activeQuery?: ActiveQueryState | null,
) => {
  if (Array.isArray(activeQuery?.promptTerms) && activeQuery.promptTerms.length > 0) {
    return activeQuery.promptTerms.filter(
      (term): term is string => typeof term === 'string' && term.trim().length > 0,
    );
  }

  if (typeof request?.prompt === 'string' && request.prompt.trim().length > 0) {
    return request.prompt
      .split(';')
      .map((term) => term.trim())
      .filter(Boolean);
  }

  return [];
};

const deriveGraphFilterFromRequest = (
  request: RecommendationRequestState | null,
): TopNewsGraphFilterState | null => {
  if (!request) return null;

  return {
    position: {
      x: Math.round((request.position?.x ?? 0) * 100),
      y: Math.round((request.position?.y ?? 0) * 100),
    },
    radius: Math.round(normalizeRadius(request.radius) * 100),
  };
};

const getDistanceFromPreferenceCenter = (
  article: Article,
  request: RecommendationRequestState | null,
) => {
  if (!request) return 0;

  const targetX = Number(request.position?.x ?? 0);
  const targetY = Number(request.position?.y ?? 0);
  const articleX = Number(article.x ?? 0);
  const articleY = Number(article.y ?? 0);

  return Math.hypot(articleX - targetX, articleY - targetY);
};

const rankArticlesForGraphRange = (
  articles: Article[],
  request: RecommendationRequestState | null,
) => {
  if (!request || articles.length <= 1) {
    return articles;
  }

  const radius = normalizeRadius(request.radius);
  const radiusBuffer = Math.max(radius * 0.6, 0.08);

  return [...articles]
    .map((article) => {
      const distance = getDistanceFromPreferenceCenter(article, request);
      const withinRadius = distance <= radius + radiusBuffer;
      return {
        article,
        distance,
        withinRadius,
      };
    })
    .sort((left, right) => {
      if (left.withinRadius !== right.withinRadius) {
        return left.withinRadius ? -1 : 1;
      }

      return left.distance - right.distance;
    })
    .map(({ article }) => article);
};

const normalizeSearchTerm = (value: string) => value.trim().toLowerCase();

const scoreArticleTerms = (article: Article, terms: string[]) => {
  const normalizedTerms = terms.map(normalizeSearchTerm).filter(Boolean);
  if (normalizedTerms.length === 0) return 0;

  const title = article.title.toLowerCase();
  const lede = (article.lede || '').toLowerCase();
  const publisher = (article.publisher?.name || article.source || '').toLowerCase();
  const category = (article.category || '').toLowerCase();
  const topics = article.topics.map((topic) => topic.toLowerCase());

  return normalizedTerms.reduce((score, term) => {
    if (title.includes(term)) score += 8;
    if (topics.some((topic) => topic.includes(term) || term.includes(topic))) score += 6;
    if (category.includes(term) || term.includes(category)) score += 4;
    if (publisher.includes(term)) score += 3;
    if (lede.includes(term)) score += 2;
    return score;
  }, 0);
};

const rankArticlesForTerms = (articles: Article[], terms: string[]) =>
  [...articles]
    .map((article, index) => ({
      article,
      index,
      score: scoreArticleTerms(article, terms),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ article }) => article);

const getTermMatchedArticles = (articles: Article[], terms: string[]) =>
  rankArticlesForTerms(articles, terms)
    .filter((article) => scoreArticleTerms(article, terms) > 0);

export const fetchTopNewsArticles = async (
  graphFilter: TopNewsGraphFilterState | null,
): Promise<Article[]> => {
  const { apiBaseUrl, isEnabled } = getRecommenderConfig();
  if (!isEnabled || !apiBaseUrl) {
    return getMockTopNewsArticles(graphFilter)
      .map(mapFallbackArticle)
      .filter((article: Article) => Boolean(article.url));
  }

  const params = new URLSearchParams();

  if (graphFilter) {
    params.set('center_x', (graphFilter.position.x / 100).toString());
    params.set('center_y', (graphFilter.position.y / 100).toString());
    params.set('radius', (graphFilter.radius / 100).toString());
  }

  const cacheKey = params.toString() || 'unfiltered';
  const cached = liveArticleRequestCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.articles;
  }

  const response = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/v1/fallback-articles${params.toString() ? `?${params.toString()}` : ''}`,
    {
      headers: Object.keys(getRecommenderHeaders()).length > 0
        ? getRecommenderHeaders()
        : undefined,
    },
  );

  if (!response.ok) {
    throw new Error(`Fallback articles request failed with ${response.status}`);
  }

  const json = await response.json();
  const articles = Array.isArray(json?.articles)
    ? json.articles.map(mapFallbackArticle).filter((article: Article) => Boolean(article.url))
    : [];
  liveArticleRequestCache.set(cacheKey, {
    articles,
    expiresAt: Date.now() + LIVE_ARTICLE_CACHE_TTL_MS,
  });
  return articles;
};

const fetchTopNewsArticlesWithRetry = async (
  graphFilter: TopNewsGraphFilterState | null,
): Promise<Article[]> => {
  const filteredArticles = await fetchTopNewsArticles(graphFilter);

  if (filteredArticles.length > 0 || !graphFilter) {
    return filteredArticles;
  }

  console.warn(
    '[useFeedArticles] Graph-filtered Top News returned no articles, retrying unfiltered feed',
  );
  return fetchTopNewsArticles(null);
};

const fetchTopicArticles = async (
  topics: string[],
  excludeArticleIds: number[] = [],
  promptTerms: string[] = [],
) => {
  const { isEnabled, isAiRecommendationsEnabled } = getRecommenderConfig();
  if (!isEnabled) {
    return getMockTopicArticles(topics, excludeArticleIds, null, undefined, promptTerms)
      .map(mapFallbackArticle)
      .filter((article: Article) => Boolean(article.url));
  }

  if (!isAiRecommendationsEnabled) {
    const excluded = new Set(excludeArticleIds);
    const liveArticles = await fetchTopNewsArticles(null);
    return rankArticlesForTerms(liveArticles, [...topics, ...promptTerms])
      .filter((article) => !excluded.has(article.id))
      .slice(0, 20);
  }

  const { data, error } = await supabase.functions.invoke('get-articles', {
    body: {
      topics,
      limit: 20,
      ...(excludeArticleIds.length > 0 ? { exclude_ids: excludeArticleIds } : {}),
    },
  });

  if (error) {
    throw error;
  }

  return Array.isArray(data?.articles) ? (data.articles as Article[]) : [];
};

const streamRecommendedArticles = async (
  request: RecommendationRequestState,
  excludeArticleIds: number[] = [],
  recencyHours: number = RECENCY_HOURS_PROGRESSION[0],
  onArticle?: (article: Article) => void,
  signal?: AbortSignal,
): Promise<Article[]> => {
  const { apiBaseUrl, isEnabled, isAiRecommendationsEnabled } = getRecommenderConfig();
  if (!isEnabled || !apiBaseUrl) {
    const previewArticles = getMockTopicArticles(
      Array.isArray(request.topics) ? request.topics : [],
      excludeArticleIds,
      {
        position: {
          x: Math.round(Number(request.position?.x ?? 0) * 100),
          y: Math.round(Number(request.position?.y ?? 0) * 100),
        },
        radius: Math.round(normalizeRadius(request.radius) * 100),
      },
      undefined,
      getPromptTermsFromRequest(request),
    )
      .map(mapFallbackArticle)
      .filter((article: Article) => Boolean(article.url));

    previewArticles.forEach((article) => onArticle?.(article));
    return previewArticles;
  }

  if (!isAiRecommendationsEnabled) {
    const excluded = new Set(excludeArticleIds);
    const graphRanked = rankArticlesForGraphRange(
      await fetchTopNewsArticles(deriveGraphFilterFromRequest(request)),
      request,
    );
    const liveArticles = rankArticlesForTerms(
      graphRanked,
      [...(request.topics || []), ...getPromptTermsFromRequest(request)],
    )
      .filter((article) => !excluded.has(article.id))
      .slice(0, 20);

    liveArticles.forEach((article) => onArticle?.(article));
    return liveArticles;
  }

  const response = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/v1/recommendations/stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getRecommenderHeaders(),
      },
      body: JSON.stringify({
        prompt: request.prompt || '',
        topics: Array.isArray(request.topics) ? request.topics : [],
        center_x: Number(request.position?.x ?? 0),
        center_y: Number(request.position?.y ?? 0),
        radius: normalizeRadius(request.radius),
        recency_hours: recencyHours,
        exclude_article_ids: excludeArticleIds,
      }),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(`Recommendations request failed with ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('text/event-stream')) {
    const json = await response.json();
    return Array.isArray(json?.articles)
      ? json.articles.map(mapFallbackArticle).filter((article: Article) => Boolean(article.url))
      : [];
  }

  if (!response.body) {
    throw new Error('Recommendations stream response body missing');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const streamedArticles: Article[] = [];
  const seenIds = new Set<number>();
  let buffer = '';
  let doneStreaming = false;
  let eventDataLines: string[] = [];

  const pushStreamArticle = (payload: any) => {
    if (payload?.type !== 'article' || !payload?.article) return;
    const mapped = mapFallbackArticle(payload.article);
    if (!mapped.url || seenIds.has(mapped.id)) return;
    seenIds.add(mapped.id);
    streamedArticles.push(mapped);
    onArticle?.(mapped);
  };

  while (!doneStreaming) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');

      if (line === '') {
        if (eventDataLines.length === 0) continue;
        const dataPayload = eventDataLines.join('\n').trim();
        eventDataLines = [];
        if (!dataPayload) continue;

        const parsed = JSON.parse(dataPayload);
        pushStreamArticle(parsed);
        if (parsed?.type === 'done') {
          doneStreaming = true;
          break;
        }
        continue;
      }

      if (line.startsWith('data:')) {
        const dataLine = line.replace(/^data:\s*/, '').trim();
        if (!dataLine) continue;
        eventDataLines.push(dataLine);

        if (dataLine.startsWith('{') && dataLine.endsWith('}')) {
          const dataPayload = eventDataLines.join('\n').trim();
          eventDataLines = [];
          const parsed = JSON.parse(dataPayload);
          pushStreamArticle(parsed);
          if (parsed?.type === 'done') {
            doneStreaming = true;
            break;
          }
        }
      }
    }
  }

  return streamedArticles;
};

// Port of the web Search page (card-page Search.tsx). The top-right search
// hits GET /v1/search: a title match over the whole article corpus, newest
// first. When the full phrase misses, the same shorter word combinations the
// web tries are sent next. Rows from that endpoint carry no graph
// coordinates or meta, so those are borrowed from the cached article pool
// when the same story is in it. The cached-pool term match stays as the
// fallback for no results, a failed request, or a disabled recommender.
const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'for', 'from', 'how', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
]);

export const buildSearchCandidates = (rawQuery: string): string[] => {
  const normalized = rawQuery.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const candidates = [normalized];
  const words = normalized.split(' ');
  const meaningfulWords = words.filter((word) => !SEARCH_STOP_WORDS.has(word.toLowerCase()));

  if (meaningfulWords.length >= 2) {
    candidates.push(meaningfulWords.slice(0, 3).join(' '));
    candidates.push(meaningfulWords.slice(0, 2).join(' '));
  }

  if (words.length >= 2) {
    candidates.push(words.slice(0, 3).join(' '));
    candidates.push(words.slice(0, 2).join(' '));
  }

  return [...new Set(candidates.filter(Boolean))];
};

interface TitleSearchRow {
  id?: number | string;
  title?: string;
  lede?: string | null;
  url?: string;
  image_url?: string | null;
  publisher?: string | null;
  ts_pub?: string;
  x?: number | null;
  y?: number | null;
  x_explanation?: string | null;
  y_explanation?: string | null;
}

// Returns null when the recommender API is not configured.
const fetchTitleSearchResults = async (query: string, limit: number): Promise<Article[] | null> => {
  const { apiBaseUrl, isEnabled } = getRecommenderConfig();
  if (!isEnabled || !apiBaseUrl) return null;

  const params = new URLSearchParams({ query, limit: String(limit) });
  const response = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/v1/search?${params.toString()}`,
    { headers: getRecommenderHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Title search returned ${response.status}`);
  }

  const json = await response.json();
  if (!Array.isArray(json)) return [];

  return (json as TitleSearchRow[])
    .map((row) => mapFallbackArticle({
      id: row.id,
      title: row.title,
      lede: row.lede ?? undefined,
      url: row.url,
      image_url: row.image_url ?? undefined,
      publisher: row.publisher ?? undefined,
      ts_pub: row.ts_pub,
      x: typeof row.x === 'number' ? row.x : undefined,
      y: typeof row.y === 'number' ? row.y : undefined,
      meta: {
        x_explanation: row.x_explanation ?? undefined,
        y_explanation: row.y_explanation ?? undefined,
        // Unscored rows would read as Center / Mixed at (0, 0); the search
        // screen shows no lean chip for them instead (Ayuka, 2026-09-27).
        unscored: typeof row.x !== 'number' || typeof row.y !== 'number',
      },
    }))
    .filter((article) => Boolean(article.url));
};

export const searchLiveArticles = async (query: string, limit = 12): Promise<Article[]> => {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery) return [];

  const searchCachedPool = async () => {
    const articles = await fetchTopNewsArticles(null);
    return getTermMatchedArticles(articles, [normalizedQuery]).slice(0, limit);
  };

  let matched: Article[] = [];
  try {
    for (const candidate of buildSearchCandidates(query)) {
      const results = await fetchTitleSearchResults(candidate, Math.max(limit, 20));
      if (results === null) return searchCachedPool();
      if (results.length > 0) {
        matched = results;
        break;
      }
    }
  } catch (error) {
    console.warn('[useFeedArticles] Title search unavailable; using cached pool', error);
    return searchCachedPool();
  }

  if (matched.length === 0) return searchCachedPool();

  try {
    const pool = await fetchTopNewsArticles(null);
    const poolById = new Map(pool.map((article) => [article.id, article]));
    matched = matched.map((article) => {
      const enriched = poolById.get(article.id);
      return enriched
        ? {
            ...article,
            x: enriched.x,
            y: enriched.y,
            topics: enriched.topics,
            category: enriched.category,
            meta: enriched.meta,
            reasons: enriched.reasons,
            publisher: article.publisher ?? enriched.publisher,
          }
        : article;
    });
  } catch (error) {
    console.warn('[useFeedArticles] Could not enrich title search results', error);
  }

  return matched.slice(0, limit);
};

// Graph free-text search deliberately uses the same cached article pool as
// the top-right search. It is only called after an explicit submit, never as
// the user types, and it never falls through to the AI recommendation stream.
export const searchGraphArticles = async (
  query: string,
  graphFilter: TopNewsGraphFilterState | null,
  limit = 20,
): Promise<Article[]> => {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery) return [];

  const { apiBaseUrl, isEnabled } = getRecommenderConfig();
  if (isEnabled && apiBaseUrl) {
    const params = new URLSearchParams({ q: query.trim(), limit: String(limit) });
    if (graphFilter) {
      params.set('center_x', (graphFilter.position.x / 100).toString());
      params.set('center_y', (graphFilter.position.y / 100).toString());
      params.set('radius', (graphFilter.radius / 100).toString());
    }

    try {
      const response = await fetch(
        `${apiBaseUrl.replace(/\/$/, '')}/v1/articles/search?${params.toString()}`,
        { headers: getRecommenderHeaders() },
      );
      if (response.ok) {
        const json = await response.json();
        return Array.isArray(json?.articles)
          ? json.articles.map(mapFallbackArticle).filter((article: Article) => Boolean(article.url))
          : [];
      }
      console.warn(`[useFeedArticles] Full-corpus Graph search returned ${response.status}; using cached fallback`);
    } catch (error) {
      // Keep the existing cached-pool search as a safe temporary fallback
      // until an app update reaches a backend deployment.
      console.warn('[useFeedArticles] Full-corpus Graph search unavailable; using cached fallback', error);
    }
  }

  const scopedArticles = await fetchTopNewsArticles(graphFilter);
  const scopedMatches = getTermMatchedArticles(scopedArticles, [normalizedQuery]);
  if (scopedMatches.length > 0 || !graphFilter) {
    return scopedMatches.slice(0, limit);
  }

  // A narrow graph range should not make a valid text search look broken.
  // Expand once to the cached unfiltered pool, rather than returning generic
  // Top News. This is at most one additional request and is normally cached.
  const broaderArticles = await fetchTopNewsArticles(null);
  return getTermMatchedArticles(broaderArticles, [normalizedQuery]).slice(0, limit);
};

export const fetchLiveArticleById = async (articleId: number): Promise<Article | null> => {
  const { apiBaseUrl, isEnabled } = getRecommenderConfig();
  if (!isEnabled || !apiBaseUrl) return null;

  const response = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/v1/articles/${articleId}`,
    { headers: getRecommenderHeaders() },
  );
  if (!response.ok) return null;

  const json = await response.json();
  return json?.article ? mapFallbackArticle(json.article) : null;
};

export function useFeedArticles() {
  const initialCache = getFeedCache();
  const initialSavedRecommendationRequest =
    initialCache.feedMode === 'query' ? readRecommendationRequest() : null;
  const [articles, setArticlesState] = useState<Article[]>(() => initialCache.articles);
  const [currentArticleIndex, setCurrentArticleIndexState] = useState(() => initialCache.currentIndex);
  const [feedMode, setFeedModeState] = useState<FeedMode>(() => initialCache.feedMode);
  const [feedPreferenceSignature, setFeedPreferenceSignature] = useState<string | null>(
    () => initialCache.preferenceSignature,
  );
  const [isLoading, setIsLoading] = useState(() => initialCache.articles.length === 0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAllCaughtUp, setIsAllCaughtUp] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const articlesRef = useRef<Article[]>(initialCache.articles);
  const currentRequestRef = useRef<RecommendationRequestState | null>(initialSavedRecommendationRequest);
  const currentModeRef = useRef<FeedMode>(initialCache.feedMode);
  const loadRequestIdRef = useRef(0);
  const operationIdRef = useRef(0);
  const streamControllerRef = useRef<AbortController | null>(null);
  const currentRecencyIndexRef = useRef(0);
  const seenArticleIdsRef = useRef<Set<number>>(new Set(initialCache.articles.map((article) => article.id)));
  const isRequestingMoreRef = useRef(false);

  useEffect(() => {
    articlesRef.current = articles;
  }, [articles]);

  useEffect(() => {
    const persistedCache = readPersistedFeedCache();
    const hasPersistedState =
      persistedCache.articles.length > 0 ||
      persistedCache.currentIndex !== 0 ||
      persistedCache.feedMode !== EMPTY_FEED_CACHE.feedMode ||
      persistedCache.preferenceSignature !== EMPTY_FEED_CACHE.preferenceSignature;

    if (!hasPersistedState) {
      return;
    }

    setArticlesState(persistedCache.articles);
    setCurrentArticleIndexState(persistedCache.currentIndex);
    setFeedModeState(persistedCache.feedMode);
    setFeedPreferenceSignature(persistedCache.preferenceSignature);
    setIsLoading(persistedCache.articles.length === 0);
    setIsAllCaughtUp(false);
    articlesRef.current = persistedCache.articles;
    currentModeRef.current = persistedCache.feedMode;
    currentRequestRef.current =
      persistedCache.feedMode === 'query' ? readRecommendationRequest() : null;
    seenArticleIdsRef.current = new Set(
      persistedCache.articles.map((article) => article.id),
    );

    (
      globalThis as typeof globalThis & {
        [FEED_CACHE_KEY]?: FeedCacheState;
      }
    )[FEED_CACHE_KEY] = persistedCache;
  }, []);

  const updateCache = useCallback((next: Partial<FeedCacheState>) => {
    const cache = getFeedCache();
    const merged = {
      ...cache,
      ...next,
    };
    (globalThis as typeof globalThis & { [FEED_CACHE_KEY]?: FeedCacheState })[FEED_CACHE_KEY] = merged;
    persistFeedCache(merged);
  }, []);

  const setArticles = useCallback((
    nextArticles: Article[],
    nextMode?: FeedMode,
    nextPreferenceSignature?: string | null,
  ) => {
    setArticlesState(nextArticles);
    setCurrentArticleIndexState(0);
    if (nextMode) {
      setFeedModeState(nextMode);
      currentModeRef.current = nextMode;
    }
    if (typeof nextPreferenceSignature !== 'undefined') {
      setFeedPreferenceSignature(nextPreferenceSignature);
    }
    setIsAllCaughtUp(false);
    const analyticsFeedMode = normalizeFeedMode(nextMode ?? currentModeRef.current);
    if (analyticsFeedMode && nextArticles.length > 0) {
      void trackFeedLoad({
        feedMode: analyticsFeedMode,
        articleCount: nextArticles.length,
        sourceCount: new Set(
          nextArticles
            .map((article) => article.publisher?.name ?? article.source)
            .filter(Boolean),
        ).size,
      });
    }
    updateCache({
      articles: nextArticles,
      currentIndex: 0,
      feedMode: nextMode ?? currentModeRef.current,
      preferenceSignature:
        typeof nextPreferenceSignature !== 'undefined'
          ? nextPreferenceSignature
          : feedPreferenceSignature,
    });
  }, [feedPreferenceSignature, updateCache]);

  const replaceArticles = useCallback((
    nextArticles: Article[],
    nextMode?: FeedMode,
    nextPreferenceSignature?: string | null,
  ) => {
    seenArticleIdsRef.current = new Set(nextArticles.map((article) => article.id));
    currentRecencyIndexRef.current = 0;
    setArticles(nextArticles, nextMode, nextPreferenceSignature);
  }, [setArticles]);

  const appendStreamArticle = useCallback((article: Article) => {
    if (seenArticleIdsRef.current.has(article.id)) {
      return false;
    }

    seenArticleIdsRef.current.add(article.id);
    setArticlesState((previousArticles) => {
      const merged = [...previousArticles, article];
      updateCache({ articles: merged });
      return merged;
    });
    setIsAllCaughtUp(false);
    return true;
  }, [updateCache]);

  const setCurrentArticleIndex = useCallback((nextIndex: number) => {
    setCurrentArticleIndexState(nextIndex);
    updateCache({ currentIndex: nextIndex });
  }, [updateCache]);

  const setFeedContext = useCallback((
    nextMode: FeedMode,
    nextPreferenceSignature: string | null,
  ) => {
    setFeedModeState(nextMode);
    setFeedPreferenceSignature(nextPreferenceSignature);
    currentModeRef.current = nextMode;
    updateCache({
      feedMode: nextMode,
      preferenceSignature: nextPreferenceSignature,
    });
  }, [updateCache]);

  const beginOperation = useCallback(() => {
    operationIdRef.current += 1;
    return operationIdRef.current;
  }, []);

  const isOperationCurrent = useCallback(
    (operationId: number) => operationIdRef.current === operationId,
    [],
  );

  const abortStreaming = useCallback(() => {
    streamControllerRef.current?.abort();
    streamControllerRef.current = null;
    setIsStreaming(false);
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;

      // iOS can suspend an open stream without resolving it. Abort it while
      // backgrounded so returning to the app never leaves the feed locked in
      // an invisible loading state.
      streamControllerRef.current?.abort();
      streamControllerRef.current = null;
      isRequestingMoreRef.current = false;
      setIsStreaming(false);
      setIsLoading(false);
    });

    return () => subscription.remove();
  }, []);

  const startStreamingRecommendations = useCallback(async (
    request: RecommendationRequestState,
    options?: {
      append?: boolean;
      excludeArticleIds?: number[];
      recencyHours?: number;
    },
  ) => {
    const append = Boolean(options?.append);
    const excludeArticleIds = options?.excludeArticleIds || [];
    const recencyHours =
      options?.recencyHours ||
      RECENCY_HOURS_PROGRESSION[currentRecencyIndexRef.current] ||
      RECENCY_HOURS_PROGRESSION[0];
    const operationId = append ? operationIdRef.current : beginOperation();
    const controller = new AbortController();

    streamControllerRef.current?.abort();
    streamControllerRef.current = controller;

    currentRequestRef.current = request;
    currentModeRef.current = 'query';
    if (isOperationCurrent(operationId)) {
      setStreamError(null);
    }

    if (!append) {
      currentRecencyIndexRef.current = 0;
      seenArticleIdsRef.current = new Set();
      if (isOperationCurrent(operationId)) {
        replaceArticles([], 'query');
        setIsAllCaughtUp(false);
        setIsLoading(true);
      }
    }

    if (isOperationCurrent(operationId)) {
      setIsStreaming(true);
    }

    try {
      let startedStreamingIntoUi = false;
      const recommended = await streamRecommendedArticles(
        request,
        excludeArticleIds,
        recencyHours,
        (article) => {
          if (!isOperationCurrent(operationId)) {
            return;
          }

          if (append) {
            appendStreamArticle(article);
            return;
          }

          if (!startedStreamingIntoUi) {
            startedStreamingIntoUi = true;
            setIsLoading(false);
            replaceArticles([article], 'query');
            return;
          }

          appendStreamArticle(article);
        },
        controller.signal,
      );

      if (
        !append &&
        recommended.length > 0 &&
        !startedStreamingIntoUi &&
        isOperationCurrent(operationId)
      ) {
        replaceArticles(recommended, 'query');
      }

      return recommended;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return [];
      }

      const message =
        error instanceof Error ? error.message : 'Unknown streaming error';
      console.warn('[useFeedArticles] Recommendation stream failed', error);
      if (isOperationCurrent(operationId)) {
        setStreamError(message);
      }

      return [];
    } finally {
      if (streamControllerRef.current === controller) {
        streamControllerRef.current = null;
      }

      if (isOperationCurrent(operationId)) {
        setIsLoading(false);
        setIsStreaming(false);
      }
    }
  }, [appendStreamArticle, beginOperation, isOperationCurrent, replaceArticles]);

  const hydrateQueryArticles = useCallback(async (
    _activeQuery: ActiveQueryState | null,
    recommendationRequest: RecommendationRequestState | null,
    prefetchedQueryArticles: Article[] | null | undefined,
    _profileTopics: string[],
  ) => {
    if (
      recommendationRequest?.searchStrategy === 'deterministic' &&
      Array.isArray(prefetchedQueryArticles)
    ) {
      currentRequestRef.current = recommendationRequest;
      currentModeRef.current = 'query';
      currentRecencyIndexRef.current = 0;
      seenArticleIdsRef.current = new Set(prefetchedQueryArticles.map((article) => article.id));
      replaceArticles(prefetchedQueryArticles, 'query');
      return prefetchedQueryArticles;
    }

    if (Array.isArray(prefetchedQueryArticles) && prefetchedQueryArticles.length > 0) {
      currentRequestRef.current = recommendationRequest;
      currentModeRef.current = 'query';
      currentRecencyIndexRef.current = 0;
      seenArticleIdsRef.current = new Set(prefetchedQueryArticles.map((article) => article.id));
      replaceArticles(prefetchedQueryArticles, 'query');
      return prefetchedQueryArticles;
    }

    if (!recommendationRequest) {
      replaceArticles([], 'query');
      return [];
    }

    if (recommendationRequest.searchStrategy === 'deterministic') {
      const directResults = await searchGraphArticles(
        recommendationRequest.prompt,
        deriveGraphFilterFromRequest(recommendationRequest),
      );
      replaceArticles(directResults, 'query');
      return directResults;
    }

    return startStreamingRecommendations(recommendationRequest);
  }, [replaceArticles, startStreamingRecommendations]);

  const loadTopNews = useCallback(async (graphFilter: TopNewsGraphFilterState | null) => {
    const operationId = beginOperation();
    abortStreaming();
    currentRequestRef.current = null;
    currentModeRef.current = 'top-news';
    currentRecencyIndexRef.current = 0;
    seenArticleIdsRef.current = new Set();
    try {
      const topNewsArticles = await fetchTopNewsArticlesWithRetry(graphFilter);
      if (isOperationCurrent(operationId)) {
        replaceArticles(topNewsArticles, 'top-news');
      }
      return topNewsArticles;
    } catch (error) {
      console.warn('[useFeedArticles] Top News load failed', error);
      if (isOperationCurrent(operationId)) {
        replaceArticles([], 'top-news');
      }
      return [];
    }
  }, [abortStreaming, beginOperation, isOperationCurrent, replaceArticles]);

  const loadPersonalizedFeed = useCallback(async (profileTopics: string[]) => {
    const operationId = beginOperation();
    abortStreaming();
    currentRequestRef.current = null;
    currentModeRef.current = 'personalized';
    currentRecencyIndexRef.current = 0;
    seenArticleIdsRef.current = new Set();
    const topics = profileTopics.length > 0 ? profileTopics : ['Technology'];
    try {
      const { isEnabled } = getRecommenderConfig();
      const personalizedArticles = isEnabled
        ? await fetchTopicArticles(topics)
        : getMockPersonalizedArticles(topics)
            .map(mapFallbackArticle)
            .filter((article: Article) => Boolean(article.url));
      if (isOperationCurrent(operationId)) {
        replaceArticles(personalizedArticles, 'personalized');
      }
      return personalizedArticles;
    } catch (error) {
      console.warn('[useFeedArticles] Personalized feed load failed', error);
      if (isOperationCurrent(operationId)) {
        replaceArticles([], 'personalized');
      }
      return [];
    }
  }, [abortStreaming, beginOperation, isOperationCurrent, replaceArticles]);

  const loadFallbackArticles = useCallback(async (
    nextMode: FeedMode,
    graphFilter: TopNewsGraphFilterState | null = null,
    operationId: number = operationIdRef.current,
  ) => {
    try {
      const fallbackArticles = await fetchTopNewsArticlesWithRetry(graphFilter);
      if (fallbackArticles.length > 0) {
        if (isOperationCurrent(operationId)) {
          replaceArticles(fallbackArticles, nextMode);
        }
        return fallbackArticles;
      }

      // Match the webapp's resilience more closely: if a custom query/range
      // still yields no fallback stories, recover with plain fallback articles
      // but preserve the user's current feed mode instead of silently flipping
      // the mode label/state to Top News.
      if (nextMode !== 'top-news') {
        const topNewsArticles = await fetchTopNewsArticlesWithRetry(null);
        if (topNewsArticles.length > 0) {
          if (isOperationCurrent(operationId)) {
            replaceArticles(topNewsArticles, nextMode);
          }
          return topNewsArticles;
        }
      }

      if (isOperationCurrent(operationId)) {
        replaceArticles([], nextMode);
      }
      return [];
    } catch (error) {
      console.warn('[useFeedArticles] Fallback article load failed', error);
      if (nextMode !== 'top-news') {
        try {
          const topNewsArticles = await fetchTopNewsArticlesWithRetry(null);
          if (topNewsArticles.length > 0) {
            if (isOperationCurrent(operationId)) {
              replaceArticles(topNewsArticles, nextMode);
            }
            return topNewsArticles;
          }
        } catch (topNewsError) {
          console.warn('[useFeedArticles] Top News recovery after fallback failure also failed', topNewsError);
        }
      }

      if (isOperationCurrent(operationId)) {
        replaceArticles([], nextMode);
      }
      return [];
    }
  }, [isOperationCurrent, replaceArticles]);

  const loadQueryFallbackArticles = useCallback(async (
    activeQuery: ActiveQueryState | null,
    recommendationRequest: RecommendationRequestState | null,
    operationId: number = operationIdRef.current,
  ) => {
    const explicitTopics = Array.isArray(activeQuery?.topics)
      ? activeQuery.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0)
      : [];
    const promptTerms = getPromptTermsFromRequest(recommendationRequest, activeQuery);
    const searchTerms = [...explicitTopics, ...promptTerms];
    const graphFilter = deriveGraphFilterFromRequest(recommendationRequest);

    // This is the recovery path for a failed recommendation request. It must
    // preserve a typed Graph search (for example, "Russia") instead of
    // silently replacing it with the default news feed. Use the same live
    // text matching as the top-right search, then keep graph proximity as a
    // secondary ranking signal.
    if (searchTerms.length > 0) {
      try {
        const graphArticles = await fetchTopNewsArticlesWithRetry(graphFilter);
        const matchedArticles = getTermMatchedArticles(graphArticles, searchTerms);
        if (matchedArticles.length > 0) {
          const rankedMatches = rankArticlesForGraphRange(
            matchedArticles,
            recommendationRequest,
          );
          if (isOperationCurrent(operationId)) {
            replaceArticles(rankedMatches, 'query');
          }
          return rankedMatches;
        }
      } catch (error) {
        console.warn('[useFeedArticles] Text-aware query fallback failed', error);
      }
    }

    if (explicitTopics.length > 0) {
      try {
          const topicArticles = await fetchTopicArticles(
            explicitTopics,
            [],
            promptTerms,
          );
        if (topicArticles.length > 0) {
          const rankedTopicArticles = rankArticlesForGraphRange(
            topicArticles,
            recommendationRequest,
          );

          if (isOperationCurrent(operationId)) {
            replaceArticles(rankedTopicArticles, 'query');
          }

          return rankedTopicArticles;
        }
      } catch (error) {
        console.warn('[useFeedArticles] Topic-aware query fallback failed', error);
      }
    }

    // A typed query with no matches should remain an empty query result. It
    // is clearer than showing unrelated default news under the user's search.
    if (searchTerms.length > 0) {
      if (isOperationCurrent(operationId)) {
        replaceArticles([], 'query');
      }
      return [];
    }

    return loadFallbackArticles('query', graphFilter, operationId);
  }, [isOperationCurrent, loadFallbackArticles, replaceArticles]);

  const loadFromPreferences = useCallback(async ({
    activeQuery,
    recommendationRequest,
    prefetchedQueryArticles,
    isTopNewsActive,
    topNewsGraphFilter,
    profileTopics,
  }: LoadPreferencesParams) => {
    const { isEnabled } = getRecommenderConfig();
    const requestId = ++loadRequestIdRef.current;
    const cachedArticles = articlesRef.current;
    const preferenceSignature = buildFeedPreferenceSignature({
      activeQuery,
      recommendationRequest,
      topNewsGraphFilter,
      isTopNewsActive,
      profileTopics,
    });

    if (!isEnabled) {
      if (
        Array.isArray(prefetchedQueryArticles) &&
        prefetchedQueryArticles.length > 0 &&
        recommendationRequest
      ) {
        replaceArticles(prefetchedQueryArticles, 'query', preferenceSignature);
        setIsLoading(false);
        setIsStreaming(false);
        return prefetchedQueryArticles;
      }

      if (!isTopNewsActive && recommendationRequest) {
        const safeModeQueryArticles = getMockTopicArticles(
          recommendationRequest.topics ?? activeQuery?.topics ?? [],
          [],
          deriveGraphFilterFromRequest(recommendationRequest),
          undefined,
          getPromptTermsFromRequest(recommendationRequest, activeQuery),
        )
          .map(mapFallbackArticle)
          .filter((article: Article) => Boolean(article.url));

        replaceArticles(safeModeQueryArticles, 'query', preferenceSignature);
        setIsLoading(false);
        setIsStreaming(false);
        return safeModeQueryArticles;
      }

      if (isTopNewsActive) {
        const safeModeTopNewsArticles = getMockTopNewsArticles(topNewsGraphFilter)
          .map(mapFallbackArticle)
          .filter((article: Article) => Boolean(article.url));

        replaceArticles(safeModeTopNewsArticles, 'top-news', preferenceSignature);
        setIsLoading(false);
        setIsStreaming(false);
        return safeModeTopNewsArticles;
      }

      const safeModePersonalizedArticles = getMockPersonalizedArticles(profileTopics)
        .map(mapFallbackArticle)
        .filter((article: Article) => Boolean(article.url));

      if (safeModePersonalizedArticles.length > 0) {
        replaceArticles(safeModePersonalizedArticles, 'personalized', preferenceSignature);
        setIsLoading(false);
        setIsStreaming(false);
        return safeModePersonalizedArticles;
      }

      setIsLoading(false);
      setIsStreaming(false);
      return cachedArticles;
    }

    setIsLoading(articlesRef.current.length === 0);
    setIsStreaming(true);
    setIsAllCaughtUp(false);
    setFeedPreferenceSignature(preferenceSignature);

    const commitIfCurrent = <T,>(value: T) => {
      if (loadRequestIdRef.current !== requestId) return null;
      return value;
    };
    const hasRunnableQuery = Boolean(recommendationRequest);

    try {
      if (!isTopNewsActive && hasRunnableQuery) {
        const queryArticles = await hydrateQueryArticles(
          activeQuery,
          recommendationRequest,
          prefetchedQueryArticles,
          profileTopics,
        );

        if (queryArticles.length === 0) {
          return commitIfCurrent(
            await loadQueryFallbackArticles(
              activeQuery,
              recommendationRequest,
              operationIdRef.current,
            ),
          ) ?? [];
        }

        return commitIfCurrent(queryArticles) ?? [];
      }

      if (isTopNewsActive) {
        const topNewsArticles = await loadTopNews(topNewsGraphFilter);
        return commitIfCurrent(topNewsArticles) ?? [];
      }

      const personalizedArticles = await loadPersonalizedFeed(profileTopics);
      if (personalizedArticles.length === 0) {
        return commitIfCurrent(
          await loadFallbackArticles(
            'personalized',
            topNewsGraphFilter,
            operationIdRef.current,
          ),
        ) ?? [];
      }
      return commitIfCurrent(personalizedArticles) ?? [];
    } catch (error) {
      console.warn('[useFeedArticles] loadFromPreferences failed, returning empty feed', error);
      if (loadRequestIdRef.current === requestId) {
        const fallbackMode = isTopNewsActive ? 'top-news' : hasRunnableQuery ? 'query' : 'personalized';
        return commitIfCurrent(
          fallbackMode === 'query'
            ? await loadQueryFallbackArticles(
                activeQuery,
                recommendationRequest,
                operationIdRef.current,
              )
            : await loadFallbackArticles(
                fallbackMode,
                topNewsGraphFilter,
                operationIdRef.current,
              ),
        ) ?? [];
      }
      return [];
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false);
        setIsStreaming(false);
      }
    }
  }, [hydrateQueryArticles, loadFallbackArticles, loadPersonalizedFeed, loadQueryFallbackArticles, loadTopNews]);

  const requestMoreArticles = useCallback(async () => {
    const { isEnabled } = getRecommenderConfig();
    if (!isEnabled) {
      if (currentModeRef.current !== 'query' || !currentRequestRef.current) {
        setIsAllCaughtUp(true);
        return [];
      }

      const nextMockArticles = getMockTopicArticles(
        currentRequestRef.current.topics ?? [],
        Array.from(seenArticleIdsRef.current),
        deriveGraphFilterFromRequest(currentRequestRef.current),
        undefined,
        getPromptTermsFromRequest(currentRequestRef.current),
      )
        .map(mapFallbackArticle)
        .filter((article: Article) => Boolean(article.url));

      nextMockArticles.forEach((article) => {
        appendStreamArticle(article);
      });

      if (nextMockArticles.length === 0) {
        setIsAllCaughtUp(true);
      }

      return nextMockArticles;
    }

    if (
      isStreaming ||
      isAllCaughtUp ||
      isRequestingMoreRef.current
    ) {
      return [];
    }

    if (currentModeRef.current !== 'query' || !currentRequestRef.current) {
      return [];
    }

    isRequestingMoreRef.current = true;
    setIsStreaming(true);
    try {
      const currentRequest = currentRequestRef.current;
      const isSameQueryContext = () =>
        currentModeRef.current === 'query' &&
        currentRequestRef.current === currentRequest;
      const excludeIds = Array.from(seenArticleIdsRef.current);
      const seenIdsBeforeRequest = new Set(seenArticleIdsRef.current);
      const currentRecencyHours =
        RECENCY_HOURS_PROGRESSION[currentRecencyIndexRef.current] ||
        RECENCY_HOURS_PROGRESSION[0];

      let nextArticles = await startStreamingRecommendations(
        currentRequest,
        {
          append: true,
          excludeArticleIds: excludeIds,
          recencyHours: currentRecencyHours,
        },
      );

      if (!isSameQueryContext()) {
        return [];
      }

      if (nextArticles.length === 0) {
        const nextRecencyIndex = currentRecencyIndexRef.current + 1;
        if (nextRecencyIndex < RECENCY_HOURS_PROGRESSION.length) {
          currentRecencyIndexRef.current = nextRecencyIndex;
          nextArticles = await startStreamingRecommendations(
            currentRequest,
            {
              append: true,
              excludeArticleIds: excludeIds,
              recencyHours: RECENCY_HOURS_PROGRESSION[nextRecencyIndex],
            },
          );

          if (!isSameQueryContext()) {
            return [];
          }
        }
      }

      const appendedArticles = nextArticles.filter((article) =>
        {
          if (seenIdsBeforeRequest.has(article.id)) {
            return false;
          }

          seenIdsBeforeRequest.add(article.id);
          return true;
        },
      );

      if (!isSameQueryContext()) {
        return [];
      }

      if (appendedArticles.length === 0) {
        setIsAllCaughtUp(true);
        return [];
      }

      return appendedArticles;
    } catch (error) {
      console.warn('[useFeedArticles] Failed to load more articles', error);
      return [];
    } finally {
      isRequestingMoreRef.current = false;
      setIsStreaming(false);
    }
  }, [appendStreamArticle, isAllCaughtUp, isStreaming, startStreamingRecommendations]);

  return {
    articles,
    isLoading,
    isStreaming,
    isAllCaughtUp,
    hasCachedArticles: articles.length > 0,
    feedMode,
    feedPreferenceSignature,
    streamError,
    currentArticleIndex,
    setCurrentArticleIndex,
    setFeedContext,
    setArticles,
    loadTopNews,
    loadPersonalizedFeed,
    loadFromPreferences,
    requestMoreArticles,
    startStreamingRecommendations,
    abortStreaming,
    clearStreamError: () => setStreamError(null),
  };
}
