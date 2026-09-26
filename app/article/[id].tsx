import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { MOCK_PREVIEW_ARTICLES } from '../lib/mockPreviewData';
import {
  readSavedArticles,
  removeSavedArticle,
  subscribeSavedArticles,
  upsertSavedArticle,
} from '../lib/savedArticles';
import { openPublisherArticle as openPublisherArticleInApp } from '../lib/openPublisherArticle';
import { StoryShareSheet } from '../components/StoryShareSheet';
import { SaveAccountPrompt } from '../components/SaveAccountPrompt';
import { getRecommenderConfig, getRecommenderHeaders } from '../lib/recommenderConfig';

type PreviewParams = {
  id: string;
  title?: string;
  lede?: string;
  image_url?: string;
  url?: string;
  publisher_name?: string;
  ts_pub?: string;
  source_context?: string;
  x?: string;
  y?: string;
  category?: string;
  topics?: string;
  x_explanation?: string;
  y_explanation?: string;
};

const COLORS = {
  background: '#F7F3EA',
  card: '#FFFDFC',
  surface: '#EFE7D9',
  text: '#2E2A25',
  textSecondary: '#625A51',
  textMuted: '#8B8278',
  border: '#E4DAC8',
  green: '#8DAE73',
  blue: '#6F89B8',
  orange: '#D9802E',
};

const parseCoordinate = (value?: string, fallback?: number) => {
  const parsed = value?.trim() ? Number(value) : Number.NaN;
  const coordinate = Number.isFinite(parsed) ? parsed : fallback;
  if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) return 0;
  return Math.max(-1, Math.min(1, Math.abs(coordinate) > 1 ? coordinate / 100 : coordinate));
};

const parseTopics = (value?: string, fallback: string[] = []) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
      : fallback;
  } catch {
    return fallback;
  }
};

const getPoliticalLeanLabel = (value: number) => {
  if (value <= -0.6) return 'Left';
  if (value <= -0.2) return 'Center Left';
  if (value < 0.2) return 'Center';
  if (value < 0.6) return 'Center Right';
  return 'Right';
};

const getReportingTypeLabel = (value: number) => {
  if (value <= -0.45) return 'Opinion';
  if (value < 0.2) return 'Analysis';
  return 'Hard News';
};

export default function ArticlePreviewScreen() {
  const params = useLocalSearchParams<PreviewParams>();
  const { user } = useAuth();
  const articleId = Number(params.id);
  const mockArticle = MOCK_PREVIEW_ARTICLES.find((article) => article.id === articleId);
  const [sharedStory, setSharedStory] = useState<{
    title: string;
    lede: string | null;
    image_url: string | null;
    url: string;
    ts_pub: string;
    publisher: string | null;
    x: number;
    y: number;
    topics: string[];
    category: string | null;
    meta: Record<string, string> | null;
  } | null>(null);
  const [isHydratingSharedStory, setIsHydratingSharedStory] = useState(false);
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  const [showSaveAccountPrompt, setShowSaveAccountPrompt] = useState(false);

  useEffect(() => {
    if (!Number.isFinite(articleId) || params.title || mockArticle) return;
    const { apiBaseUrl, isEnabled } = getRecommenderConfig();
    if (!isEnabled || !apiBaseUrl) return;

    let active = true;
    setIsHydratingSharedStory(true);
    void fetch(`${apiBaseUrl.replace(/\/$/, '')}/v1/articles/${articleId}`, {
      headers: getRecommenderHeaders(),
    })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!active || !payload?.article) return;
        const item = payload.article;
        setSharedStory({
          title: item.title ?? 'Untitled article',
          lede: item.lede ?? null,
          image_url: item.image_url ?? null,
          url: item.url ?? '',
          ts_pub: item.ts_pub ?? new Date().toISOString(),
          publisher: item.publisher ?? null,
          x: item.x ?? 0,
          y: item.y ?? 0,
          topics: item.meta?.topics ?? [],
          category: item.category ?? null,
          meta: item.meta ?? null,
        });
      })
      .catch((error) => console.warn('[ArticlePreview] Failed to hydrate shared story', error))
      .finally(() => { if (active) setIsHydratingSharedStory(false); });

    return () => { active = false; };
  }, [articleId, mockArticle, params.title]);
  const topics = useMemo(
    () => parseTopics(params.topics, sharedStory?.topics ?? mockArticle?.topics ?? []),
    [mockArticle?.topics, params.topics, sharedStory?.topics],
  );
  const article = useMemo(() => {
    const publisher = params.publisher_name || sharedStory?.publisher || mockArticle?.publisher || 'Publisher';
    const x = parseCoordinate(params.x, sharedStory?.x ?? mockArticle?.x);
    const y = parseCoordinate(params.y, sharedStory?.y ?? mockArticle?.y);
    const leadTopic = topics[0] || 'the central issue';
    const secondTopic = topics[1] || leadTopic;

    return {
      id: articleId,
      title: params.title || sharedStory?.title || mockArticle?.title || 'Untitled article',
      lede: params.lede || sharedStory?.lede || mockArticle?.lede || '',
      imageUrl: params.image_url || sharedStory?.image_url || mockArticle?.image_url || null,
      url: params.url || sharedStory?.url || mockArticle?.url || '',
      publishedAt: params.ts_pub || sharedStory?.ts_pub || mockArticle?.ts_pub || new Date().toISOString(),
      publisher,
      category: params.category || sharedStory?.category || mockArticle?.category || null,
      topics,
      x,
      y,
      politicalLean: getPoliticalLeanLabel(x),
      reportingType: getReportingTypeLabel(y),
      leanExplanation:
        params.x_explanation ||
        `${publisher} approaches ${leadTopic.toLowerCase()} from a ${getPoliticalLeanLabel(x).toLowerCase()} vantage point, emphasizing the actors and tradeoffs it considers most important.`,
      styleExplanation:
        params.y_explanation ||
        `${publisher} presents ${secondTopic.toLowerCase()} in a ${getReportingTypeLabel(y).toLowerCase()} style, shaping how much the piece prioritizes interpretation versus direct reporting.`,
    };
  }, [
    articleId,
    mockArticle,
    sharedStory,
    params.category,
    params.image_url,
    params.lede,
    params.publisher_name,
    params.title,
    params.ts_pub,
    params.url,
    params.x,
    params.x_explanation,
    params.y,
    params.y_explanation,
    topics,
  ]);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsSaved(false);
      return;
    }

    let isActive = true;
    void readSavedArticles(user.id).then((savedArticles) => {
      if (isActive) {
        setIsSaved(savedArticles.some((savedArticle) => savedArticle.id === article.id));
      }
    });
    const unsubscribe = subscribeSavedArticles(user.id, (savedArticles) => {
      setIsSaved(savedArticles.some((savedArticle) => savedArticle.id === article.id));
    });
    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [article.id, user]);

  const toggleSave = async () => {
    if (!user) {
      setShowSaveAccountPrompt(true);
      return;
    }

    if (isSaved) {
      await removeSavedArticle(user.id, article.id);
      return;
    }
    await upsertSavedArticle(user.id, {
      id: article.id,
      title: article.title,
      lede: article.lede,
      image_url: article.imageUrl,
      url: article.url,
      ts_pub: article.publishedAt,
      publisher: { name: article.publisher, domain: '' },
      x: article.x,
      y: article.y,
      category: article.category,
      topics: article.topics,
      meta: {
        summary: article.lede,
        x_explanation: article.leanExplanation,
        y_explanation: article.styleExplanation,
      },
    });
  };

  const openPublisherArticle = () => {
    if (!article.url) {
      Alert.alert('Article unavailable', 'This preview does not include a publisher link.');
      return;
    }
    void openPublisherArticleInApp(article.url).catch(() => {
      Alert.alert('Article unavailable', 'We could not open the publisher article right now.');
    });
  };

  const publishedLabel = new Date(article.publishedAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const sourceLabel =
    params.source_context === 'saved'
      ? 'Saved in Praxis'
      : params.source_context === 'search'
        ? 'From search'
        : 'Praxis context';
  const framingTopics = article.topics.slice(0, 2).join(' and ') || 'the article’s central claim';

  return (
    <SafeAreaView style={s.container}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconButton} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={21} color={COLORS.text} />
        </TouchableOpacity>
        <View style={s.contextPill}>
          <Ionicons
            name={params.source_context === 'saved' ? 'bookmark' : 'search-outline'}
            size={13}
            color={COLORS.textSecondary}
          />
          <Text style={s.contextText}>{sourceLabel}</Text>
        </View>
        <View style={s.topActions}>
          <TouchableOpacity
            onPress={() => setShareSheetOpen(true)}
            style={s.iconButton}
            accessibilityLabel="Share article"
          >
            <Ionicons name="share-social-outline" size={20} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void toggleSave()} style={s.iconButton} accessibilityLabel="Save article">
            <Ionicons
              name={isSaved ? 'bookmark' : 'bookmark-outline'}
              size={20}
              color={isSaved ? COLORS.orange : COLORS.text}
            />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {isHydratingSharedStory ? <ActivityIndicator color={COLORS.green} style={s.sharedStoryLoader} /> : null}
        {article.imageUrl ? (
          <Image source={{ uri: article.imageUrl }} style={s.heroImage} contentFit="cover" cachePolicy="memory-disk" />
        ) : (
          <View style={s.heroFallback}>
            <Ionicons name="newspaper-outline" size={34} color={COLORS.textMuted} />
          </View>
        )}

        <View style={s.articleCopy}>
          <View style={s.publisherRow}>
            <Text style={s.publisher}>{article.publisher}</Text>
            <View style={s.dot} />
            <Text style={s.date}>{publishedLabel}</Text>
          </View>
          <Text style={s.title}>{article.title}</Text>
          {article.lede ? <Text style={s.lede}>{article.lede}</Text> : null}
        </View>

        <View style={s.lensCard}>
          <View style={s.lensHeader}>
            <View style={s.lensIcon}>
              <Ionicons name="eye-outline" size={17} color={COLORS.green} />
            </View>
            <View style={s.lensHeaderCopy}>
              <Text style={s.eyebrow}>PRAXIS CONTEXT</Text>
              <Text style={s.lensTitle}>Know what shapes the story</Text>
              <Text style={s.lensSubtitle}>
                Perspective, reporting style, and framing signals to carry into the full article.
              </Text>
            </View>
          </View>

          <View style={s.positionRow}>
            <View style={[s.positionPill, s.leanPill]}>
              <Ionicons name="swap-horizontal-outline" size={15} color={COLORS.blue} />
              <Text style={s.positionLabel}>Political lean</Text>
              <Text style={s.positionValue}>{article.politicalLean}</Text>
            </View>
            <View style={[s.positionPill, s.stylePill]}>
              <Ionicons name="swap-vertical-outline" size={15} color={COLORS.green} />
              <Text style={s.positionLabel}>Article type</Text>
              <Text style={s.positionValue}>{article.reportingType}</Text>
            </View>
          </View>

          <Text style={s.insightsEyebrow}>WHAT TO NOTICE</Text>

          <View style={s.insightRow}>
            <View style={[s.insightIcon, s.perspectiveIcon]}>
              <Ionicons name="compass-outline" size={16} color={COLORS.blue} />
            </View>
            <View style={s.insightCopy}>
              <Text style={s.insightTitle}>Perspective</Text>
              <Text style={s.insightBody}>{article.leanExplanation}</Text>
            </View>
          </View>

          <View style={s.insightRow}>
            <View style={[s.insightIcon, s.reportingIcon]}>
              <Ionicons name="reader-outline" size={16} color={COLORS.green} />
            </View>
            <View style={s.insightCopy}>
              <Text style={s.insightTitle}>Reporting approach</Text>
              <Text style={s.insightBody}>{article.styleExplanation}</Text>
            </View>
          </View>

          <View style={s.insightRow}>
            <View style={[s.insightIcon, s.framingIcon]}>
              <Ionicons name="scan-outline" size={16} color={COLORS.orange} />
            </View>
            <View style={s.insightCopy}>
              <Text style={s.insightTitle}>Framing</Text>
              <Text style={s.insightBody}>
                The coverage frames the story primarily through {framingTopics.toLowerCase()}, guiding attention toward those themes before the broader context.
              </Text>
            </View>
          </View>
        </View>

        {article.topics.length > 0 ? (
          <View style={s.topicSection}>
            <Text style={s.topicHeading}>Topics in this story</Text>
            <View style={s.topicRow}>
              {article.topics.slice(0, 5).map((topic) => (
                <View key={topic} style={s.topicChip}>
                  <Text style={s.topicText}>{topic}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <Text style={s.disclaimer}>
          Praxis adds reading context, not a verdict. Open the original article for the publisher’s complete reporting.
        </Text>
      </ScrollView>
      <StoryShareSheet
        article={{
          id: article.id,
          title: article.title,
          lede: article.lede,
          url: article.url,
          imageUrl: article.imageUrl,
          publisher: { name: article.publisher },
        }}
        visible={shareSheetOpen}
        onClose={() => setShareSheetOpen(false)}
      />
      <SaveAccountPrompt
        visible={showSaveAccountPrompt}
        returnTo={`/article/${article.id}`}
        onClose={() => setShowSaveAccountPrompt(false)}
      />

      <View style={s.bottomBar}>
        <Text style={s.bottomBarLabel}>Continue with the full reporting</Text>
        <TouchableOpacity style={s.readButton} onPress={openPublisherArticle} activeOpacity={0.88}>
          <Text style={s.readButtonText}>Read Original Article</Text>
          <Ionicons name="open-outline" size={18} color="#FFFDF8" />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  topBar: {
    minHeight: 58,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  topActions: { flexDirection: 'row', gap: 8 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  contextPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    backgroundColor: COLORS.surface,
  },
  contextText: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  content: { padding: 18, paddingBottom: 30, gap: 21 },
  sharedStoryLoader: { marginTop: 8 },
  heroImage: { width: '100%', aspectRatio: 1.58, borderRadius: 22, backgroundColor: COLORS.surface },
  heroFallback: {
    width: '100%',
    aspectRatio: 1.58,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
  },
  articleCopy: { gap: 10 },
  publisherRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  publisher: { fontSize: 12, fontWeight: '800', color: COLORS.orange, textTransform: 'uppercase', letterSpacing: 0.7 },
  dot: { width: 3, height: 3, borderRadius: 2, backgroundColor: COLORS.textMuted },
  date: { fontSize: 12, color: COLORS.textMuted },
  title: { fontSize: 28, lineHeight: 34, letterSpacing: -0.75, fontWeight: '800', color: COLORS.text },
  lede: { fontSize: 16, lineHeight: 24, color: COLORS.textSecondary },
  lensCard: {
    borderRadius: 22,
    padding: 17,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 15,
    shadowColor: '#2E2A25',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 2,
  },
  lensHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  lensHeaderCopy: { flex: 1, gap: 3 },
  lensIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EAF1E4',
  },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.4, color: COLORS.green },
  lensTitle: { fontSize: 18, lineHeight: 23, fontWeight: '800', color: COLORS.text, letterSpacing: -0.3 },
  lensSubtitle: { fontSize: 12.5, lineHeight: 18, color: COLORS.textMuted },
  positionRow: { flexDirection: 'row', gap: 9 },
  positionPill: { flex: 1, borderRadius: 16, padding: 12, gap: 4, borderWidth: 1 },
  leanPill: { backgroundColor: '#EEF2F8', borderColor: '#D8E0EE' },
  stylePill: { backgroundColor: '#EDF3E8', borderColor: '#D7E4CE' },
  positionLabel: { fontSize: 10, fontWeight: '700', color: COLORS.textMuted, textTransform: 'uppercase' },
  positionValue: { fontSize: 15, fontWeight: '800', color: COLORS.text },
  insightsEyebrow: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.25,
    color: COLORS.textMuted,
    marginTop: 1,
  },
  insightRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    paddingTop: 1,
  },
  insightIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  perspectiveIcon: { backgroundColor: '#EEF2F8' },
  reportingIcon: { backgroundColor: '#EDF3E8' },
  framingIcon: { backgroundColor: '#F8EEE4' },
  insightCopy: { flex: 1, gap: 4 },
  insightTitle: { fontSize: 13.5, fontWeight: '800', color: COLORS.text },
  insightBody: { fontSize: 13.5, lineHeight: 20.5, color: COLORS.textSecondary },
  topicSection: { gap: 10 },
  topicHeading: { fontSize: 14, fontWeight: '800', color: COLORS.text },
  topicRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  topicChip: {
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  topicText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  disclaimer: { fontSize: 11, lineHeight: 17, textAlign: 'center', color: COLORS.textMuted, paddingHorizontal: 14 },
  bottomBar: {
    paddingHorizontal: 18,
    paddingTop: 9,
    paddingBottom: 12,
    backgroundColor: COLORS.background,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: 7,
  },
  bottomBarLabel: { fontSize: 11, fontWeight: '700', textAlign: 'center', color: COLORS.textMuted },
  readButton: {
    minHeight: 54,
    borderRadius: 18,
    backgroundColor: COLORS.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  readButtonText: { color: '#FFFDF8', fontSize: 16, fontWeight: '800' },
});
