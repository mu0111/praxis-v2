import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  InteractionManager,
  Keyboard,
  Pressable,
  InputAccessoryView,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { router, useFocusEffect, useSegments } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import {
  searchMockArticles,
} from '../lib/mockPreviewData';
import {
  fetchTrendingTopics,
  hydrateDiscoveryCache,
  readCachedTrendingTopics,
  type TrendingTopic,
} from '../lib/discoveryData';
import {
  readSavedArticles,
  subscribeSavedArticles,
  type SavedArticleSnapshot,
} from '../lib/savedArticles';
import { useAuth } from '../context/AuthContext';
import { TAB_BAR_CLEARANCE } from '../components/GlassTabBar';
import { searchLiveArticles } from '../hooks/useFeedArticles';
import { getRecommenderConfig } from '../lib/recommenderConfig';
import { getPoliticalLeanLabel, getReportingLabel } from '../lib/leanLabels';

type LocalArticleResult = {
  type: 'article';
  id: number;
  title: string;
  publisher: string;
  lede: string;
  image_url: string | null;
  ts_pub: string;
  url: string;
  matchLabel: string;
  x: number | null;
  y: number | null;
  category: string | null;
  topics: string[];
  xExplanation: string | null;
  yExplanation: string | null;
};

const SEARCH_DEBOUNCE_MS = 140;
const SEARCH_HISTORY_STORAGE_KEY = 'praxis.searchHistory.v1';
const BROWSE_TOPICS = [
  'Politics',
  'Technology',
  'Business',
  'Science',
  'Health',
  'Sports',
  'Entertainment',
  'World News',
  'Environment',
  'Education',
];
const SEARCH_KEYBOARD_BAR_ID = 'search-keyboard-bar';

const SEARCH_COLORS = {
  background: '#F7F3EA',
  card: '#FFFDF7',
  secondary: '#EFE7D9',
  text: '#2E2A25',
  textMuted: '#817A71',
  tint: '#8DAE73',
  border: '#DED5C4',
};

const humanizeMatchLabel = (matches: string[]) => {
  if (matches.includes('topics')) return 'Topic match';
  if (matches.includes('publisher') || matches.includes('source')) return 'Source match';
  if (matches.includes('lede')) return 'Summary match';
  return 'Headline match';
};

const formatPublishedLabel = (dateString: string) => {
  const timestamp = new Date(dateString).getTime();
  if (!Number.isFinite(timestamp)) return 'Preview article';

  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

export default function SearchModal() {
  const { user } = useAuth();
  const c = SEARCH_COLORS;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocalArticleResult[]>([]);
  const [savedArticles, setSavedArticles] = useState<SavedArticleSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [browseExpanded, setBrowseExpanded] = useState(false);
  // Which result has its lean/type chips opened to show the explanation
  // (one at a time; tapping the chips of another row moves it).
  const [expandedResultId, setExpandedResultId] = useState<number | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);

  // Focus once the screen settles — autoFocus opened the keyboard
  // mid-transition (Ayuka, 2026-09-18). As a tab the screen stays mounted,
  // so focus on every visit and let the keyboard go when leaving.
  const searchInputRef = useRef<TextInput>(null);
  useFocusEffect(
    useCallback(() => {
      const task = InteractionManager.runAfterInteractions(() => {
        searchInputRef.current?.focus();
      });
      return () => {
        task.cancel();
        searchInputRef.current?.blur();
      };
    }, []),
  );
  // Opened from the top-right icon it is a tab page above the tab bar.
  const isTabPage = useSegments()[0] === '(tabs)';

  const [trendingTopics, setTrendingTopics] = useState<TrendingTopic[]>(
    () => readCachedTrendingTopics() ?? [],
  );

  useEffect(() => {
    let isActive = true;
    let unsubscribe = () => {};
    let keyboardSub: { remove: () => void } | null = null;
    let fallback: ReturnType<typeof setTimeout> | null = null;

    const hydrate = () => {
      void (async () => {
        const [storedHistory, articles] = await Promise.all([
          AsyncStorage.getItem(SEARCH_HISTORY_STORAGE_KEY),
          readSavedArticles(user?.id),
        ]);
        if (!isActive) return;

        if (storedHistory) {
          try {
            const parsed = JSON.parse(storedHistory);
            if (Array.isArray(parsed)) {
              setSearchHistory(parsed.filter((item): item is string => typeof item === 'string').slice(0, 8));
            }
          } catch {}
        }
        setSavedArticles(articles);

        unsubscribe = subscribeSavedArticles(user?.id, (nextArticles) => {
          if (isActive) setSavedArticles(nextArticles);
        });

        void hydrateDiscoveryCache()
          .then(() => fetchTrendingTopics())
          .then((topics) => {
            if (isActive) setTrendingTopics(topics.slice(0, 8));
          })
          .catch((error) => {
            console.warn('[SearchModal] Trending topics unavailable', error);
          });
      })();
    };

    // Hydrate only once the slide AND the keyboard have settled. This used
    // to fire the instant the slide ended, the same instant the keyboard
    // started rising, so the list re-rendered under a moving keyboard —
    // the "glitchy" he saw opening Search. Fallback timer covers the case
    // where the keyboard never shows (hardware keyboard, focus lost).
    const task = InteractionManager.runAfterInteractions(() => {
      const runOnce = () => {
        keyboardSub?.remove();
        keyboardSub = null;
        if (fallback) clearTimeout(fallback);
        fallback = null;
        if (isActive) hydrate();
      };
      keyboardSub = Keyboard.addListener('keyboardDidShow', runOnce);
      fallback = setTimeout(runOnce, 700);
    });

    return () => {
      isActive = false;
      task.cancel();
      keyboardSub?.remove();
      if (fallback) clearTimeout(fallback);
      unsubscribe();
    };
  }, [user?.id]);

  useEffect(() => {
    const trimmed = query.trim();
    let isActive = true;

    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const timeout = setTimeout(() => {
      void (async () => {
        let searchableMatches: LocalArticleResult[];

        try {
          const { isEnabled } = getRecommenderConfig();
          if (!isEnabled) throw new Error('Live article search is disabled');

          const liveMatches = await searchLiveArticles(trimmed, 12);
          searchableMatches = liveMatches.map((article) => ({
            type: 'article' as const,
            id: article.id,
            title: article.title,
            publisher: article.publisher?.name ?? article.source ?? 'Unknown source',
            lede: article.lede ?? '',
            image_url: article.image_url,
            ts_pub: article.ts_pub,
            url: article.url,
            matchLabel: 'Live article',
            x: article.meta?.unscored ? null : article.x,
            y: article.meta?.unscored ? null : article.y,
            category: article.category ?? null,
            topics: article.topics,
            xExplanation: article.meta?.x_explanation ?? null,
            yExplanation: article.meta?.y_explanation ?? null,
          }));
        } catch (error) {
          console.warn('[SearchModal] Live search unavailable, using preview data', error);
          searchableMatches = searchMockArticles(trimmed, 12).map((result) => ({
            type: 'article' as const,
            id: result.article.id,
            title: result.article.title,
            publisher: result.article.publisher,
            lede: result.article.lede,
            image_url: result.article.image_url,
            ts_pub: result.article.ts_pub,
            url: result.article.url,
            matchLabel: humanizeMatchLabel(result.matches),
            x: result.article.x,
            y: result.article.y,
            category: result.article.category,
            topics: result.article.topics,
            xExplanation: null,
            yExplanation: null,
          }));
        }

        const savedMatches = savedArticles
          .filter((article) => {
            const searchable = [
              article.title,
              article.lede,
              article.publisher?.name ?? '',
            ].join(' ').toLowerCase();
            return searchable.includes(trimmed.toLowerCase());
          })
          .map((article) => ({
            type: 'article' as const,
            id: article.id,
            title: article.title,
            publisher: article.publisher?.name ?? 'Saved article',
            lede: article.lede,
            image_url: article.image_url,
            ts_pub: article.ts_pub,
            url: article.url,
            matchLabel: 'Saved article',
            x: article.x,
            y: article.y,
            category: article.category,
            topics: article.topics,
            xExplanation: article.meta?.x_explanation ?? null,
            yExplanation: article.meta?.y_explanation ?? null,
          }));

        const merged = new Map<number, LocalArticleResult>();
        [...savedMatches, ...searchableMatches].forEach((article) => {
          if (!merged.has(article.id)) {
            merged.set(article.id, article);
          }
        });

        if (isActive) {
          setResults(Array.from(merged.values()));
          setLoading(false);
          setSearchHistory((previous) => {
            const next = [
              trimmed,
              ...previous.filter((item) => item.toLowerCase() !== trimmed.toLowerCase()),
            ].slice(0, 8);
            void AsyncStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
            return next;
          });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      isActive = false;
      clearTimeout(timeout);
    };
  }, [query, savedArticles]);

  const openArticle = (article: LocalArticleResult) => {
    router.push({
      pathname: '/article/[id]',
      params: {
        id: String(article.id),
        title: article.title,
        lede: article.lede,
        image_url: article.image_url ?? '',
        url: article.url,
        publisher_name: article.publisher,
        ts_pub: article.ts_pub,
        source_context: 'search',
        x: article.x == null ? '' : String(article.x),
        y: article.y == null ? '' : String(article.y),
        category: article.category ?? '',
        topics: JSON.stringify(article.topics),
        x_explanation: article.xExplanation ?? '',
        y_explanation: article.yExplanation ?? '',
      },
    });
  };

  const hasQuery = query.trim().length >= 2;
  const featuredTopic = trendingTopics[0];
  const supportingTopics = trendingTopics.slice(1);
  const removeHistoryItem = (term: string) => {
    setSearchHistory((previous) => {
      const next = previous.filter((item) => item !== term);
      void AsyncStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  return (
    <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
      <View style={[s.header, { backgroundColor: c.card, borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={s.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color={c.text} />
        </TouchableOpacity>
        <View style={[s.inputShell, { backgroundColor: c.background, borderColor: c.border }]}>
          <Ionicons name="search-outline" size={20} color={c.textMuted} />
          <TextInput
            style={[s.input, { color: c.text }]}
            placeholder="Search articles..."
            placeholderTextColor={c.textMuted}
            value={query}
            onChangeText={setQuery}
            ref={searchInputRef}
            returnKeyType="search"
            inputAccessoryViewID={SEARCH_KEYBOARD_BAR_ID}
          />
          {query.length > 0 ? (
            <TouchableOpacity onPress={() => setQuery('')} style={s.clearBtn}>
              <Ionicons name="close" size={14} color={c.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {!hasQuery ? (
        <ScrollView
          contentContainerStyle={[s.discoveryContent, isTabPage && s.tabBarClearance]}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
        >
          <LinearGradient
            colors={['#EAF2DE', '#FFFDF7', '#EDF4E5']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[s.discoveryCard, s.trendingCard, { borderColor: '#D9E6CB' }]}
          >
            <View style={s.discoveryHeading}>
              <View style={[s.discoveryIcon, { backgroundColor: '#E7F0DA' }]}>
                <Ionicons name="trending-up" size={17} color={c.tint} />
              </View>
              <View style={s.discoveryHeadingCopy}>
                <Text style={[s.discoveryTitle, { color: c.text }]}>Trending now</Text>
                <Text style={[s.discoverySubtitle, { color: c.textMuted }]}>Fast ways into the biggest story threads.</Text>
              </View>
            </View>

            {featuredTopic ? (
              <TouchableOpacity
                style={[s.featuredTrend, { backgroundColor: c.card, borderColor: '#D9E6CB' }]}
                onPress={() => setQuery(featuredTopic.name)}
              >
                <View style={[s.featuredLabel, { backgroundColor: '#E7F0DA' }]}>
                  <Ionicons name="flame" size={12} color={c.tint} />
                  <Text style={[s.featuredLabelText, { color: '#5D7650' }]}>FEATURED TREND</Text>
                </View>
                <Text style={[s.featuredTitle, { color: c.text }]}>{featuredTopic.name}</Text>
                <Text style={[s.featuredDescription, { color: c.textMuted }]}>
                  {featuredTopic.cluster_count} related clusters live right now
                </Text>
              </TouchableOpacity>
            ) : null}

            {supportingTopics.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.trendChipRow}>
                {supportingTopics.map((topic) => (
                  <TouchableOpacity key={topic.id} style={[s.trendChip, { backgroundColor: c.card, borderColor: c.border }]} onPress={() => setQuery(topic.name)}>
                    <Ionicons name="flame" size={13} color="#EF4444" />
                    <Text style={[s.trendChipText, { color: '#DC2626' }]}>{topic.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : null}
          </LinearGradient>

          <View style={[s.discoveryCard, { backgroundColor: c.card, borderColor: c.border }]}>
            <TouchableOpacity style={s.discoveryHeading} onPress={() => setBrowseExpanded((value) => !value)}>
              <View style={[s.discoveryIcon, { backgroundColor: '#E7F0DA' }]}>
                <Ionicons name="sparkles" size={16} color={c.tint} />
              </View>
              <View style={s.discoveryHeadingCopy}>
                <Text style={[s.discoveryTitle, { color: c.text }]}>Browse topics</Text>
                <Text style={[s.discoverySubtitle, { color: c.textMuted }]}>Praxis topic presets</Text>
              </View>
              <View style={s.disclosure}>
                <Text style={[s.disclosureText, { color: c.textMuted }]}>{browseExpanded ? 'HIDE' : 'SHOW'}</Text>
                <Ionicons name={browseExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={c.textMuted} />
              </View>
            </TouchableOpacity>
            {browseExpanded ? (
              <View style={s.browseGrid}>
                {BROWSE_TOPICS.map((topic) => (
                  <TouchableOpacity key={topic} style={[s.browseTopic, { backgroundColor: c.background, borderColor: c.border }]} onPress={() => setQuery(topic)}>
                    <Text style={[s.browseTopicText, { color: c.text }]}>{topic}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>

          <View style={[s.discoveryCard, { backgroundColor: c.card, borderColor: c.border }]}>
            <View style={s.discoveryHeading}>
              <View style={[s.discoveryIcon, { backgroundColor: '#E7F0DA' }]}>
                <Ionicons name="time-outline" size={17} color={c.tint} />
              </View>
              <Text style={[s.discoveryTitle, { color: c.text }]}>Recent searches</Text>
            </View>
            {searchHistory.length > 0 ? searchHistory.map((term) => (
              <View key={term} style={s.historyRow}>
                <TouchableOpacity style={s.historyQuery} onPress={() => setQuery(term)}>
                  <Ionicons name="time-outline" size={16} color={c.textMuted} />
                  <Text style={[s.historyText, { color: c.text }]} numberOfLines={1}>{term}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.historyRemove} onPress={() => removeHistoryItem(term)} accessibilityLabel={`Remove ${term} from search history`}>
                  <Ionicons name="close" size={16} color={c.textMuted} />
                </TouchableOpacity>
              </View>
            )) : (
              <View style={[s.historyEmpty, { backgroundColor: c.background, borderColor: c.border }]}>
                <Text style={[s.helperText, { color: c.textMuted }]}>Your recent searches will show up here.</Text>
              </View>
            )}
          </View>
        </ScrollView>
      ) : null}

      {loading ? (
        <ActivityIndicator color={c.tint} style={{ marginTop: 28 }} />
      ) : null}

      {!loading && hasQuery && results.length === 0 ? (
        <View style={s.emptyState}>
          <View style={[s.emptyIcon, { backgroundColor: c.secondary }]}>
            <Ionicons name="search-outline" size={28} color={c.textMuted} />
          </View>
          <Text style={[s.emptyTitle, { color: c.text }]}>No article results found</Text>
          <Text style={[s.helperText, { color: c.textMuted }]}>
            Try a broader topic or one of the trending ideas above.
          </Text>
        </View>
      ) : null}

      {!loading && hasQuery ? (
        <FlatList
          data={results}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          contentContainerStyle={[s.list, isTabPage && s.tabBarClearance]}
          keyboardDismissMode="on-drag"
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[s.resultRow, { backgroundColor: c.card, borderColor: c.border }]}
              onPress={() => openArticle(item)}
            >
              <View style={s.resultCopy}>
                {(getPoliticalLeanLabel(item.x) || getReportingLabel(item.y)) ? (
                  // The chips open to the same lean/type explanations the
                  // article page shows, without leaving the list (Ayuka,
                  // 2026-09-18). Tapping anywhere else on the row still
                  // opens the article.
                  <Pressable
                    style={s.resultTags}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={expandedResultId === item.id ? 'Hide lean and type details' : 'Show lean and type details'}
                    onPress={() => setExpandedResultId((current) => (current === item.id ? null : item.id))}
                  >
                    {getPoliticalLeanLabel(item.x) ? <View style={[s.resultTag, { backgroundColor: '#E7EDF9' }]}><Text style={[s.resultTagText, { color: '#4668A7' }]}>{getPoliticalLeanLabel(item.x)}</Text></View> : null}
                    {getReportingLabel(item.y) ? <View style={[s.resultTag, { backgroundColor: '#E7F0DA' }]}><Text style={[s.resultTagText, { color: '#5D7650' }]}>{getReportingLabel(item.y)}</Text></View> : null}
                    {(item.xExplanation || item.yExplanation) ? (
                      <Ionicons
                        name={expandedResultId === item.id ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={c.textMuted}
                      />
                    ) : null}
                  </Pressable>
                ) : null}
                {expandedResultId === item.id && (item.xExplanation || item.yExplanation) ? (
                  <View style={s.resultExplanations}>
                    {item.xExplanation ? (
                      <Text style={[s.resultExplanation, { color: c.textMuted }]}>
                        <Text style={{ color: '#4668A7', fontWeight: '700' }}>{getPoliticalLeanLabel(item.x)}: </Text>
                        {item.xExplanation}
                      </Text>
                    ) : null}
                    {item.yExplanation ? (
                      <Text style={[s.resultExplanation, { color: c.textMuted }]}>
                        <Text style={{ color: '#5D7650', fontWeight: '700' }}>{getReportingLabel(item.y)}: </Text>
                        {item.yExplanation}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                <Text style={[s.resultTitle, { color: c.text }]} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={[s.resultLede, { color: c.textMuted }]} numberOfLines={2}>
                  {item.lede}
                </Text>
                <View style={s.resultFooter}>
                  <Text style={[s.resultPublisher, { color: c.textMuted }]} numberOfLines={1}>{item.publisher}</Text>
                  <View style={s.resultReadTime}><Ionicons name="time-outline" size={13} color={c.textMuted} /><Text style={[s.resultDate, { color: c.textMuted }]}>{formatPublishedLabel(item.ts_pub)}</Text></View>
                </View>
              </View>
              {item.image_url ? <Image source={{ uri: item.image_url }} style={s.thumb} contentFit="cover" cachePolicy="memory-disk" /> : null}
            </TouchableOpacity>
          )}
        />
      ) : null}
      {Platform.OS === 'ios' ? (
        // "Hide" pill riding on top of the keyboard: drops it, keeps the text
        // (Ayuka's option 2, 2026-09-26). Dragging a list drops it too.
        <InputAccessoryView nativeID={SEARCH_KEYBOARD_BAR_ID}>
          <View style={[s.keyboardBar, { borderTopColor: c.border }]}>
            <TouchableOpacity
              onPress={() => Keyboard.dismiss()}
              style={[s.hideKeyboardPill, { backgroundColor: c.card, borderColor: c.border }]}
              accessibilityRole="button"
              accessibilityLabel="Hide keyboard"
            >
              <Ionicons name="chevron-down" size={16} color={c.text} />
              <Text style={[s.hideKeyboardText, { color: c.text }]}>Hide</Text>
            </TouchableOpacity>
          </View>
        </InputAccessoryView>
      ) : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
    borderBottomWidth: 1,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputShell: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
  },
  clearBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#F2F0EC',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  hideKeyboardPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    borderWidth: 1,
  },
  hideKeyboardText: {
    fontSize: 14,
    fontWeight: '500',
  },
  tabBarClearance: {
    paddingBottom: TAB_BAR_CLEARANCE,
  },
  discoveryContent: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 14,
  },
  discoveryCard: {
    borderWidth: 1,
    borderRadius: 28,
    padding: 20,
    gap: 16,
  },
  trendingCard: {},
  discoveryHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  discoveryIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discoveryHeadingCopy: {
    flex: 1,
    gap: 1,
  },
  discoveryTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  discoverySubtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  featuredTrend: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 16,
    gap: 8,
  },
  featuredLabel: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  featuredLabelText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  featuredTitle: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '700',
  },
  featuredDescription: {
    fontSize: 13,
    lineHeight: 19,
  },
  trendChipRow: {
    gap: 8,
    paddingRight: 12,
  },
  trendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  trendChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  disclosureText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  browseGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  browseTopic: {
    width: '48.5%',
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  browseTopicText: {
    fontSize: 14,
    fontWeight: '600',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 42,
  },
  historyQuery: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  historyText: {
    flex: 1,
    fontSize: 14,
  },
  historyRemove: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyEmpty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  topicWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  topicChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  topicText: {
    fontSize: 13,
    fontWeight: '500',
  },
  savedRow: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  savedCopy: {
    flex: 1,
    gap: 3,
  },
  savedTitle: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  savedMeta: {
    fontSize: 12,
  },
  helperText: {
    fontSize: 13,
    lineHeight: 20,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 42,
    paddingHorizontal: 28,
    gap: 8,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 10,
  },
  resultRow: {
    flexDirection: 'row',
    gap: 12,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    alignItems: 'flex-start',
  },
  thumb: {
    width: 76,
    height: 76,
    borderRadius: 12,
  },
  thumbFallback: {
    width: 76,
    height: 76,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultCopy: {
    flex: 1,
    gap: 8,
  },
  resultExplanations: {
    marginTop: 2,
    marginBottom: 8,
    gap: 6,
  },
  resultExplanation: {
    fontSize: 13,
    lineHeight: 18,
  },
  resultTags: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  resultTag: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  resultTagText: {
    fontSize: 10,
    fontWeight: '700',
  },
  resultPublisher: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  resultTitle: {
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
  },
  resultLede: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  resultFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  resultReadTime: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  resultDate: {
    fontSize: 11,
  },
});
