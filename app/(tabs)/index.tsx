import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import {
  View, Text, Image, StyleSheet, SafeAreaView, ActivityIndicator, Modal,
  TouchableOpacity, Alert, InteractionManager, useWindowDimensions, ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  FadeInDown,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Link, router } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/Colors';
import { useAuth } from '../context/AuthContext';
import { useNewsPreferences } from '../context/NewsPreferencesContext';
import {
  fetchLiveArticleById,
  useFeedArticles,
  type Article,
} from '../hooks/useFeedArticles';
import {
  buildFeedPreferenceSignature,
} from '../lib/newsPreferences';
import {
  buildCanonicalDailyDigestFeed,
  consumeDailyDigestExitRequest,
  markDailyDigestArticleComplete,
  readDailyDigestDismissal,
  readDailyDigestOpenRequest,
  readDailyDigestPanelHint,
  subscribeDailyDigestOpenRequest,
  type DailyDigestFeed,
  writeDailyDigestDismissal,
  writeDailyDigestOpenRequest,
  writeDailyDigestPanelHint,
} from '../lib/dailyDigest';
import {
  fromRemoteSavedArticleRow,
  hasRenderableSavedArticle,
  mergeSavedArticles,
  readSavedArticles,
  removeSavedArticle,
  subscribeSavedArticles,
  toRemoteSavedArticleRow,
  upsertSavedArticle,
  type RemoteSavedArticleRow,
} from '../lib/savedArticles';
import {
  claimDailyStreakUpdate,
  logArticleRead,
  readReadingActivitySummary,
  subscribeReadingActivity,
} from '../lib/readingActivity';
import { buildHref } from '../lib/buildHref';
import {
  buildArticleAnalyticsContext,
  normalizeFeedMode,
  trackArticleImpression,
  trackArticleOpen,
  trackArticleReadComplete,
} from '../lib/analytics';
import { consumeSharedStoryRequest, fetchSharedStoryArticle } from '../lib/sharedStory';
import { awardDigestStreak } from '../lib/digestStreak';
import { TAB_BAR_CLEARANCE } from '../components/GlassTabBar';
import { readCachedStreak, writeCachedStreak } from '../lib/streakCache';
import { useOnboarding } from '../hooks/useOnboarding';
import { SwipeTooltip } from '../components/onboarding/SwipeTooltip';
import { GraphBanner } from '../components/onboarding/GraphBanner';
import { openPublisherArticle } from '../lib/openPublisherArticle';
import { supabase } from '../services/supabase';
import { ArticleCard, getArticleCardDimensions } from '../components/news-feed/ArticleCard';
import { StoryShareSheet } from '../components/StoryShareSheet';
import { SaveAccountPrompt } from '../components/SaveAccountPrompt';
import { NotificationPermissionPrompt } from '../components/NotificationPermissionPrompt';
import {
  type NotificationAsk,
  recordDigestCompletionForPrompt,
  recordPromptDeclined,
  recordPromptGranted,
} from '../lib/notificationPrompt';
import { askPushPermission, syncStreakBadge } from '../utils/notifications';
import { useBadgeCelebration } from '../components/BadgeCelebration';

const ARTICLES_PER_PAGE = 20;
const STACK_RENDER_COUNT = 4;
const SWIPE_DIAGNOSTICS =
  __DEV__ && process.env.EXPO_PUBLIC_SWIPE_DIAGNOSTICS === 'true';
const FEED_COLORS = {
  ...Colors.light,
  background: '#F7F3EA',
  card: '#F7F3EA',
  surface: '#F5EFE1',
  text: '#22201C',
  textSecondary: '#4D4942',
  textMuted: '#7A766F',
  tint: '#8DAE73',
  tintForeground: '#FFFFFF',
  secondary: '#F0E9D8',
  border: '#E3DACA',
  icon: '#302D28',
  tabIconDefault: '#73706A',
};

const humanizeTopicLabel = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

function PraxisLoadingState() {
  return (
    <View
      style={s.praxisLoader}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading Praxis. Preparing your feed."
    >
      <Text style={s.praxisLoaderWordmark}>Praxis</Text>
      <Text style={s.praxisLoaderTagline}>
        Building you a more transparent and trustworthy news experience.
      </Text>
      <View style={s.praxisLoaderStatus}>
        <ActivityIndicator size="small" color="#8DAE73" />
        <Text style={s.praxisLoaderStatusText}>Preparing your feed</Text>
      </View>
    </View>
  );
}

type DeckCardProps = {
  article: Article;
  articleIndex: number;
  isActive: boolean;
  isSaved: boolean;
  isDigestCard: boolean;
  visualIndex: SharedValue<number>;
  screenWidth: number;
  swipeExitDistance: number;
  onSaveArticle: (articleId: number) => void;
  onShareArticle: (article: Article) => void;
  onReadArticle: (article: Article) => void;
  verticalReserve: number;
};

const DeckCard = memo(function DeckCard({
  article,
  articleIndex,
  isActive,
  isSaved,
  isDigestCard,
  visualIndex,
  screenWidth,
  swipeExitDistance,
  onSaveArticle,
  onShareArticle,
  onReadArticle,
  verticalReserve,
}: DeckCardProps) {
  const handleSave = useCallback(() => {
    onSaveArticle(article.id);
  }, [article.id, onSaveArticle]);

  const handleShare = useCallback(() => {
    onShareArticle(article);
  }, [article, onShareArticle]);

  const handleRead = useCallback(() => {
    onReadArticle(article);
  }, [article, onReadArticle]);

  useEffect(() => {
    if (!SWIPE_DIAGNOSTICS) return;
    console.info('[SwipePerf] card mounted', {
      articleId: article.id,
      articleIndex,
      at: Date.now(),
    });

    return () => {
      console.info('[SwipePerf] card unmounted', {
        articleId: article.id,
        articleIndex,
        at: Date.now(),
      });
    };
  }, [article.id, articleIndex]);

  if (SWIPE_DIAGNOSTICS) {
    console.info('[SwipePerf] card render', {
      articleId: article.id,
      articleIndex,
      isActive,
      at: Date.now(),
    });
  }

  const animatedStyle = useAnimatedStyle<ViewStyle>(() => {
    const diff = articleIndex - visualIndex.value;
    const stackX = interpolate(
      diff,
      [-1, 0, 1, 2, 3, 4],
      [-swipeExitDistance, 0, 20, 40, 60, 80],
      Extrapolation.CLAMP,
    );
    const translateX = isActive && diff > 0
      ? interpolate(diff, [0, 1], [0, swipeExitDistance], Extrapolation.CLAMP)
      : stackX;
    const rotate = isActive
      ? interpolate(
          translateX,
          [-screenWidth / 2, 0, screenWidth / 2],
          [-8, 0, 8],
          Extrapolation.CLAMP,
        )
      : 0;
    const scale = interpolate(
      diff,
      [-1, 0, 1, 2, 3, 4],
      [0.95, 1, 0.95, 0.9, 0.85, 0.8],
      Extrapolation.CLAMP,
    );
    const opacity = interpolate(
      diff,
      [-1, 0, 1, 2, 3, 4],
      [0, 1, 0.7, 0.4, 0.2, 0],
      Extrapolation.CLAMP,
    );

    return {
      opacity,
      transform: [
        { translateX },
        { rotate: `${rotate}deg` as `${number}deg` },
        { scale },
      ],
    } as ViewStyle;
  });

  return (
    <Animated.View
      pointerEvents={isActive ? 'auto' : 'none'}
      // Older articles always stay above newer ones. This supports both swipe
      // directions without reordering native image/shadow layers at handoff.
      style={[s.deckCard, { zIndex: 10 - articleIndex }, animatedStyle]}
    >
      <ArticleCard
        article={article}
        // The wrapper exclusively owns pointer events. Keeping the heavy card
        // body active avoids rerendering its image/gradient tree at handoff.
        isActive
        isSaved={isSaved}
        onSave={handleSave}
        onShare={handleShare}
        onRead={handleRead}
        canSwipeRight={false}
        isDigestCard={isDigestCard}
        verticalReserve={verticalReserve}
      />
    </Animated.View>
  );
});

export default function FeedScreen() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isNarrowScreen = screenWidth < 350;
  const swipeExitDistance = screenWidth * 1.05;
  const { isGuestMode, profile, refreshProfile, user, session } = useAuth();
  // Guided tour (port of the web onboarding): swipe tooltip, then a banner
  // pointing at the Graph tab. Flags live on the profile / device.
  const {
    shouldShowSwipeTooltip,
    shouldShowGraphBanner,
    completeStep: completeOnboardingStep,
  } = useOnboarding(session);
  const [onboardingSwipeCount, setOnboardingSwipeCount] = useState(0);
  const { announceAwardedBadgeIds, celebrateDigestCompletion } = useBadgeCelebration();
  const {
    preferences,
    applyTopNewsPreferences,
    syncQueryState,
    syncCustomizeState,
    syncTopNewsFallbackState,
    syncPersonalizedState,
  } = useNewsPreferences();
  const c = FEED_COLORS;
  const profileTopicsKey = profile?.topics?.join('|') ?? 'Technology';
  const profileTopics = useMemo(
    () => (profile?.topics?.length ? profile.topics : ['Technology']),
    [profileTopicsKey],
  );

  const {
    articles,
    isLoading: loading,
    isStreaming,
    isAllCaughtUp,
    feedMode,
    feedPreferenceSignature,
    streamError,
    hasCachedArticles,
    currentArticleIndex: externalIndex,
    setCurrentArticleIndex: setExternalIndex,
    setFeedContext,
    loadFromPreferences,
    requestMoreArticles,
    clearStreamError,
  } = useFeedArticles();
  const [displayIndex, setDisplayIndex] = useState(externalIndex);
  const displayIndexRef = useRef(externalIndex);
  const scheduledIndexRef = useRef<{
    from: number;
    to: number;
    scheduledAt: number;
  } | null>(null);
  const index = displayIndex;
  const setCurrentIndex = useCallback((nextIndex: number) => {
    const fromIndex = displayIndexRef.current;
    if (SWIPE_DIAGNOSTICS) {
      scheduledIndexRef.current = {
        from: fromIndex,
        to: nextIndex,
        scheduledAt: Date.now(),
      };
      console.info('[SwipePerf] React index scheduled', {
        from: fromIndex,
        to: nextIndex,
        at: Date.now(),
      });
    }
    displayIndexRef.current = nextIndex;
    setDisplayIndex(nextIndex);
    setExternalIndex(nextIndex);
  }, [setExternalIndex]);

  useLayoutEffect(() => {
    if (!SWIPE_DIAGNOSTICS) return;
    const scheduled = scheduledIndexRef.current;
    if (!scheduled || scheduled.to !== displayIndex) return;

    const committedAt = Date.now();
    console.info('[SwipePerf] React index committed', {
      from: scheduled.from,
      to: scheduled.to,
      scheduledAt: scheduled.scheduledAt,
      committedAt,
      commitDelayMs: committedAt - scheduled.scheduledAt,
    });
    scheduledIndexRef.current = null;
  }, [displayIndex]);
  const [loadedArticlesCount, setLoadedArticlesCount] = useState(() => {
    if (articles.length === 0) {
      return ARTICLES_PER_PAGE;
    }

    const targetVisibleCount = Math.max(
      ARTICLES_PER_PAGE,
      index + STACK_RENDER_COUNT + 1,
    );

    return Math.min(
      Math.ceil(targetVisibleCount / ARTICLES_PER_PAGE) * ARTICLES_PER_PAGE,
      articles.length,
    );
  });
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [savedCount, setSavedCount] = useState(0);
  const [localStreakCount, setLocalStreakCount] = useState(0);
  const [isViewingCompletedDigest, setIsViewingCompletedDigest] = useState(false);
  const [isDigestDismissed, setIsDigestDismissed] = useState(false);
  const [isDigestDismissalLoaded, setIsDigestDismissalLoaded] = useState(false);
  const [isDigestProgressOpen, setIsDigestProgressOpen] = useState(true);
  const [digestResumeIndex, setDigestResumeIndex] = useState(0);
  const [dailyDigestFeed, setDailyDigestFeed] = useState<DailyDigestFeed | null>(null);
  // A story opened from a shared link sits at the top of the deck as a guest
  // card (not a Digest card) and is dropped on the first swipe, so the regular
  // deck, Digest first if unfinished, takes over at index 0 unchanged.
  const [sharedStory, setSharedStory] = useState<Article | null>(null);
  const [isDigestCompletionVisible, setIsDigestCompletionVisible] = useState(false);
  const [isDigestHandoffActive, setIsDigestHandoffActive] = useState(false);
  const [showGuestStreakPrompt, setShowGuestStreakPrompt] = useState(false);
  const [notifPromptAsk, setNotifPromptAsk] = useState<NotificationAsk | null>(null);
  const [cachedStreak, setCachedStreak] = useState<number | null>(null);
  useEffect(() => {
    void readCachedStreak().then(setCachedStreak);
  }, []);
  useEffect(() => {
    if (profile?.current_streak != null) {
      setCachedStreak(profile.current_streak);
      void writeCachedStreak(profile.current_streak);
    }
  }, [profile?.current_streak]);
  const [accountPrompt, setAccountPrompt] = useState<{
    feature: 'saved' | 'search';
    returnTo: string;
  } | null>(null);
  const [shareSheetArticle, setShareSheetArticle] = useState<Article | null>(null);
  const [digestCompletionSummary, setDigestCompletionSummary] = useState({
    storyCount: 0,
    sourceCount: 0,
    topicCount: 0,
  });
  const visualIndex = useSharedValue(externalIndex);
  const digestProgressValue = useSharedValue(0);
  const digestBarSeededRef = useRef(false);
  const deckTransitionTranslateY = useSharedValue(0);
  const digestCompletionOpacity = useSharedValue(0);
  const digestCompletionScale = useSharedValue(0.95);
  const digestCompletionTranslateY = useSharedValue(12);
  const queuedReadIdsRef = useRef<Set<number>>(new Set());
  const pendingDigestResumeIndexRef = useRef<number | null>(null);
  const guestStreakPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissGuestStreakPrompt = useCallback(() => {
    setShowGuestStreakPrompt(false);
  }, []);
  const lastHandledRequestNonceRef = useRef<number | null>(null);
  const activeQuery = preferences.activeQuery;
  const hasCustomQuery = Boolean(
    activeQuery && (activeQuery.topics.length > 0 || activeQuery.promptTerms.length > 0),
  );
  const isDailyDigestActive = Boolean(
    preferences.isTopNewsActive &&
      dailyDigestFeed &&
      !dailyDigestFeed.isComplete &&
      !isDigestDismissed,
  );
  const hasIncompleteDailyDigest = Boolean(
    preferences.isTopNewsActive && dailyDigestFeed && !dailyDigestFeed.isComplete,
  );
  const isDigestArchiveViewActive = Boolean(
    preferences.isTopNewsActive &&
      dailyDigestFeed?.isComplete &&
      isViewingCompletedDigest,
  );
  // Keep the completed Digest deck in place under its transition card. Web
  // does not reveal Top News until the completion handoff has finished.
  const isDigestModeVisible = isDailyDigestActive || isDigestArchiveViewActive || (
    isDigestCompletionVisible && !isDigestHandoffActive
  );
  // Never make the ordinary Top News stack interactive while its Digest is
  // still being assembled. In particular, this prevents cached articles from
  // appearing briefly before the canonical Digest replaces them.
  const isDigestPreparing = Boolean(
    preferences.isTopNewsActive &&
      (!isDigestDismissalLoaded || (
        !isDigestDismissed &&
        !dailyDigestFeed &&
        (feedMode !== 'top-news' || isStreaming || loading || articles.length > 0)
      )),
  );
  const topNewsArticles = useMemo(
    () => dailyDigestFeed && preferences.isTopNewsActive
      ? articles.filter((article) => !dailyDigestFeed.state.articleIds.includes(article.id))
      : articles,
    [articles, dailyDigestFeed, preferences.isTopNewsActive],
  );
  const baseFeedArticles = isDigestModeVisible && dailyDigestFeed
    ? dailyDigestFeed.displayArticles
    : topNewsArticles;
  const feedArticles = useMemo(
    () => sharedStory
      ? [sharedStory, ...baseFeedArticles.filter((article) => article.id !== sharedStory.id)]
      : baseFeedArticles,
    [baseFeedArticles, sharedStory],
  );
  const digestArticleIdSet = useMemo(
    () => new Set(dailyDigestFeed?.state.articleIds ?? []),
    [dailyDigestFeed?.state.articleIds],
  );
  useEffect(() => {
    void readDailyDigestDismissal().then((dismissed) => {
      setIsDigestDismissed(dismissed);
      setIsDigestDismissalLoaded(true);
    });
  }, []);
  const expectedFeedMode = useMemo(() => {
    if (preferences.isTopNewsActive) return 'top-news';
    if (preferences.recommendationRequest) return 'query';
    return 'personalized';
  }, [preferences.isTopNewsActive, preferences.recommendationRequest]);
  const expectedPreferenceSignature = useMemo(() => buildFeedPreferenceSignature({
    activeQuery: preferences.activeQuery,
    recommendationRequest: preferences.recommendationRequest,
    topNewsGraphFilter: preferences.topNewsGraphFilter,
    isTopNewsActive: preferences.isTopNewsActive,
    profileTopics,
  }), [
    preferences.activeQuery,
    preferences.isTopNewsActive,
    preferences.recommendationRequest,
    preferences.topNewsGraphFilter,
    profileTopics,
  ]);

  useEffect(() => {
    const pendingDigestIndex = pendingDigestResumeIndexRef.current;
    if (pendingDigestIndex !== null && isDailyDigestActive) {
      if (externalIndex !== pendingDigestIndex) {
        displayIndexRef.current = pendingDigestIndex;
        setDisplayIndex(pendingDigestIndex);
        setExternalIndex(pendingDigestIndex);
        cancelAnimation(visualIndex);
        visualIndex.value = pendingDigestIndex;
        return;
      }

      if (feedMode === 'top-news' && !isStreaming) {
        pendingDigestResumeIndexRef.current = null;
      }
    }

    if (externalIndex === displayIndexRef.current) return;
    displayIndexRef.current = externalIndex;
    setDisplayIndex(externalIndex);
    cancelAnimation(visualIndex);
    visualIndex.value = externalIndex;
  }, [externalIndex, feedMode, isDailyDigestActive, isStreaming, setExternalIndex, visualIndex]);

  const getCustomQueryDisplay = useCallback(() => {
    if (!activeQuery) return '';
    const allTerms = [
      ...activeQuery.topics.map(humanizeTopicLabel),
      ...activeQuery.promptTerms,
    ];
    if (allTerms.length <= 2) {
      return allTerms.join(' · ');
    }
    return `${allTerms.slice(0, 2).join(' · ')} +${allTerms.length - 2}`;
  }, [activeQuery]);

  const fetchSaved = useCallback(async () => {
    if (!user) {
      setSavedIds(new Set());
      setSavedCount(0);
      return;
    }

    const localSaved = await readSavedArticles(user.id);
    const localIds = new Set<number>(localSaved.map((article) => article.id));
    setSavedIds(localIds);
    setSavedCount(localIds.size);

    try {
      // Same table and columns the web app writes; rows carry the article
      // fields, so most need no extra lookup.
      const { data, error } = await supabase
        .from('saved_articles')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const localById = new Map(localSaved.map((article) => [article.id, article]));
      const hydratedRows = await Promise.all((data ?? []).map(async (row: RemoteSavedArticleRow) => {
        const remote = fromRemoteSavedArticleRow(row);
        const localArticle = localById.get(remote.id);
        if (localArticle?.url) {
          return { ...localArticle, saved_at: remote.saved_at ?? localArticle.saved_at };
        }
        if (hasRenderableSavedArticle(remote)) return remote;

        try {
          const liveArticle = await fetchLiveArticleById(remote.id);
          return liveArticle ? { ...liveArticle, saved_at: remote.saved_at } : remote;
        } catch {
          return remote;
        }
      }));

      const merged = await mergeSavedArticles(
        user.id,
        hydratedRows,
      );

      const nextIds = new Set<number>(merged.map((article) => article.id));
      setSavedIds(nextIds);
      setSavedCount(nextIds.size);
    } catch (error) {
      console.warn('[FeedScreen] Failed to refresh saved articles from remote', error);
    }
  }, [user]);

  useEffect(() => {
    const hasExplicitNewRequest =
      preferences.requestNonce > 0 &&
      preferences.requestNonce !== lastHandledRequestNonceRef.current;
    const shouldHydrateInitialFeed = !hasCachedArticles;
    const shouldReconcileCachedFeed =
      hasCachedArticles && (
        feedMode !== expectedFeedMode ||
        feedPreferenceSignature !== expectedPreferenceSignature
      );

    if (!hasExplicitNewRequest && !shouldHydrateInitialFeed && !shouldReconcileCachedFeed) {
      return;
    }

    if (hasExplicitNewRequest) {
      lastHandledRequestNonceRef.current = preferences.requestNonce;
      // Graph "Apply" while the Digest was showing: leave the Digest for the
      // day so the applied range is what comes up (Ayuka, 2026-09-21).
      if (consumeDailyDigestExitRequest()) {
        setIsDigestDismissed(true);
        void writeDailyDigestDismissal(true);
      }
    }

    void loadFromPreferences({
      activeQuery: preferences.activeQuery,
      recommendationRequest: preferences.recommendationRequest,
      prefetchedQueryArticles: preferences.prefetchedQueryArticles as Article[] | null,
      isTopNewsActive: preferences.isTopNewsActive,
      topNewsGraphFilter: preferences.topNewsGraphFilter,
      profileTopics,
    });
  }, [
    hasCachedArticles,
    loadFromPreferences,
    preferences.activeQuery,
    preferences.isTopNewsActive,
    preferences.prefetchedQueryArticles,
    preferences.recommendationRequest,
    preferences.requestNonce,
    preferences.topNewsGraphFilter,
    profileTopics,
    feedMode,
    feedPreferenceSignature,
    expectedFeedMode,
    expectedPreferenceSignature,
  ]);

  useEffect(() => {
    if (preferences.requestNonce <= 0) {
      return;
    }

    const nextIndex = pendingDigestResumeIndexRef.current ?? 0;
    cancelAnimation(visualIndex);
    visualIndex.value = nextIndex;
    displayIndexRef.current = nextIndex;
    setDisplayIndex(nextIndex);

    setLoadedArticlesCount(ARTICLES_PER_PAGE);
  }, [preferences.requestNonce, visualIndex]);

  useEffect(() => {
    if (!streamError) return;

    if (feedMode === 'top-news' && !preferences.isTopNewsActive) {
      syncTopNewsFallbackState(null);
    }

    const fallbackMessage =
      feedMode === 'top-news'
        ? 'Showing Top News instead.'
        : 'Showing backup stories for now.';

    Alert.alert(
      'Recommendations unavailable',
      fallbackMessage,
      [{ text: 'OK', onPress: clearStreamError }],
    );
  }, [
    clearStreamError,
    feedMode,
    preferences.isTopNewsActive,
    streamError,
    syncTopNewsFallbackState,
  ]);

  useEffect(() => {
    if (
      feedMode === 'query' &&
      preferences.isTopNewsActive &&
      preferences.activeQuery &&
      preferences.recommendationRequest
    ) {
      syncQueryState({
        activeQuery: preferences.activeQuery,
        recommendationRequest: preferences.recommendationRequest,
        prefetchedArticles: preferences.prefetchedQueryArticles as Article[] | null,
      });
    }
  }, [
    feedMode,
    preferences.activeQuery,
    preferences.isTopNewsActive,
    preferences.prefetchedQueryArticles,
    preferences.recommendationRequest,
    syncQueryState,
  ]);

  useEffect(() => {
    if (
      feedMode === 'personalized' &&
      !preferences.isTopNewsActive &&
      preferences.activeQuery &&
      !preferences.recommendationRequest
    ) {
      syncPersonalizedState();
    }
  }, [
    feedMode,
    preferences.activeQuery,
    preferences.isTopNewsActive,
    preferences.recommendationRequest,
    syncPersonalizedState,
  ]);

  useEffect(() => { fetchSaved(); }, [fetchSaved]);

  useEffect(() => {
    if (!user) return;

    const unsubscribe = subscribeSavedArticles(user.id, (articles) => {
      const nextIds = new Set<number>(articles.map((article) => article.id));
      setSavedIds(nextIds);
      setSavedCount(nextIds.size);
    });

    return unsubscribe;
  }, [user]);

  useEffect(() => {
    let isActive = true;

    void readReadingActivitySummary(user?.id).then((summary) => {
      if (!isActive) return;
      setLocalStreakCount(summary.currentStreak);
    });

    const unsubscribe = subscribeReadingActivity(user?.id, (summary) => {
      setLocalStreakCount(summary.currentStreak);
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [user?.id]);

  useEffect(() => {
    setLoadedArticlesCount((prev) => {
      let nextCount = prev;

      if (feedArticles.length === 0) {
        nextCount = ARTICLES_PER_PAGE;
      } else if (feedArticles.length < prev) {
        nextCount = Math.min(ARTICLES_PER_PAGE, feedArticles.length);
      } else {
        nextCount = Math.min(prev, feedArticles.length);
        if (nextCount === 0) {
          nextCount = Math.min(ARTICLES_PER_PAGE, feedArticles.length);
        }
      }
      return nextCount;
    });
  }, [feedArticles.length]);

  useEffect(() => {
    if (feedArticles.length === 0) {
      setCurrentIndex(0);
      return;
    }

    if (index > feedArticles.length - 1) {
      setCurrentIndex(feedArticles.length - 1);
    }
  }, [feedArticles.length, index, setCurrentIndex]);

  useEffect(() => {
    if (feedArticles.length === 0) return;

    if (loadedArticlesCount > index) return;

    const targetVisibleCount = Math.max(
      ARTICLES_PER_PAGE,
      index + STACK_RENDER_COUNT + 1,
    );

    setLoadedArticlesCount(
      Math.min(
        Math.ceil(targetVisibleCount / ARTICLES_PER_PAGE) * ARTICLES_PER_PAGE,
        feedArticles.length,
      ),
    );
  }, [feedArticles.length, index, loadedArticlesCount]);

  const maxAvailableArticles = Math.min(loadedArticlesCount, feedArticles.length);
  const safeIndex = maxAvailableArticles > 0
    ? Math.max(0, Math.min(index, maxAvailableArticles - 1))
    : 0;

  useEffect(() => {
    if (isDailyDigestActive) setDigestResumeIndex(safeIndex);
  }, [isDailyDigestActive, safeIndex]);

  useEffect(() => {
    if (typeof Image.prefetch !== 'function') return;

    const prefetched = feedArticles
      .slice(0, maxAvailableArticles)
      .map((article) => article.image_url)
      .filter((value): value is string => Boolean(value));

    if (SWIPE_DIAGNOSTICS) {
      console.info('[SwipePerf] prefetch window', {
        start: 0,
        end: maxAvailableArticles,
        count: prefetched.length,
        at: Date.now(),
      });
    }

    prefetched.forEach((uri) => {
      void Image.prefetch(uri).catch(() => {});
    });
  }, [feedArticles, maxAvailableArticles]);

  const reloadFeed = useCallback(() => loadFromPreferences({
    activeQuery: preferences.activeQuery,
    recommendationRequest: preferences.recommendationRequest,
    prefetchedQueryArticles: preferences.prefetchedQueryArticles as Article[] | null,
    isTopNewsActive: preferences.isTopNewsActive,
    topNewsGraphFilter: preferences.topNewsGraphFilter,
    profileTopics,
  }), [
    loadFromPreferences,
    preferences.activeQuery,
    preferences.isTopNewsActive,
    preferences.prefetchedQueryArticles,
    preferences.recommendationRequest,
    preferences.topNewsGraphFilter,
    profileTopics,
  ]);

  const resetDeckPosition = useCallback(() => {
    cancelAnimation(visualIndex);
    visualIndex.value = 0;
    displayIndexRef.current = 0;
    setDisplayIndex(0);
    setExternalIndex(0);
  }, [setExternalIndex, visualIndex]);

  // Digest and Top News use different card collections. Keep the card reset
  // that prevents stale cards from flashing, but soften the handoff without
  // lowering deck opacity (which can reveal the cards behind it).
  const transitionDeckMode = useCallback(() => {
    cancelAnimation(deckTransitionTranslateY);
    deckTransitionTranslateY.value = 6;
    deckTransitionTranslateY.value = withTiming(0, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [deckTransitionTranslateY]);

  const deckTransitionAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: deckTransitionTranslateY.value }],
  }));

  const handleToggleTopNews = useCallback(() => {
    transitionDeckMode();
    if (!preferences.isTopNewsActive) {
      setIsDigestDismissed(false);
      void writeDailyDigestDismissal(false);
      applyTopNewsPreferences(null);
      return;
    }

    const personalizedSignature = buildFeedPreferenceSignature({
      activeQuery: null,
      recommendationRequest: null,
      topNewsGraphFilter: null,
      isTopNewsActive: false,
      profileTopics,
    });

    syncCustomizeState();
    setFeedContext('personalized', personalizedSignature);
  }, [
    applyTopNewsPreferences,
    transitionDeckMode,
    preferences.isTopNewsActive,
    profileTopics,
    setFeedContext,
    syncCustomizeState,
  ]);

  const handleDigestPillPress = useCallback(() => {
    if (isDigestArchiveViewActive) {
      transitionDeckMode();
      setIsViewingCompletedDigest(false);
      resetDeckPosition();
      return;
    }

    if (isDailyDigestActive) {
      transitionDeckMode();
      setDigestResumeIndex(safeIndex);
      setIsDigestDismissed(true);
      void writeDailyDigestDismissal(true);
      resetDeckPosition();
      return;
    }
    handleToggleTopNews();
  }, [
    isDailyDigestActive,
    isDigestArchiveViewActive,
    handleToggleTopNews,
    resetDeckPosition,
    safeIndex,
    transitionDeckMode,
  ]);

  const handleResumeDailyDigest = useCallback(() => {
    if (!dailyDigestFeed || dailyDigestFeed.isComplete) return;
    transitionDeckMode();
    const targetIndex = Math.min(
      Math.max(digestResumeIndex, dailyDigestFeed.completedCount),
      Math.max(dailyDigestFeed.displayArticles.length - 1, 0),
    );

    if (!preferences.isTopNewsActive) {
      pendingDigestResumeIndexRef.current = targetIndex;
      applyTopNewsPreferences(null);
    }

    setIsViewingCompletedDigest(false);
    setIsDigestDismissed(false);
    void writeDailyDigestDismissal(false);
    setCurrentIndex(targetIndex);
  }, [
    applyTopNewsPreferences,
    dailyDigestFeed,
    digestResumeIndex,
    preferences.isTopNewsActive,
    setCurrentIndex,
    transitionDeckMode,
  ]);

  useEffect(() => {
    if (
      !preferences.isTopNewsActive ||
      !isDigestDismissalLoaded ||
      isDigestDismissed ||
      dailyDigestFeed ||
      articles.length === 0 ||
      feedMode !== 'top-news' ||
      isStreaming
    ) return;

    let cancelled = false;
    void buildCanonicalDailyDigestFeed(articles).then((nextDigestFeed) => {
      if (cancelled) return;
      setDailyDigestFeed(nextDigestFeed);
    });

    return () => {
      cancelled = true;
    };
  }, [
    articles,
    dailyDigestFeed,
    isDigestDismissalLoaded,
    isDigestDismissed,
    feedMode,
    isStreaming,
    preferences.isTopNewsActive,
  ]);

  const handleEditQuery = useCallback(() => {
    setIsViewingCompletedDigest(false);
    router.navigate('/graph');
  }, []);

  const handleViewCompletedDigest = useCallback(() => {
    if (!dailyDigestFeed?.isComplete) return;

    // The archive is a read-only digest view. It never replays completion.
    setIsViewingCompletedDigest(true);
    resetDeckPosition();
  }, [
    dailyDigestFeed?.isComplete,
    resetDeckPosition,
  ]);

  const handleSaveGuestStreak = useCallback(() => {
    setShowGuestStreakPrompt(false);
    router.replace(buildHref('/login', { returnTo: '/' }));
  }, []);

  useEffect(() => () => {
    if (guestStreakPromptTimeoutRef.current) {
      clearTimeout(guestStreakPromptTimeoutRef.current);
    }
  }, []);

  const handleOpenTodayDigest = useCallback(async () => {
    const sourceArticles = preferences.isTopNewsActive
      ? articles
      : await loadFromPreferences({
          activeQuery: null,
          recommendationRequest: null,
          prefetchedQueryArticles: null,
          isTopNewsActive: true,
          topNewsGraphFilter: null,
          profileTopics,
        });
    const nextDigestFeed = await buildCanonicalDailyDigestFeed(sourceArticles);

    setDailyDigestFeed(nextDigestFeed);
    setIsDigestDismissed(false);
    void writeDailyDigestDismissal(false);
    applyTopNewsPreferences(null);
    setIsViewingCompletedDigest(nextDigestFeed.isComplete);
    resetDeckPosition();
  }, [
    applyTopNewsPreferences,
    articles,
    loadFromPreferences,
    preferences.isTopNewsActive,
    profileTopics,
    resetDeckPosition,
  ]);

  useFocusEffect(useCallback(() => {
    const requestedId = consumeSharedStoryRequest();
    if (requestedId === null) return;

    let cancelled = false;
    void fetchSharedStoryArticle(requestedId).then((article) => {
      if (cancelled || !article) return;
      setSharedStory(article);
      setCurrentIndex(0);
      resetDeckPosition();
    });

    return () => {
      cancelled = true;
    };
  }, [resetDeckPosition, setCurrentIndex]));

  const isFeedScreenFocusedRef = useRef(false);
  useFocusEffect(useCallback(() => {
    isFeedScreenFocusedRef.current = true;
    let cancelled = false;

    void readDailyDigestOpenRequest().then((requested) => {
      if (!requested || cancelled) return;
      void writeDailyDigestOpenRequest(false);
      void handleOpenTodayDigest();
    });

    return () => {
      isFeedScreenFocusedRef.current = false;
      cancelled = true;
    };
  }, [handleOpenTodayDigest]));

  // A push tapped while this screen is ALREADY focused never re-runs the
  // focus effect — without this live subscription the request sat unconsumed
  // and fired on a later, unrelated tab switch.
  useEffect(() => subscribeDailyDigestOpenRequest(() => {
    if (!isFeedScreenFocusedRef.current) return; // the focus effect will consume it
    void readDailyDigestOpenRequest().then((requested) => {
      if (!requested) return;
      void writeDailyDigestOpenRequest(false);
      void handleOpenTodayDigest();
    });
  }), [handleOpenTodayDigest]);

  const articleAnalyticsContext = useCallback((
    article: Article,
    extras: { positionInFeed?: number } = {},
  ) => buildArticleAnalyticsContext(
    {
      id: article.id,
      title: article.title,
      source: article.source ?? article.publisher?.name ?? null,
      url: article.url,
      category: article.category,
      x: article.x,
      y: article.y,
      meta: article.meta,
    },
    {
      surface: 'home_feed',
      feedMode: normalizeFeedMode(feedMode),
      topics: article.topics,
      ...extras,
    },
  ), [feedMode]);

  const markRead = useCallback((article: Article, completionMethod: 'swipe' | 'open') => {
    if (completionMethod === 'swipe') {
      setOnboardingSwipeCount((count) => count + 1);
      void completeOnboardingStep('onboarding_swipe_completed');
    }
    void logArticleRead(user?.id, {
      id: article.id,
      topics: article.topics,
      title: article.title,
    });

    // Fires for guests too — the old inline analytics insert only counted
    // signed-in users, which is why mobile engagement was invisible.
    void trackArticleReadComplete({
      ...articleAnalyticsContext(article),
      completionMethod,
    });

    if (!user) return;
    if (queuedReadIdsRef.current.has(article.id)) return;

    queuedReadIdsRef.current.add(article.id);

    void (async () => {
      try {
        const { error } = await supabase.from('read_articles').insert({
          user_id: user.id,
          article_id: article.id,
          read_at: new Date().toISOString(),
        });

        if (error) {
          if ((error as { code?: string }).code === '23505') {
            return;
          }
          throw error;
        }

        const shouldUpdateStreak = await claimDailyStreakUpdate(user.id);
        await Promise.allSettled([
          supabase.rpc('increment_articles_read', { uid: user.id }),
          ...(shouldUpdateStreak ? [supabase.rpc('update_reading_streak', { uid: user.id })] : []),
        ]);

        const { data: awardResult, error: badgeError } = await supabase.functions.invoke('award-badge', { body: { userId: user.id } });
        if (badgeError) {
          console.warn('[FeedScreen] Failed to check badges after read', badgeError);
        } else {
          await announceAwardedBadgeIds(Array.isArray(awardResult?.awarded) ? awardResult.awarded : []);
        }
      } catch (error) {
        queuedReadIdsRef.current.delete(article.id);
        console.warn('[FeedScreen] Failed to mark article read', error);
      }
    })();
  }, [announceAwardedBadgeIds, articleAnalyticsContext, user]);

  const toggleSave = useCallback(async (articleId: number) => {
    if (!user) {
      setAccountPrompt({ feature: 'saved', returnTo: '/' });
      return;
    }

    const isSaved = savedIds.has(articleId);
    const article = feedArticles.find((item) => item.id === articleId);
    if (!article) return;

    if (isSaved) {
      await removeSavedArticle(user.id, articleId);
    } else {
      await upsertSavedArticle(user.id, {
        id: article.id,
        title: article.title,
        lede: article.lede,
        image_url: article.image_url,
        url: article.url,
        ts_pub: article.ts_pub,
        publisher: article.publisher ?? null,
        x: article.x,
        y: article.y,
        category: article.category,
        topics: article.topics,
        meta: article.meta,
      });
    }

    try {
      if (isSaved) {
        const { error } = await supabase.from('saved_articles').delete()
          .eq('user_id', user.id)
          .eq('article_id', String(articleId));
        if (error) throw error;
      } else {
        // Full row: the table requires title and the web reads the other
        // columns back. An id-only insert was rejected, so saves never
        // reached the account.
        const { error } = await supabase
          .from('saved_articles')
          .insert(toRemoteSavedArticleRow(user.id, {
            id: article.id,
            title: article.title,
            lede: article.lede ?? '',
            image_url: article.image_url,
            url: article.url,
            ts_pub: article.ts_pub,
            publisher: article.publisher ?? null,
            category: article.category ?? null,
          }));
        if (error && (error as { code?: string }).code !== '23505') {
          throw error;
        }
      }
    } catch (error) {
      console.warn('[FeedScreen] Remote bookmark sync failed; kept local bookmark state', error);
    }
  }, [feedArticles, savedIds, user]);

  const promptForAccount = useCallback((feature: 'saved' | 'search') => {
    setAccountPrompt({
      feature,
      returnTo: feature === 'saved' ? '/saved' : '/search',
    });
  }, []);

  const shareArticle = useCallback((article: Article) => {
    setShareSheetArticle(article);
  }, []);

  const loadingMore = isStreaming && !loading;

  useEffect(() => {
    const remainingInBatch = loadedArticlesCount - safeIndex;
    const hasMoreLoadedArticles = feedArticles.length > loadedArticlesCount;
    const isNearVisibleEnd = remainingInBatch <= 5;

    if (isNearVisibleEnd && hasMoreLoadedArticles && !loadingMore) {
      setLoadedArticlesCount((prev) => {
        return Math.min(prev + ARTICLES_PER_PAGE, feedArticles.length);
      });
    }

    const remainingTotal = feedArticles.length - safeIndex;
    if (
      feedMode === 'query' &&
      !isDailyDigestActive &&
      remainingTotal <= 3 &&
      !loadingMore &&
      !loading &&
      !isAllCaughtUp
    ) {
      void requestMoreArticles();
    }
  }, [
    feedArticles.length,
    feedMode,
    isAllCaughtUp,
    isDailyDigestActive,
    loadedArticlesCount,
    loading,
    loadingMore,
    requestMoreArticles,
    safeIndex,
  ]);

  const completeDigestArticle = useCallback(async (articleId: number) => {
    if (!isDailyDigestActive || !digestArticleIdSet.has(articleId)) return false;

    const nextState = await markDailyDigestArticleComplete(articleId);
    const isComplete =
      nextState.articleIds.length > 0 &&
      nextState.completedIds.length >= nextState.articleIds.length;
    setDailyDigestFeed((previous) => {
      if (!previous) return previous;
      const completedIds = nextState.completedIds.filter((id) =>
        previous.state.articleIds.includes(id),
      );
      return {
        ...previous,
        state: {
          ...previous.state,
          completedIds,
        },
        completedCount: completedIds.length,
        isComplete: previous.totalCount > 0 && completedIds.length >= previous.totalCount,
      };
    });

    if (!isComplete) return false;

    if (user) {
      void awardDigestStreak(user.id).then((streak) => {
        if (streak !== null) void refreshProfile();
      });
    }

    const digestArticles = dailyDigestFeed?.digestArticles ?? [];
    setDigestCompletionSummary({
      storyCount: digestArticles.length,
      sourceCount: new Set(
        digestArticles
          .map((digestArticle) => digestArticle.publisher?.name || digestArticle.source)
          .filter(Boolean),
      ).size,
      topicCount: new Set(
        digestArticles.flatMap((digestArticle) => digestArticle.topics ?? []),
      ).size,
    });
    celebrateDigestCompletion();
    // Replace the deck immediately, while the final Digest card is leaving.
    // The recap then sits over the first Top News card for its full duration;
    // it never has to switch card stacks in the background.
    articles
      .filter((article) => !nextState.articleIds.includes(article.id))
      .slice(0, STACK_RENDER_COUNT)
      .forEach((article) => {
        if (article.image_url) void Image.prefetch(article.image_url);
      });
    setIsDigestHandoffActive(true);
    setCurrentIndex(0);
    setIsDigestCompletionVisible(true);
    if (isGuestMode || !user) {
      if (guestStreakPromptTimeoutRef.current) {
        clearTimeout(guestStreakPromptTimeoutRef.current);
      }
      // Notification ask OUTRANKS the account prompt for guests — without a
      // notification most guests never come back for a second digest (Ayuka,
      // 2026-09-15). One card per celebration: whichever is due, the other waits.
      void recordDigestCompletionForPrompt().then((ask) => {
        guestStreakPromptTimeoutRef.current = setTimeout(() => {
          if (ask) {
            setNotifPromptAsk(ask);
          } else {
            setShowGuestStreakPrompt(true);
          }
          guestStreakPromptTimeoutRef.current = null;
        }, 4400);
      });
    } else {
      // Ask for notification permission after a delivered win, never at sign-in.
      // Timing rules (1st completion, then 3rd, then never) live in the lib.
      void recordDigestCompletionForPrompt().then((ask) => {
        if (!ask) return;
        if (notifPromptTimeoutRef.current) {
          clearTimeout(notifPromptTimeoutRef.current);
        }
        // The completion recap dismisses itself at ~2.9s; show the card after.
        notifPromptTimeoutRef.current = setTimeout(() => {
          setNotifPromptAsk(ask);
          notifPromptTimeoutRef.current = null;
        }, 3300);
      });
    }
    return true;
  }, [
    refreshProfile,
    user,
    articles,
    celebrateDigestCompletion,
    dailyDigestFeed?.digestArticles,
    digestArticleIdSet,
    isDailyDigestActive,
    isGuestMode,
    setCurrentIndex,
    user,
  ]);

  const advance = useCallback((article: Article) => {
    if (sharedStory && article.id === sharedStory.id) {
      setSharedStory(null);
      resetDeckPosition();
      if (isDailyDigestActive && digestArticleIdSet.has(article.id)) {
        void completeDigestArticle(article.id);
      }
      InteractionManager.runAfterInteractions(() => {
        markRead(article, 'swipe');
      });
      return;
    }

    const nextIndex = index + 1;

    if (nextIndex >= loadedArticlesCount && feedArticles.length > loadedArticlesCount) {
      setLoadedArticlesCount((prev) =>
        Math.min(prev + ARTICLES_PER_PAGE, feedArticles.length),
      );
    }

    if (isDailyDigestActive && digestArticleIdSet.has(article.id)) {
      void completeDigestArticle(article.id).then((isComplete) => {
        if (!isComplete) setCurrentIndex(nextIndex);
      });
    } else {
      setCurrentIndex(nextIndex);
    }
    InteractionManager.runAfterInteractions(() => {
      markRead(article, 'swipe');
    });
  }, [
    digestArticleIdSet,
    celebrateDigestCompletion,
    completeDigestArticle,
    feedArticles.length,
    index,
    isDailyDigestActive,
    isGuestMode,
    loadedArticlesCount,
    markRead,
    setCurrentIndex,
    resetDeckPosition,
    sharedStory,
    user,
  ]);

  // Mirror the header streak onto the app-icon badge (Ayuka, 9/20). Same
  // source of truth as the pill: account streak when signed in, the device
  // count for guests. Skipped while the account value is still loading.
  useEffect(() => {
    const value = user
      ? (profile ? (profile.current_streak ?? 0) : cachedStreak)
      : localStreakCount;
    if (typeof value !== 'number') return;
    void syncStreakBadge(value);
  }, [user, profile?.current_streak, cachedStreak, localStreakCount]);

  const retreat = useCallback(() => {
    setCurrentIndex(Math.max(0, index - 1));
  }, [index, setCurrentIndex]);

  // Safely access articles with null checks
  let current: Article | undefined;

  try {
    const visibleArticles = feedArticles.slice(0, maxAvailableArticles);
    if (visibleArticles.length > 0) {
      current = visibleArticles[safeIndex] || undefined;
    }
  } catch (e) {
    console.error('[FeedScreen] Error accessing articles array:', e, { index, articlesLength: feedArticles?.length });
  }

  useEffect(() => {
    if (!current) return;
    void trackArticleImpression(
      articleAnalyticsContext(current, { positionInFeed: safeIndex + 1 }),
    );
    // Deps intentionally limited: fire once per top-card change, not on
    // context-builder identity churn.
  }, [current?.id]);

  const canSwipeLeft = safeIndex < maxAvailableArticles - 1;
  const canSwipeRight = safeIndex > 0;
  const remainingVisibleCards = maxAvailableArticles - safeIndex - 1;
  const showLoadingMoreIndicator =
    Boolean(current) &&
    loadingMore &&
    maxAvailableArticles > 0 &&
    maxAvailableArticles - safeIndex <= 5;
  const showAllCaughtUpIndicator =
    Boolean(current) &&
    isAllCaughtUp &&
    safeIndex > 0 &&
    remainingVisibleCards === 0;
  const digestCompletedCount = dailyDigestFeed?.completedCount ?? 0;
  const digestTotalCount = dailyDigestFeed?.totalCount ?? 0;
  const shouldShowDigestProgress = Boolean(
    dailyDigestFeed &&
      digestTotalCount > 0 &&
      !dailyDigestFeed.isComplete,
  );
  const isVisibleDigestStoryInProgress = Boolean(
    isDailyDigestActive &&
      current &&
      digestArticleIdSet.has(current.id) &&
      !dailyDigestFeed?.state.completedIds.includes(current.id),
  );
  // Cold start flashed "0/5" for the frames before the first card
  // registered as in progress, then jumped to 1/5 (Ayuka, 2026-09-19).
  // Being on story one IS 1/5, so the display floors at 1 while a digest
  // with stories is incomplete.
  const digestDisplayCompletedCount = Math.min(
    Math.max(
      digestCompletedCount + (isVisibleDigestStoryInProgress ? 1 : 0),
      digestTotalCount > 0 ? 1 : 0,
    ),
    digestTotalCount,
  );
  // The expanded Digest summary is intentionally an overlay. Reserving only
  // the compact progress control keeps the story deck from jumping down when
  // the details appear.
  // 120, measured on his build-128 phone (2026-09-18): in digest mode the
  // card starts at 228pt (the progress bar is taller than the Top News
  // chip) and at 66 its bottom (754) sat on the bar (756). 852 - 220 - 120
  // = 512 lands it 16 above the bar. Top News mode is unaffected: with no
  // reserve the width ratio binds at 532.
  const digestVerticalReserve = shouldShowDigestProgress
    && isDailyDigestActive
    ? 120
    : 0;
  const { width: cardWidth, height: cardHeight } = useMemo(
    () => getArticleCardDimensions(screenWidth, screenHeight, digestVerticalReserve),
    [digestVerticalReserve, screenHeight, screenWidth],
  );
  const digestRemainingCount = Math.max(digestTotalCount - digestDisplayCompletedCount, 0);
  const digestProgressPercentage = digestTotalCount > 0
    ? Math.min((digestDisplayCompletedCount / digestTotalCount) * 100, 100)
    : 0;
  const digestProgressAnimatedStyle = useAnimatedStyle(() => ({
    width: `${digestProgressValue.value}%`,
  }));

  useEffect(() => {
    // The first visible value paints in place — animating from the shared
    // value's 0 made the bar visibly fill to 1/5 on every cold start
    // (Ayuka, 2026-09-19, msg 1529). Later changes still ease.
    if (!digestBarSeededRef.current) {
      if (digestProgressPercentage === 0) return;
      digestBarSeededRef.current = true;
      digestProgressValue.value = digestProgressPercentage;
      return;
    }
    digestProgressValue.value = withTiming(digestProgressPercentage, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
    });
  }, [digestProgressPercentage, digestProgressValue]);
  useEffect(() => {
    if (!isDailyDigestActive || !dailyDigestFeed) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    void readDailyDigestPanelHint().then((hasShownHint) => {
      if (cancelled) return;

      if (hasShownHint) {
        setIsDigestProgressOpen(false);
        return;
      }

      setIsDigestProgressOpen(true);
      void writeDailyDigestPanelHint();
      timeout = setTimeout(() => setIsDigestProgressOpen(false), 1400);
    });

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [dailyDigestFeed?.state.date, isDailyDigestActive]);
  const digestProgressTitle = dailyDigestFeed?.isComplete
    ? "Today's Digest Complete"
    : isDigestDismissed
      ? 'Digest paused'
    : digestRemainingCount >= 4
      ? "You've started today's digest."
      : digestRemainingCount === 3
        ? "You're getting caught up on today's news."
        : digestRemainingCount === 2
          ? "You're building a broader view of today's stories."
          : 'Almost done.';
  const digestProgressBody = dailyDigestFeed?.isComplete
    ? "You're caught up on today's top stories."
    : isDigestDismissed
      ? "Jump back in anytime to finish today's curated rundown."
    : `${digestRemainingCount} stor${digestRemainingCount === 1 ? 'y' : 'ies'} left`;
  useEffect(() => {
    if (!isDigestCompletionVisible) return;

    topNewsArticles.slice(0, STACK_RENDER_COUNT).forEach((article) => {
      if (article.image_url) void Image.prefetch(article.image_url);
    });

    digestCompletionOpacity.value = 0;
    digestCompletionScale.value = 0.95;
    digestCompletionTranslateY.value = 12;
    digestCompletionOpacity.value = withTiming(1, { duration: 220 });
    digestCompletionScale.value = withSequence(
      withTiming(1.025, { duration: 180, easing: Easing.out(Easing.cubic) }),
      withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) }),
    );
    digestCompletionTranslateY.value = withSequence(
      withTiming(-4, { duration: 180, easing: Easing.out(Easing.cubic) }),
      withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) }),
    );
    const exitStartTimeout = setTimeout(() => {
      // The Top News deck has already been mounted behind this card. Only
      // dismiss the recap now; do not touch the underlying deck or its index.
      // That keeps a single stable story visible for the whole handoff.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        digestCompletionOpacity.value = withTiming(0, { duration: 260 });
        digestCompletionScale.value = withTiming(0.98, {
          duration: 260,
          easing: Easing.in(Easing.cubic),
        });
        digestCompletionTranslateY.value = withTiming(-6, {
          duration: 260,
          easing: Easing.in(Easing.cubic),
        });
      }));
    }, 2540);
    const handoffTimeout = setTimeout(() => {
      setIsDigestDismissed(false);
      void writeDailyDigestDismissal(false);
      setIsViewingCompletedDigest(false);
      setIsDigestCompletionVisible(false);
      setIsDigestHandoffActive(false);
    }, 2880);
    return () => {
      clearTimeout(exitStartTimeout);
      clearTimeout(handoffTimeout);
    };
  }, [
    digestCompletionOpacity,
    digestCompletionScale,
    digestCompletionTranslateY,
    isDigestCompletionVisible,
    topNewsArticles,
  ]);
  const digestCompletionAnimatedStyle = useAnimatedStyle(() => ({
    opacity: digestCompletionOpacity.value,
    transform: [
      { translateY: digestCompletionTranslateY.value },
      { scale: digestCompletionScale.value },
    ],
  }));
  const finishSwipeLeft = useCallback(() => {
    if (current) advance(current);
  }, [advance, current]);

  const finishSwipeRight = useCallback(() => {
    retreat();
  }, [retreat]);

  const handleReadArticle = useCallback((article: Article) => {
    markRead(article, 'open');
    void trackArticleOpen(articleAnalyticsContext(article));
    void completeDigestArticle(article.id);
    void openPublisherArticle(article.url).catch(() => {
      Alert.alert(
        'Article unavailable',
        'We could not open the publisher article right now.',
      );
    });
  }, [articleAnalyticsContext, completeDigestArticle, markRead]);

  const logSwipeEvent = useCallback((
    phase: 'release' | 'animation-complete',
    fromIndex: number,
    toIndex: number,
  ) => {
    if (!SWIPE_DIAGNOSTICS) return;
    console.info(`[SwipePerf] ${phase}`, {
      from: fromIndex,
      to: toIndex,
      at: Date.now(),
    });
  }, []);

  const swipeGesture = useMemo(
    () => Gesture.Pan()
      .activeOffsetX([-12, 12])
      .failOffsetY([-22, 22])
      .onBegin(() => {
        cancelAnimation(visualIndex);
      })
      .onUpdate((event) => {
        const blocked =
          (event.translationX < 0 && !canSwipeLeft) ||
          (event.translationX > 0 && !canSwipeRight);
        const translation = blocked ? event.translationX * 0.2 : event.translationX;
        visualIndex.value = index - translation / swipeExitDistance;
      })
      .onEnd((event) => {
        const distance = Math.abs(event.translationX);
        const velocityCommit = Math.abs(event.velocityX) > 380 && distance > 38;
        const shouldCommit = velocityCommit || distance > 76;
        const springConfig = {
          damping: 20,
          stiffness: 240,
          mass: 0.72,
          overshootClamping: true,
        };

        if (shouldCommit && event.translationX < 0 && canSwipeLeft) {
          const targetIndex = index + 1;
          const remaining = Math.abs(targetIndex - visualIndex.value);
          runOnJS(logSwipeEvent)('release', index, targetIndex);
          visualIndex.value = withTiming(
            targetIndex,
            {
              duration: Math.max(120, Math.round(280 * remaining)),
              easing: Easing.out(Easing.cubic),
            },
            (finished) => {
              if (finished) {
                runOnJS(logSwipeEvent)('animation-complete', index, targetIndex);
                runOnJS(finishSwipeLeft)();
              }
            },
          );
          return;
        }

        if (shouldCommit && event.translationX > 0 && canSwipeRight) {
          const targetIndex = index - 1;
          const remaining = Math.abs(targetIndex - visualIndex.value);
          runOnJS(logSwipeEvent)('release', index, targetIndex);
          visualIndex.value = withTiming(
            targetIndex,
            {
              duration: Math.max(120, Math.round(280 * remaining)),
              easing: Easing.out(Easing.cubic),
            },
            (finished) => {
              if (finished) {
                runOnJS(logSwipeEvent)('animation-complete', index, targetIndex);
                runOnJS(finishSwipeRight)();
              }
            },
          );
          return;
        }

        visualIndex.value = withSpring(index, springConfig);
      }),
    [
      canSwipeLeft,
      canSwipeRight,
      finishSwipeLeft,
      finishSwipeRight,
      index,
      logSwipeEvent,
      swipeExitDistance,
      visualIndex,
    ],
  );

  if (loading) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
        <PraxisLoadingState />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
      {/* Header */}
      <View style={[s.header, isNarrowScreen && s.headerNarrow, { borderBottomColor: c.border }]}>
        <View style={[s.headerLeft, isNarrowScreen && s.headerSideNarrow]}>
          {isGuestMode || !user ? (
            <Link href={buildHref('/login', { returnTo: '/' })} asChild>
              <TouchableOpacity style={s.signInBtn} accessibilityRole="link">
                <Text style={[s.signInText, { color: c.text }]}>Sign In</Text>
              </TouchableOpacity>
            </Link>
          ) : (
            <>
              <TouchableOpacity
                onPress={() => router.push('/profile')}
                style={s.headerBtn}
              >
                <Ionicons name="person-outline" size={20} color={c.icon} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={dailyDigestFeed?.isComplete ? handleViewCompletedDigest : undefined}
                disabled={!dailyDigestFeed?.isComplete}
                accessibilityRole={dailyDigestFeed?.isComplete ? 'button' : undefined}
                accessibilityLabel={dailyDigestFeed?.isComplete ? "View today's Daily Digest" : undefined}
                style={[s.streakPill, { backgroundColor: '#E9EDD8', borderColor: '#D9DEC5' }]}
              >
                <Ionicons name="flame-outline" size={15} color="#8DAE73" />
                <Text style={s.streakText}>
                  {/* Signed in: only the account streak, a dash while it loads.
                      The device-only count (consecutive read days) is for
                      guests; showing it first flashed a different number. */}
                  {user ? (profile ? (profile.current_streak ?? 0) : (cachedStreak ?? '–')) : localStreakCount}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <View style={s.headerCenter}>
          <Text style={[s.headerTitle, isNarrowScreen && s.headerTitleNarrow, { color: c.text }]}>Praxis</Text>
        </View>

        <View style={[s.headerRight, isNarrowScreen && s.headerSideNarrow]}>
          {isGuestMode || !user ? (
            <TouchableOpacity
              onPress={() => promptForAccount('saved')}
              style={s.headerBtn}
              accessibilityRole="button"
              accessibilityLabel="Saved Articles requires an account"
            >
              <Ionicons name="bookmark-outline" size={20} color={c.icon} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => router.push('saved' as any)}
              style={s.headerBtn}
            >
              <Ionicons name="bookmark-outline" size={20} color={c.icon} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => {
              if (isGuestMode || !user) {
                promptForAccount('search');
                return;
              }
              router.push('/search');
            }}
            style={s.headerBtn}
            accessibilityLabel={isGuestMode || !user ? 'Search requires an account' : 'Search Praxis'}
          >
            <Ionicons name="search-outline" size={20} color={c.icon} />
          </TouchableOpacity>
        </View>
      </View>

      {!isDailyDigestActive ? (
        <View style={s.topNewsRow}>
          <TouchableOpacity
            onPress={isDigestModeVisible ? handleDigestPillPress : handleToggleTopNews}
            accessibilityRole="button"
            accessibilityLabel={isDigestModeVisible ? 'Exit Daily Digest' : 'Toggle Top News'}
            testID="feed-top-news-toggle"
            style={[
              s.headerPill,
              isDigestModeVisible
                ? { backgroundColor: '#EFE7FB', borderColor: '#D5C3F3' }
                : preferences.isTopNewsActive
                  ? { backgroundColor: '#F9E6D6', borderColor: '#EDC9AE' }
                  : { backgroundColor: c.secondary, borderColor: c.border },
            ]}
          >
            <Ionicons
              name={isDigestModeVisible
                ? 'sparkles-outline'
                : preferences.isTopNewsActive
                  ? 'flame-outline'
                  : 'sparkles-outline'}
              size={13}
              color={isDigestModeVisible
                ? '#7A55B6'
                : preferences.isTopNewsActive
                  ? '#E48439'
                  : c.textMuted}
            />
            <Text
              style={[
                s.headerPillText,
                {
                  color: isDigestModeVisible
                    ? '#5F438E'
                    : preferences.isTopNewsActive
                      ? c.textSecondary
                      : c.textMuted,
                },
              ]}
            >
              {isDigestModeVisible ? 'Daily Digest' : 'Top News'}
            </Text>
          </TouchableOpacity>
          {hasIncompleteDailyDigest ? (
            <TouchableOpacity
              onPress={handleResumeDailyDigest}
              accessibilityRole="button"
              accessibilityLabel={`Resume Daily Digest, ${digestDisplayCompletedCount} of ${digestTotalCount} complete`}
              testID="feed-daily-digest-toggle"
              style={s.digestResumePill}
            >
              <Ionicons name="sparkles-outline" size={13} color="#7A55B6" />
              <Text style={s.digestResumePillText}>
                Daily Digest {digestDisplayCompletedCount}/{digestTotalCount}
                <Text style={s.digestResumePillAction}> · Resume</Text>
              </Text>
            </TouchableOpacity>
          ) : null}
        {!preferences.isTopNewsActive && hasCustomQuery ? (
          <TouchableOpacity
            onPress={handleEditQuery}
            accessibilityRole="button"
            accessibilityLabel="Edit custom query"
            testID="feed-query-pill"
            style={[s.queryPill, { backgroundColor: '#E8EFDB', borderColor: '#C8D8B0' }]}
          >
            <Ionicons name="sparkles-outline" size={13} color={c.tint} />
            <Text style={[s.queryPillText, { color: c.textSecondary }]} numberOfLines={1}>
              {getCustomQueryDisplay()}
            </Text>
            <Ionicons name="pencil-outline" size={12} color={c.textMuted} />
          </TouchableOpacity>
        ) : !preferences.isTopNewsActive ? (
          <TouchableOpacity
            onPress={handleEditQuery}
            accessibilityRole="button"
            accessibilityLabel="Customize feed"
            testID="feed-customize-pill"
            style={[s.queryPill, { backgroundColor: c.secondary, borderColor: c.border }]}
          >
            <Ionicons name="sparkles-outline" size={13} color={c.textMuted} />
            <Text style={[s.queryPillText, { color: c.textMuted }]} numberOfLines={1}>
              Customize
            </Text>
          </TouchableOpacity>
        ) : null}
        </View>
      ) : null}

      {shouldShowDigestProgress && isDailyDigestActive ? (
        <View style={[s.digestProgressCard, s.digestProgressCardWithModeGap, { borderColor: '#C8D8B0' }]}>
          <TouchableOpacity
            onPress={() => setIsDigestProgressOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel="Toggle Daily Digest progress"
            style={s.digestProgressToggle}
          >
            <Animated.View
              style={[
                s.digestProgressFill,
                digestProgressAnimatedStyle,
              ]}
            />
            <View style={s.digestProgressHeader}>
              <Ionicons name="flame-outline" size={16} color="#4C773E" />
              <Text style={s.digestProgressTitle}>
                Daily Digest {digestDisplayCompletedCount}/{digestTotalCount}
              </Text>
              <Ionicons
                name={isDigestProgressOpen ? 'chevron-up-outline' : 'chevron-down-outline'}
                size={16}
                color="#58704E"
              />
            </View>
          </TouchableOpacity>
          {isDigestProgressOpen ? (
            <Animated.View
              entering={FadeInDown.duration(180)}
              style={s.digestProgressDetails}
            >
              <Text style={s.digestProgressDetailTitle}>{digestProgressTitle}</Text>
              <Text style={s.digestProgressDetailBody}>{digestProgressBody}</Text>
              {dailyDigestFeed.isComplete ? (
                <TouchableOpacity
                  onPress={handleViewCompletedDigest}
                  accessibilityRole="button"
                  accessibilityLabel="View today's Daily Digest"
                  style={s.digestResumeButton}
                >
                  <Ionicons name="sparkles-outline" size={13} color="#5F438E" />
                  <Text style={s.digestResumeText}>View Today&apos;s Digest</Text>
                </TouchableOpacity>
              ) : !isDailyDigestActive ? (
                <TouchableOpacity
                  onPress={handleResumeDailyDigest}
                  accessibilityRole="button"
                  accessibilityLabel="Resume Daily Digest"
                  style={s.digestResumeButton}
                >
                  <Ionicons name="sparkles-outline" size={13} color="#5F438E" />
                  <Text style={s.digestResumeText}>Resume Digest</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={handleDigestPillPress}
                  accessibilityRole="button"
                  accessibilityLabel="Browse Top News instead"
                  style={s.digestTopNewsButton}
                >
                  <Ionicons name="flame-outline" size={13} color="#A86532" />
                  <Text style={s.digestTopNewsText}>Continue to Top News</Text>
                </TouchableOpacity>
              )}
            </Animated.View>
          ) : null}
        </View>
      ) : null}

      {isDigestPreparing ? (
        <PraxisLoadingState />
      ) : !current && (loading || isStreaming) ? (
        <PraxisLoadingState />
      ) : !current ? (
        <View style={s.empty}>
          <View style={[s.emptyBadge, { backgroundColor: c.secondary, borderColor: c.border }]}>
            <Ionicons name="checkmark-done-outline" size={18} color={c.tint} />
            <Text style={[s.emptyBadgeText, { color: c.textSecondary }]}>
              {isAllCaughtUp ? 'Daily brief complete' : 'Feed paused'}
            </Text>
          </View>
          <Text style={[s.emptyTitle, { color: c.text }]}>
            {isAllCaughtUp ? "You're all caught up" : 'No story is ready right now'}
          </Text>
          <Text style={[s.emptyBody, { color: c.textSecondary }]}>
            {isAllCaughtUp
              ? 'Check your topics or come back later for more.'
              : 'Try refreshing the feed while we stabilize the next batch.'}
          </Text>
          <TouchableOpacity
            style={[s.refreshBtn, { backgroundColor: c.tint }]}
            onPress={reloadFeed}
          >
            <Text style={[s.refreshBtnText, { color: c.tintForeground }]}>Refresh Feed</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={s.cardStack}>
          <Animated.View style={deckTransitionAnimatedStyle}>
            <GestureDetector gesture={swipeGesture}>
              <Animated.View
                key={isDigestModeVisible ? 'daily-digest-deck' : 'top-news-deck'}
                style={[s.deckFrame, { width: cardWidth, height: cardHeight + 14 }]}
              >
                {feedArticles
                  .slice(0, maxAvailableArticles)
                  .map((article, articleIndex) => {
                    const isActive = articleIndex === safeIndex;

                    return (
                      <DeckCard
                        key={article.id}
                        article={article}
                        articleIndex={articleIndex}
                        isActive={isActive}
                        isSaved={savedIds.has(article.id)}
                        isDigestCard={isDigestModeVisible && digestArticleIdSet.has(article.id)}
                        visualIndex={visualIndex}
                        screenWidth={screenWidth}
                        swipeExitDistance={swipeExitDistance}
                        onSaveArticle={toggleSave}
                        onShareArticle={shareArticle}
                        onReadArticle={handleReadArticle}
                        verticalReserve={digestVerticalReserve}
                      />
                    );
                  })}
              </Animated.View>
            </GestureDetector>
          </Animated.View>
          {isDigestCompletionVisible ? (
            <View pointerEvents="none" style={s.digestCompletionOverlay}>
              <Animated.View style={[s.digestCompletionCard, digestCompletionAnimatedStyle]}>
                <View style={s.digestCompletionIcon}>
                  <Ionicons name="checkmark" size={24} color="#33714A" />
                </View>
                <Text style={s.digestCompletionEyebrow}>DAILY DIGEST COMPLETE</Text>
                <Text style={s.digestCompletionTitle}>
                  You&apos;re more informed on today&apos;s major stories.
                </Text>
            <Text style={s.digestCompletionMeta}>
                  {digestCompletionSummary.storyCount} stor{digestCompletionSummary.storyCount === 1 ? 'y' : 'ies'}
                  {'  '}•{'  '}{digestCompletionSummary.sourceCount} source{digestCompletionSummary.sourceCount === 1 ? '' : 's'}
                  {'  '}•{'  '}{digestCompletionSummary.topicCount} topic{digestCompletionSummary.topicCount === 1 ? '' : 's'}
            </Text>
            <Text style={s.digestCompletionHint}>
              Tap your streak anytime to view today&apos;s Digest again.
            </Text>
            <Text style={s.digestCompletionNext}>NOW EXPLORING TOP NEWS</Text>
              </Animated.View>
            </View>
          ) : null}
        </View>
      )}

      {showLoadingMoreIndicator ? (
        <View style={[s.feedStatusPill, { backgroundColor: 'rgba(247,243,234,0.96)', borderColor: c.border }]}>
          <ActivityIndicator size="small" color={c.tint} />
          <Text style={[s.feedStatusText, { color: c.textSecondary }]}>
            Loading more articles...
          </Text>
        </View>
      ) : null}

      {showAllCaughtUpIndicator ? (
        <View style={[s.feedStatusPill, { backgroundColor: 'rgba(247,243,234,0.96)', borderColor: c.border }]}>
          <Ionicons name="checkmark-done-outline" size={16} color={c.tint} />
          <Text style={[s.feedStatusText, { color: c.textSecondary }]}>
            You're all caught up
          </Text>
        </View>
      ) : null}

      <Modal
        transparent
        visible={showGuestStreakPrompt}
        animationType="fade"
        onRequestClose={dismissGuestStreakPrompt}
      >
        <View style={s.guestPromptBackdrop}>
          <View style={s.guestPromptCard}>
            <TouchableOpacity
              style={s.guestPromptClose}
              onPress={dismissGuestStreakPrompt}
              accessibilityRole="button"
              accessibilityLabel="Keep reading"
            >
              <Ionicons name="close" size={16} color="#777168" />
            </TouchableOpacity>
            <Text style={s.guestPromptTitle}>You got more deeply informed today</Text>
            <Text style={s.guestPromptBody}>
              Nice work. Create an account or sign in to save your streak and keep building it tomorrow.
            </Text>
            <View style={s.guestPromptActions}>
              <TouchableOpacity
                style={s.guestPromptSecondary}
                onPress={dismissGuestStreakPrompt}
                accessibilityRole="button"
              >
                <Text style={s.guestPromptSecondaryText}>Keep reading</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.guestPromptPrimary}
                onPress={handleSaveGuestStreak}
                accessibilityRole="button"
              >
                <Text style={s.guestPromptPrimaryText}>Save my streak</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <StoryShareSheet
        article={shareSheetArticle ? {
          id: shareSheetArticle.id,
          title: shareSheetArticle.title,
          lede: shareSheetArticle.meta?.summary || shareSheetArticle.lede,
          url: shareSheetArticle.url,
          imageUrl: shareSheetArticle.image_url,
          publisher: shareSheetArticle.publisher,
        } : null}
        visible={Boolean(shareSheetArticle)}
      onClose={() => setShareSheetArticle(null)}
      />
      <SaveAccountPrompt
        visible={accountPrompt !== null}
        feature={accountPrompt?.feature ?? 'saved'}
        returnTo={accountPrompt?.returnTo ?? '/'}
        onClose={() => setAccountPrompt(null)}
      />
      <NotificationPermissionPrompt
        visible={notifPromptAsk !== null}
        variant={notifPromptAsk ?? 'value'}
        streakCount={profile?.current_streak ?? localStreakCount}
        onYes={() => {
          setNotifPromptAsk(null);
          // Guests register a device-owned token; sign-in claims it later.
          void askPushPermission(user?.id ?? null).then(() => {
            // Either way the system dialog has now been spent — don't re-ask.
            void recordPromptGranted();
          });
        }}
        onNotNow={() => {
          setNotifPromptAsk(null);
          void recordPromptDeclined();
        }}
      />

      {shouldShowSwipeTooltip && !sharedStory && !isDigestPreparing && feedArticles.length > 0 ? (
        <SwipeTooltip onDismiss={() => void completeOnboardingStep('onboarding_swipe_completed')} />
      ) : null}
      {shouldShowGraphBanner && !sharedStory && feedArticles.length > 0 ? (
        <GraphBanner
          swipeCount={onboardingSwipeCount}
          onDismiss={() => void completeOnboardingStep('onboarding_graph_banner_completed')}
        />
      ) : null}

    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  // Same header geometry as the Graph tab (height 88 / 76 narrow, 24pt
  // wordmark) so the top bar doesn't change size between tabs.
  header: {
    height: 88,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    borderBottomWidth: 1,
  },
  headerNarrow: { height: 76, paddingHorizontal: 10 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 92 },
  headerSideNarrow: { minWidth: 78, gap: 2 },
  headerCenter: { alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  headerTitleNarrow: { fontSize: 20 },
  headerBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  signInBtn: {
    minHeight: 38,
    justifyContent: 'center',
    paddingRight: 8,
  },
  signInText: {
    fontSize: 15,
    fontWeight: '500',
  },
  streakPill: {
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  streakText: { color: '#5F6A4F', fontSize: 14, fontWeight: '700' },
  headerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 34,
  },
  headerPillText: { fontSize: 11, fontWeight: '600', letterSpacing: 0.2, color: '#B7652F' },
  digestResumePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 34,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#DED5C7',
    backgroundColor: '#F5F0E7',
  },
  digestResumePillText: { color: '#817A70', fontSize: 10, fontWeight: '700' },
  digestResumePillAction: { color: '#6B4A9D' },
  queryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 220,
    minHeight: 34,
  },
  queryPillText: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.1,
    textTransform: 'capitalize',
  },
  headerRight: { flexDirection: 'row', gap: 8, minWidth: 92, justifyContent: 'flex-end' },
  topNewsRow: {
    position: 'relative',
    zIndex: 100,
    elevation: 100,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingTop: 14,
    paddingBottom: 4,
    paddingHorizontal: 20,
  },
  digestProgressCard: {
    position: 'relative',
    zIndex: 100,
    alignSelf: 'center',
    width: 304,
    maxWidth: '88%',
    borderWidth: 1,
    borderRadius: 18,
    backgroundColor: '#FFFEFA',
    // Let the expanded description float over the first card instead of
    // expanding this row and reflowing the deck below it.
    overflow: 'visible',
    marginTop: 6,
    marginBottom: 2,
    shadowColor: '#302D28',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 100,
  },
  digestProgressCardWithModeGap: {
    // Keep the card transition close to the ordinary Top News layout after
    // Digest completion, while leaving enough breathing room below the header.
    marginTop: 24,
  },
  digestProgressToggle: {
    minHeight: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#E9F0DF',
    borderRadius: 17,
  },
  digestProgressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  digestProgressTitle: {
    color: '#3F5739',
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
    textAlign: 'center',
  },
  digestProgressFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#B5C79C',
  },
  digestProgressDetails: {
    position: 'absolute',
    top: '100%',
    left: -1,
    right: -1,
    zIndex: 101,
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 14,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: '#C8D8B0',
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    backgroundColor: '#FFFEFA',
    shadowColor: '#302D28',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 101,
  },
  digestProgressDetailTitle: {
    color: '#302D28',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  digestProgressDetailBody: {
    color: '#777168',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 4,
  },
  digestResumeButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#F4EEFC',
    borderWidth: 1,
    borderColor: '#D5C3F3',
  },
  digestResumeText: { color: '#5F438E', fontSize: 11, fontWeight: '700' },
  digestTopNewsButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#F9EDE3',
    borderWidth: 1,
    borderColor: '#EDC9AE',
  },
  digestTopNewsText: { color: '#8A5B38', fontSize: 11, fontWeight: '700' },
  digestCompletionOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingBottom: 64,
    zIndex: 30,
  },
  digestCompletionCard: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#B8D7BE',
    borderRadius: 25,
    backgroundColor: '#FFFDF8',
    paddingHorizontal: 22,
    paddingVertical: 22,
    shadowColor: '#14532D',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.22,
    shadowRadius: 30,
    elevation: 14,
  },
  digestCompletionIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EEF8EE',
    borderWidth: 1,
    borderColor: '#9DCAAA',
    marginBottom: 12,
  },
  digestCompletionEyebrow: { color: '#33714A', fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  digestCompletionTitle: { color: '#22201C', fontSize: 17, fontWeight: '700', lineHeight: 23, textAlign: 'center', marginTop: 8 },
  digestCompletionMeta: { color: '#68635C', fontSize: 12, fontWeight: '600', textAlign: 'center', lineHeight: 18, marginTop: 8 },
  digestCompletionHint: { color: '#68635C', fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 10 },
  digestCompletionNext: { color: '#D66D20', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 14 },
  guestPromptBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(22, 20, 18, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  guestPromptCard: {
    width: '100%',
    maxWidth: 402,
    borderRadius: 16,
    backgroundColor: '#FFFDF8',
    paddingHorizontal: 22,
    paddingTop: 21,
    paddingBottom: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.28,
    shadowRadius: 36,
    elevation: 18,
  },
  guestPromptClose: { position: 'absolute', top: 14, right: 14, padding: 5 },
  guestPromptTitle: { color: '#302D28', fontSize: 16, fontWeight: '700', paddingRight: 22 },
  guestPromptBody: { color: '#777168', fontSize: 13, lineHeight: 19, marginTop: 5 },
  guestPromptActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  guestPromptSecondary: { borderWidth: 1, borderColor: '#DDD4C5', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 10 },
  guestPromptSecondaryText: { color: '#302D28', fontSize: 12, fontWeight: '600' },
  guestPromptPrimary: { borderRadius: 12, backgroundColor: '#8DAE73', paddingHorizontal: 15, paddingVertical: 10 },
  guestPromptPrimaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  badge: {
    position: 'absolute', top: -1, right: -1,
    minWidth: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  cardStack: {
    flex: 1,
    alignItems: 'center',
    // Card rides high under the digest pill, and the 7pt nudge makes the air
    // above it match the air below it — measured 27 top / 41 bottom before,
    // 34 / 34 after (Ayuka, 2026-09-16: "I want it to be even and
    // proportionally sized"). The bottom padding still reserves the
    // floating bar's footprint.
    justifyContent: 'flex-start',
    paddingTop: 17,
    paddingBottom: TAB_BAR_CLEARANCE,
    position: 'relative',
    zIndex: 0,
  },
  deckFrame: {
    position: 'relative',
    zIndex: 0,
  },
  deckCard: { position: 'absolute', top: 0, left: 0 },
  stackInner: { position: 'absolute' },
  stackPreview: {
    position: 'absolute',
    overflow: 'hidden',
    borderRadius: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 9,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  stackPreviewImage: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.98,
  },
  stackPreviewTint: {
    ...StyleSheet.absoluteFillObject,
  },
  stackPreviewGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  stackPreviewFade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(247,243,234,0.02)',
  },
  stackPreviewActionRow: {
    position: 'absolute',
    top: 16,
    right: 16,
    flexDirection: 'row',
    gap: 8,
    opacity: 0.86,
  },
  stackPreviewActionBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  stackPreviewReadPill: {
    position: 'absolute',
    right: 16,
    bottom: 22,
    height: 42,
    borderRadius: 16,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    opacity: 0.95,
  },
  stackPreviewReadText: {
    color: 'rgba(245,249,252,0.94)',
    fontSize: 13,
    fontWeight: '700',
  },
  stackPreviewContent: {
    position: 'absolute',
    left: 16,
    right: 92,
    bottom: 20,
    gap: 8,
  },
  stackPreviewMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  stackPreviewSource: {
    color: 'rgba(245,249,252,0.9)',
    fontSize: 12,
    fontWeight: '700',
  },
  stackPreviewMetaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.32)',
  },
  stackPreviewMapBadge: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(0,0,0,0.18)',
    position: 'relative',
  },
  stackPreviewMapVertical: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: '50%',
    width: 1,
    marginLeft: -0.5,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  stackPreviewMapHorizontal: {
    position: 'absolute',
    left: 3,
    right: 3,
    top: '50%',
    height: 1,
    marginTop: -0.5,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  stackPreviewMapPoint: {
    position: 'absolute',
    width: 6,
    height: 6,
    marginLeft: -3,
    marginTop: -3,
    borderRadius: 3,
    backgroundColor: '#F5F9FC',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.18)',
  },
  stackPreviewHeadline: {
    color: 'rgba(245,249,252,0.88)',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  stackPreviewBorderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
  },
  stack2: {
    position: 'absolute',
    top: 2,
    left: 14,
    zIndex: 8,
  },
  stack3: {
    position: 'absolute',
    top: 6,
    left: 26,
    zIndex: 7,
  },
  stack4: {
    position: 'absolute',
    top: 10,
    left: 36,
    zIndex: 6,
  },
  feedStatusPill: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginBottom: 12,
  },
  feedStatusText: {
    fontSize: 13,
    fontWeight: '600',
  },
  praxisLoader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 42,
    paddingBottom: 36,
  },
  praxisLoaderWordmark: {
    color: '#22201C',
    fontSize: 42,
    fontWeight: '800',
    letterSpacing: -1.5,
  },
  praxisLoaderTagline: {
    maxWidth: 270,
    marginTop: 11,
    color: '#777168',
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 22,
    textAlign: 'center',
  },
  praxisLoaderStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
  },
  praxisLoaderStatusText: {
    color: '#8DAE73',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 40 },
  emptyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 4,
  },
  emptyBadgeText: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  emptyTitle: { fontSize: 22, fontWeight: '700' },
  emptyBody: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  refreshBtn: { height: 48, borderRadius: 12, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  refreshBtnText: { fontSize: 15, fontWeight: '600' },
});
