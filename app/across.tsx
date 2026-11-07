import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from './context/AuthContext';
import { type Article } from './hooks/useFeedArticles';
import { ArticleCard } from './components/news-feed/ArticleCard';
import { StoryShareSheet } from './components/StoryShareSheet';
import { SaveAccountPrompt } from './components/SaveAccountPrompt';
import { useBadgeCelebration } from './components/BadgeCelebration';
import { fetchSharedStoryArticle } from './lib/sharedStory';
import { getPoliticalLeanLabel, getReportingTypeLabel } from './lib/mapLabels';
import {
  readSavedArticles,
  removeSavedArticle,
  toRemoteSavedArticleRow,
  upsertSavedArticle,
} from './lib/savedArticles';
import { claimDailyStreakUpdate, logArticleRead } from './lib/readingActivity';
import {
  buildArticleAnalyticsContext,
  trackArticleOpen,
  trackArticleReadComplete,
} from './lib/analytics';
import { openPublisherArticle } from './lib/openPublisherArticle';
import { supabase } from './services/supabase';

// "Across the map": one story told by the 2-3 outlets that sit farthest apart
// on the bias map (Ayuka, 2026-11-07). Opened only by the sides push
// (send-news-push, data.view === 'sides'); the cards are the feed's own
// ArticleCard, swiped one at a time, with the app's lean/type labels as tabs.
const DOTS_HEIGHT = 36;
// getArticleCardDimensions already holds back 220pt for the feed's header
// and tab bar; this screen has neither, so only the excess is reserved.
const FEED_RESERVED_HEIGHT = 220;

export default function AcrossTheMapScreen() {
  const params = useLocalSearchParams<{ ids?: string; topic?: string; summary?: string }>();
  const ids = useMemo(
    () => (params.ids ?? '')
      .split(',')
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, 3),
    [params.ids],
  );
  const { user } = useAuth();
  const { announceAwardedBadgeIds } = useBadgeCelebration();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [shareArticle, setShareArticle] = useState<Article | null>(null);
  const [showAccountPrompt, setShowAccountPrompt] = useState(false);
  const listRef = useRef<FlatList<Article>>(null);
  const queuedReadIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let live = true;
    void Promise.all(ids.map(fetchSharedStoryArticle)).then((rows) => {
      if (!live) return;
      const loaded = rows.filter((row): row is Article => Boolean(row));
      if (loaded.length < 2) {
        // Nothing to compare: fall back to the one story, or the feed.
        if (loaded[0]) {
          router.replace({ pathname: '/article/[id]', params: { id: String(loaded[0].id) } });
        } else {
          router.replace('/');
        }
        return;
      }
      setArticles(loaded);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [ids]);

  useEffect(() => {
    if (!user) return;
    void readSavedArticles(user.id).then((saved) => {
      setSavedIds(new Set(saved.map((article) => article.id)));
    });
  }, [user]);

  const analyticsContext = useCallback((article: Article) => buildArticleAnalyticsContext(
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
    { surface: 'across_map', topics: article.topics },
  ), []);

  // Same read recording as the feed's markRead(article, 'open'), so a read
  // here counts toward reads, streaks and badges exactly like one there.
  const handleRead = useCallback((article: Article) => {
    void logArticleRead(user?.id, { id: article.id, topics: article.topics, title: article.title });
    void trackArticleReadComplete({ ...analyticsContext(article), completionMethod: 'open' });
    void trackArticleOpen(analyticsContext(article));
    void openPublisherArticle(article.url).catch(() => {
      Alert.alert('Article unavailable', 'We could not open the publisher article right now.');
    });

    if (!user || queuedReadIdsRef.current.has(article.id)) return;
    queuedReadIdsRef.current.add(article.id);
    void (async () => {
      try {
        const { error } = await supabase.from('read_articles').insert({
          user_id: user.id,
          article_id: article.id,
          read_at: new Date().toISOString(),
        });
        if (error) {
          if ((error as { code?: string }).code === '23505') return;
          throw error;
        }
        const shouldUpdateStreak = await claimDailyStreakUpdate(user.id);
        await Promise.allSettled([
          supabase.rpc('increment_articles_read', { uid: user.id }),
          ...(shouldUpdateStreak ? [supabase.rpc('update_reading_streak', { uid: user.id })] : []),
        ]);
        const { data: awardResult, error: badgeError } = await supabase.functions.invoke('award-badge', { body: { userId: user.id } });
        if (badgeError) {
          console.warn('[AcrossTheMap] Failed to check badges after read', badgeError);
        } else {
          await announceAwardedBadgeIds(Array.isArray(awardResult?.awarded) ? awardResult.awarded : []);
        }
      } catch (error) {
        queuedReadIdsRef.current.delete(article.id);
        console.warn('[AcrossTheMap] Failed to mark article read', error);
      }
    })();
  }, [analyticsContext, announceAwardedBadgeIds, user]);

  // Same save/unsave as the feed's toggleSave: local copy first, then the
  // account row.
  const handleSave = useCallback(async (article: Article) => {
    if (!user) {
      setShowAccountPrompt(true);
      return;
    }
    const isSaved = savedIds.has(article.id);
    setSavedIds((current) => {
      const next = new Set(current);
      if (isSaved) next.delete(article.id);
      else next.add(article.id);
      return next;
    });

    if (isSaved) {
      await removeSavedArticle(user.id, article.id);
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
          .eq('article_id', String(article.id));
        if (error) throw error;
      } else {
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
        if (error && (error as { code?: string }).code !== '23505') throw error;
      }
    } catch (error) {
      console.warn('[AcrossTheMap] Remote bookmark sync failed; kept local bookmark state', error);
    }
  }, [savedIds, user]);

  const goTo = (index: number) => {
    setActive(index);
    listRef.current?.scrollToIndex({ index, animated: true });
  };

  const handleScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setActive(Math.round(event.nativeEvent.contentOffset.x / screenWidth));
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const verticalReserve = Math.max(
    0,
    insets.top + headerHeight + DOTS_HEIGHT + insets.bottom + 16 - FEED_RESERVED_HEIGHT,
  );
  const count = articles.length || ids.length;

  return (
    <View style={[s.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
        <View style={s.nav}>
          <TouchableOpacity onPress={goBack} style={s.backButton} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={21} color="#2B2823" />
          </TouchableOpacity>
          <Text style={s.navTitle}>Across the map</Text>
          <View style={s.backButton} />
        </View>
        <View style={s.intro}>
          <Text style={s.kicker}>{`SAME STORY · ${count} SPOTS ON THE MAP`}</Text>
          {params.topic ? <Text style={s.topic}>{params.topic}</Text> : null}
          {params.summary ? <Text style={s.summary} numberOfLines={4}>{params.summary}</Text> : null}
          {articles.length > 0 ? (
            <View style={s.tabs}>
              {articles.map((article, index) => (
                <TouchableOpacity
                  key={article.id}
                  style={[s.tab, index === active ? s.tabActive : null]}
                  onPress={() => goTo(index)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: index === active }}
                >
                  <Text style={[s.tabText, index === active ? s.tabTextActive : null]}>
                    {getPoliticalLeanLabel(article.x)}
                  </Text>
                  <Text style={[s.tabText, index === active ? s.tabTextActive : null]}>
                    {getReportingTypeLabel(article.y)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color="#8EAF72" style={s.loading} />
      ) : (
        <>
          <FlatList
            ref={listRef}
            data={articles}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(article) => String(article.id)}
            getItemLayout={(_, index) => ({ length: screenWidth, offset: screenWidth * index, index })}
            onMomentumScrollEnd={handleScrollEnd}
            renderItem={({ item, index }) => (
              <View style={[s.page, { width: screenWidth }]}>
                <ArticleCard
                  article={item}
                  isActive={index === active}
                  isSaved={savedIds.has(item.id)}
                  onSave={() => void handleSave(item)}
                  onShare={() => setShareArticle(item)}
                  onRead={() => handleRead(item)}
                  canSwipeRight={false}
                  swipeEnabled={false}
                  verticalReserve={verticalReserve}
                />
              </View>
            )}
          />
          <View style={s.dots}>
            {articles.map((article, index) => (
              <View key={article.id} style={[s.dot, index === active ? s.dotActive : null]} />
            ))}
          </View>
        </>
      )}

      <StoryShareSheet
        article={shareArticle ? {
          id: shareArticle.id,
          title: shareArticle.title,
          lede: shareArticle.meta?.summary || shareArticle.lede,
          url: shareArticle.url,
          imageUrl: shareArticle.image_url,
          publisher: shareArticle.publisher,
        } : null}
        visible={Boolean(shareArticle)}
        onClose={() => setShareArticle(null)}
      />
      <SaveAccountPrompt
        visible={showAccountPrompt}
        feature="saved"
        returnTo="/"
        onClose={() => setShowAccountPrompt(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F3EA' },
  nav: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E4DCCB',
  },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: 17, fontWeight: '700', color: '#2B2823' },
  intro: { paddingHorizontal: 22, paddingTop: 16, paddingBottom: 14 },
  kicker: { fontSize: 12, fontWeight: '700', letterSpacing: 2, color: '#8C877C' },
  topic: { marginTop: 8, fontSize: 26, fontWeight: '800', letterSpacing: -0.3, lineHeight: 31, color: '#2B2823' },
  summary: { marginTop: 8, fontSize: 15, lineHeight: 21, color: '#5C584E' },
  tabs: { flexDirection: 'row', marginTop: 16, padding: 4, borderRadius: 16, backgroundColor: '#ECE5D6' },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, paddingHorizontal: 4 },
  tabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  tabText: { fontSize: 12.5, lineHeight: 16, fontWeight: '700', color: '#8C877C', textAlign: 'center' },
  tabTextActive: { color: '#2B2823' },
  loading: { flex: 1 },
  page: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 2 },
  dots: { height: DOTS_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#CFC6B4' },
  dotActive: { backgroundColor: '#2B2823' },
});
