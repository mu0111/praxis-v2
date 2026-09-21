import { memo, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Pressable,
  ScrollView,
  useWindowDimensions,
  type GestureResponderEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { Article } from '../../hooks/useFeedArticles';
import { getSourceLogo } from '../../lib/sourceLogos';

export const getArticleCardDimensions = (
  screenWidth: number,
  screenHeight: number,
  verticalReserve = 0,
) => {
  // Keep the deck inset from the device edges — a focused story unit, not a
  // full-screen panel.
  const horizontalInset = screenWidth <= 340 ? 34 : screenWidth <= 390 ? 54 : 56;
  const maximumWidth = Math.max(screenWidth - 32, 240);
  const width = Math.min(Math.max(screenWidth - horizontalInset, 240), 378, maximumWidth);
  // The deck's TOP edge is fixed by the stack (flex-start), so height alone
  // decides how far down it reaches. Tuned to leave ~50pt of air above the
  // floating bar ON DEVICE: ~18pt of air sits above the card, so a bottom
  // margin near 40pt reads balanced — the first pass left ~85pt, which is
  // the "awkward" Ayuka spotted. NB a phone's status bar eats ~26pt the web
  // export does not have, so web previews always look airier than reality.
  const reservedHeight = screenHeight < 740 ? 300 : 220;
  const availableHeight = Math.max(screenHeight - reservedHeight - verticalReserve, 280);
  // One ratio, acting as a cap; with the bar 30pt off the bottom the ratio
  // binds in BOTH modes (digest availableHeight is 566 on an 852pt phone).
  // 1.58 = 532pt on a 337pt-wide card. Measured off Ayuka's phone twice:
  // build 126 at 1.65 put the card's bottom (755pt) on the capsule's top
  // (756), build 127 at 1.60 measured 206-748, an 8pt gap. He asked for
  // 16; 1.58 lands ~17. Never derive this number from a web export.
  const preferredRatio = 1.58;
  const height = Math.max(280, Math.min(width * preferredRatio, availableHeight));

  return { width, height };
};
const FALLBACK_CARD_BG = '#D8D1C2';
const CARD_GRADIENT_MID = 'rgba(14, 13, 13, 0.62)';
const CARD_GRADIENT_END = 'rgba(5, 5, 7, 0.99)';
const MAP_BOX_SIZE = 28;
const SWIPE_DIAGNOSTICS =
  __DEV__ && process.env.EXPO_PUBLIC_SWIPE_DIAGNOSTICS === 'true';

const clampCoord = (value?: number) => Math.max(-1, Math.min(1, value ?? 0));

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

const formatTimeAgo = (dateString: string) => {
  const date = new Date(dateString);
  const diffInHours = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60));

  if (diffInHours < 1) return 'Just now';
  if (diffInHours < 24) return `${diffInHours}h ago`;
  return `${Math.floor(diffInHours / 24)}d ago`;
};

interface Props {
  article: Article;
  isActive?: boolean;
  isSaved: boolean;
  onSave: () => void;
  onShare: () => void;
  onRead: () => void;
  onFlipChange?: (isFlipped: boolean) => void;
  canSwipeRight?: boolean;
  showSwipeHints?: boolean;
  isDigestCard?: boolean;
  verticalReserve?: number;
  swipeEnabled?: boolean;
  swipeX?: Animated.Value;
}

export const ArticleCard = memo(function ArticleCard({
  article,
  isActive = false,
  isSaved,
  onSave,
  onShare,
  onRead,
  onFlipChange,
  canSwipeRight,
  showSwipeHints,
  isDigestCard,
  verticalReserve = 0,
  swipeEnabled = false,
  swipeX: externalSwipeX,
}: Props) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { width: cardWidth, height: cardHeight } = getArticleCardDimensions(
    screenWidth,
    screenHeight,
    verticalReserve,
  );
  const isCompactCard = cardHeight < 420;
  const isVeryCompactCard = cardHeight < 340;
  const internalTranslateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const translateX = externalSwipeX ?? internalTranslateX;
  const isSwipeDrivenByParent = Boolean(externalSwipeX);
  const [isFlipped, setIsFlipped] = useState(false);
  const [openInsightId, setOpenInsightId] = useState<string | null>(null);
  const [hasImageLoadError, setHasImageLoadError] = useState(false);
  const flipAnim = useRef(new Animated.Value(0)).current;

  const rotate = translateX.interpolate({
    inputRange: [-screenWidth / 2, 0, screenWidth / 2],
    outputRange: ['-6deg', '0deg', '6deg'],
    extrapolate: 'clamp',
  });

  const leftOpacity = translateX.interpolate({
    inputRange: [-80, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const rightOpacity = translateX.interpolate({
    inputRange: [0, 80],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const showMapPoint = typeof article.x === 'number' || typeof article.y === 'number';
  const mapLeft = ((clampCoord(article.x) + 1) / 2) * MAP_BOX_SIZE;
  const mapTop = ((1 - clampCoord(article.y)) / 2) * MAP_BOX_SIZE;
  const cardImageUri = hasImageLoadError ? null : article.image_url;
  const sourceName = article.source || article.publisher?.name || 'Unknown';
  const placeholderLogo = cardImageUri ? null : getSourceLogo(sourceName);
  const updatedLabel = `Updated ${formatTimeAgo(article.ts_pub)}`;
  const backSummary = article.meta?.summary || article.lede || null;
  const insightRows = [
    article.meta?.x_explanation
      ? {
          id: 'lean',
          label: getPoliticalLeanLabel(article.x),
          text: article.meta.x_explanation,
          tone: article.x > 0.2 ? 'right' : article.x < -0.2 ? 'left' : 'neutral',
        }
      : null,
    article.meta?.y_explanation
      ? {
          id: 'style',
          label: getReportingTypeLabel(article.y),
          text: article.meta.y_explanation,
          tone: article.y > 0.2 ? 'up' : article.y < -0.2 ? 'down' : 'neutral',
        }
      : null,
  ].filter(Boolean) as Array<{
    id: string;
    label: string;
    text: string;
    tone: 'left' | 'right' | 'up' | 'down' | 'neutral';
  }>;
  const primaryInsightRows = insightRows;
  const selectedInsightRow = primaryInsightRows.find((row) => row.id === openInsightId) ?? null;

  useEffect(() => {
    setIsFlipped(false);
    setOpenInsightId(null);
    setHasImageLoadError(false);
    flipAnim.setValue(0);
  }, [article.id, flipAnim]);

  useEffect(() => {
    if (!isActive && isFlipped) {
      setIsFlipped(false);
      flipAnim.setValue(0);
    }
  }, [flipAnim, isActive, isFlipped]);

  useEffect(() => {
    onFlipChange?.(isFlipped);
  }, [isFlipped, onFlipChange]);

  const frontRotateY = flipAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  const backRotateY = flipAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['180deg', '360deg'],
  });

  const toggleFlip = () => {
    if (!isActive) return;

    const nextFlipped = !isFlipped;
    setIsFlipped(nextFlipped);
    Animated.timing(flipAnim, {
      toValue: nextFlipped ? 1 : 0,
      duration: 280,
      useNativeDriver: true,
    }).start();
  };

  const getInsightChipToneStyle = (tone: 'left' | 'right' | 'up' | 'down' | 'neutral') =>
    tone === 'left'
      ? s.backChipLeft
      : tone === 'right'
        ? s.backChipRight
        : tone === 'up'
          ? s.backChipUp
          : tone === 'down'
            ? s.backChipDown
            : null;

  const getInsightBubbleToneStyle = (tone: 'left' | 'right' | 'up' | 'down' | 'neutral') =>
    tone === 'left'
      ? s.backInsightBubbleLeft
      : tone === 'right'
        ? s.backInsightBubbleRight
        : tone === 'up'
          ? s.backInsightBubbleUp
          : tone === 'down'
            ? s.backInsightBubbleDown
            : s.backInsightBubbleNeutral;

  const stopFlipPropagation = (event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
  };

  return (
    <Animated.View
      style={[
        s.card,
        { width: cardWidth, height: cardHeight, borderRadius: isCompactCard ? 24 : 30 },
        !isSwipeDrivenByParent
          ? { transform: [{ translateX }, { translateY }, { rotate }] }
          : null,
      ]}
    >
      <Pressable
        style={s.flipShell}
        onPress={() => {
          toggleFlip();
        }}
      >
        <Animated.View
          pointerEvents={isFlipped ? 'none' : 'auto'}
          style={[
            s.face,
            {
              transform: [{ perspective: 1400 }, { rotateY: frontRotateY }],
              opacity: flipAnim.interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [1, 0, 0],
              }),
            },
          ]}
        >
          {cardImageUri ? (
            <Image
              source={{ uri: cardImageUri }}
              style={s.image}
              contentFit="cover"
              cachePolicy="memory-disk"
              onError={() => setHasImageLoadError(true)}
              onLoad={() => {
                if (SWIPE_DIAGNOSTICS) {
                  console.info('[SwipePerf] image loaded', {
                    articleId: article.id,
                    isActive,
                    at: Date.now(),
                  });
                }
              }}
            />
          ) : (
            // No picture (WSJ walls its pages; see lib/sourceLogos): plain cream
            // with the source mark, Ayuka's pick 2026-09-21 (msg 2042).
            <View style={[s.imagePlaceholder, { backgroundColor: FALLBACK_CARD_BG }]}>
              {placeholderLogo ? (
                <Image
                  source={placeholderLogo}
                  style={s.placeholderLogo}
                  contentFit="contain"
                  cachePolicy="memory"
                />
              ) : null}
            </View>
          )}

          <LinearGradient
            colors={['rgba(0,0,0,0)', CARD_GRADIENT_MID, CARD_GRADIENT_END]}
            locations={[0.04, 0.46, 1]}
            style={s.gradient}
          />
          <LinearGradient
            colors={['rgba(0,0,0,0.28)', 'rgba(0,0,0,0)']}
            locations={[0, 1]}
            style={s.topShade}
            pointerEvents="none"
          />

          {isDigestCard ? (
            <>
              <View pointerEvents="none" style={s.digestBorder} />
              <LinearGradient
                colors={['rgba(132,72,214,0.18)', 'rgba(132,72,214,0.05)', 'transparent']}
                locations={[0, 0.4, 0.8]}
                style={s.digestGlow}
                pointerEvents="none"
              />
            </>
          ) : null}

          <View style={[s.topRow, isCompactCard ? s.topRowCompact : null]}>
            {isDigestCard ? (
              <View style={s.digestBadge}>
                <Ionicons name="sparkles-outline" size={10} color="#F7F3EA" />
                <Text style={s.digestText}>DAILY DIGEST</Text>
              </View>
            ) : <View />}

            <View style={s.actionBtns}>
              <TouchableOpacity
                style={[s.actionBtn, s.actionBtnFallback, isCompactCard ? s.actionBtnCompact : null]}
                onPress={(event) => {
                  stopFlipPropagation(event);
                  onShare();
                }}
                accessibilityLabel="Share story"
                accessibilityRole="button"
              >
                <Ionicons name="share-social-outline" size={isCompactCard ? 16 : 18} color="#F5F9FC" />
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.actionBtn, s.actionBtnFallback, isCompactCard ? s.actionBtnCompact : null]}
                onPress={(event) => {
                  stopFlipPropagation(event);
                  onSave();
                }}
                accessibilityLabel={isSaved ? 'Remove bookmark' : 'Save article'}
                accessibilityRole="button"
              >
                <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={isCompactCard ? 17 : 19} color="#F5F9FC" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[s.content, isCompactCard ? s.contentCompact : null, isVeryCompactCard ? s.contentVeryCompact : null]}>
            <View style={s.metaRow}>
              <Text style={s.publisherMeta}>{sourceName}</Text>
              {showMapPoint ? (
                <>
                  <View style={s.metaDot} />
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={(event) => {
                      stopFlipPropagation(event);
                      toggleFlip();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={isFlipped ? 'Hide AI insights' : 'Show AI insights'}
                  >
                    <View style={s.smallMapBadge}>
                      <View style={s.smallMapVertical} />
                      <View style={s.smallMapHorizontal} />
                      <View style={[s.smallMapDot, { left: mapLeft, top: mapTop }]} />
                    </View>
                  </TouchableOpacity>
                </>
              ) : null}
            </View>

            {/* Front shows the headline only; the summary lives on the back of
                the card, so repeating a truncated tease here only stole
                headline lines. */}
            <Text style={[s.title, isCompactCard ? s.titleCompact : null]} numberOfLines={isVeryCompactCard ? 3 : 4}>{article.title}</Text>

            <View style={s.footerRow}>
              <Text style={[s.updatedText, isCompactCard ? s.updatedTextCompact : null]}>{updatedLabel}</Text>
              <TouchableOpacity
                style={[s.readPill, isCompactCard ? s.readPillCompact : null]}
                onPress={(event) => {
                  stopFlipPropagation(event);
                  onRead();
                }}
                accessibilityLabel="Read article"
                accessibilityRole="button"
              >
                <Text style={[s.readPillText, isCompactCard ? s.readPillTextCompact : null]}>Read</Text>
                <Ionicons name="open-outline" size={isCompactCard ? 13 : 15} color="#F5F9FC" />
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>

        <Animated.View
          pointerEvents={isFlipped ? 'auto' : 'none'}
          style={[
            s.face,
            s.backFace,
            {
              transform: [{ perspective: 1400 }, { rotateY: backRotateY }],
              opacity: flipAnim.interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [0, 0, 1],
              }),
            },
          ]}
        >
          <LinearGradient
            colors={['#0A1222', '#0C1930', '#060A11']}
            style={StyleSheet.absoluteFillObject}
          />
          <View style={s.backOverlay} />

          <View style={s.backHeader}>
            <Text style={s.backEyebrow}>AI INSIGHTS</Text>
          </View>

          <ScrollView
            style={s.backScroll}
            contentContainerStyle={s.backScrollContent}
            showsVerticalScrollIndicator={false}
          >
            {primaryInsightRows.length > 0 ? (
              <View style={s.backSection}>
                <View style={s.backChipRow}>
                  {primaryInsightRows.map((row) => (
                    <TouchableOpacity
                      key={row.id}
                      activeOpacity={0.85}
                      onPress={(event) => {
                        stopFlipPropagation(event);
                        setOpenInsightId((current) => (current === row.id ? null : row.id));
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Show ${row.label} insight`}
                      style={[
                        s.backChip,
                        getInsightChipToneStyle(row.tone),
                        selectedInsightRow?.id === row.id ? s.backChipActive : s.backChipInactive,
                      ]}
                    >
                      {row.id === 'lean' ? (
                        <Ionicons name="swap-horizontal-outline" size={12} color="#F2F7FF" />
                      ) : row.id === 'style' ? (
                        <Ionicons name="swap-vertical-outline" size={12} color="#F2F7FF" />
                      ) : null}
                      <Text style={s.backChipText}>{row.label}</Text>
                      <Ionicons
                        name={selectedInsightRow?.id === row.id ? 'chevron-up' : 'chevron-down'}
                        size={11}
                        color="rgba(242,247,255,0.75)"
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ) : null}

            {/* An open insight is a dropdown that FLOATS over the summary
                (Ayuka, 2026-09-20 msg 1935): the summary keeps its place
                underneath and nothing on the card moves. The host reserves
                height for a long insight so the bubble stays inside the
                scrollable content (absolute children add no height). */}
            {backSummary || selectedInsightRow ? (
              <View style={[s.backSection, selectedInsightRow ? s.backSummaryHost : null]}>
                {backSummary ? <Text style={s.backSummary}>{backSummary}</Text> : null}
                {selectedInsightRow ? (
                  <View
                    style={[
                      s.backInsightBubble,
                      getInsightBubbleToneStyle(selectedInsightRow.tone),
                      s.backInsightFloating,
                    ]}
                  >
                    {/* The tone tints are ~80% alpha (fine over the card, not
                        over text). Opaque card-dark base, then the tint on
                        top: same look as before, summary can't bleed through. */}
                    <View style={[StyleSheet.absoluteFillObject, s.backInsightFloatingBase]} />
                    <View
                      style={[
                        StyleSheet.absoluteFillObject,
                        s.backInsightFloatingTint,
                        getInsightBubbleToneStyle(selectedInsightRow.tone),
                      ]}
                    />
                    <View style={s.backInsightTitleRow}>
                      <View style={s.backInsightHeader}>
                        {selectedInsightRow.id === 'lean' ? (
                          <Ionicons name="swap-horizontal-outline" size={14} color="#F5F9FC" />
                        ) : selectedInsightRow.id === 'style' ? (
                          <Ionicons name="swap-vertical-outline" size={14} color="#F5F9FC" />
                        ) : null}
                        <Text style={s.backInsightTitle}>{selectedInsightRow.label}</Text>
                      </View>
                    </View>
                    <Text style={s.backBody}>{selectedInsightRow.text}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {!backSummary && insightRows.length === 0 ? (
              <View style={s.backSection}>
                <Text style={s.backBodyMuted}>No insights available for this article yet.</Text>
              </View>
            ) : null}
          </ScrollView>
        </Animated.View>
      </Pressable>

      {swipeEnabled && showSwipeHints ? (
        <>
          <Animated.View style={[s.swipeIndicator, s.swipeLeft, { opacity: leftOpacity }]}>
            <Ionicons name="chevron-back" size={18} color="#FFFFFF" />
          </Animated.View>
          {canSwipeRight ? (
            <Animated.View style={[s.swipeIndicator, s.swipeRight, { opacity: rightOpacity }]}>
              <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />
            </Animated.View>
          ) : null}
        </>
      ) : null}
    </Animated.View>
  );
});

const s = StyleSheet.create({
  card: {
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.42,
    shadowRadius: 34,
    elevation: 14,
  },
  flipShell: {
    flex: 1,
  },
  face: {
    ...StyleSheet.absoluteFillObject,
    backfaceVisibility: 'hidden',
  },
  backFace: {
    backgroundColor: '#0A1222',
  },
  image: { ...StyleSheet.absoluteFillObject },
  imagePlaceholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    // The gradient and headline own the lower third; keep the mark above them.
    paddingBottom: '28%',
  },
  placeholderLogo: { width: 92, height: 92, borderRadius: 20, opacity: 0.92 },
  gradient: { ...StyleSheet.absoluteFillObject },
  topShade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 132,
  },
  digestBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: 'rgba(162,89,255,0.48)',
    zIndex: 2,
  },
  digestGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 30,
    zIndex: 1,
  },
  topRow: {
    position: 'absolute',
    top: 16,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    zIndex: 3,
  },
  topRowCompact: { top: 12, left: 14, right: 14 },
  backOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  backHeader: {
    paddingTop: 16,
    paddingHorizontal: 20,
  },
  backEyebrow: {
    color: '#D9E7FF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  backScroll: {
    flex: 1,
    marginTop: 10,
  },
  backScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 2,
    paddingBottom: 24,
    gap: 10,
  },
  backSection: {
    gap: 6,
  },
  // Summary + floating insight share this box; the floor keeps a long
  // insight inside the scrollable content.
  backSummaryHost: {
    minHeight: 210,
  },
  backInsightFloating: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    maxWidth: '100%',
    alignSelf: 'stretch',
    overflow: 'hidden',
  },
  backInsightFloatingBase: {
    backgroundColor: '#0C1930',
    borderRadius: 30,
  },
  backInsightFloatingTint: {
    borderRadius: 30,
    borderWidth: 0,
  },
  backChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  backSectionTitle: {
    color: '#F5F9FC',
    fontSize: 13,
    fontWeight: '700',
  },
  backSummary: {
    color: 'rgba(245,249,252,0.94)',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 4,
  },
  backChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  backChipText: {
    color: '#F2F7FF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  backChipActive: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  backChipInactive: {
    opacity: 0.92,
  },
  backChipLeft: {
    backgroundColor: 'rgba(81, 154, 255, 0.18)',
  },
  backChipRight: {
    backgroundColor: 'rgba(233, 108, 120, 0.18)',
  },
  backChipUp: {
    backgroundColor: 'rgba(88, 184, 127, 0.18)',
  },
  backChipDown: {
    backgroundColor: 'rgba(240, 176, 87, 0.18)',
  },
  backBody: {
    color: 'rgba(245,249,252,0.88)',
    fontSize: 13,
    lineHeight: 22,
  },
  backInsightBubble: {
    flexDirection: 'column',
    alignItems: 'stretch',
    alignSelf: 'flex-start',
    maxWidth: '94%',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderRadius: 30,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 6,
  },
  backInsightTitleRow: {
    alignSelf: 'flex-start',
  },
  backInsightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backInsightTitle: {
    color: '#F5F9FC',
    fontSize: 15,
    fontWeight: '700',
  },
  backInsightBubbleNeutral: {
    backgroundColor: 'rgba(40, 47, 67, 0.78)',
    borderColor: 'rgba(255,255,255,0.08)',
  },
  backInsightBubbleLeft: {
    backgroundColor: 'rgba(55, 66, 94, 0.8)',
    borderColor: 'rgba(182, 215, 255, 0.12)',
  },
  backInsightBubbleRight: {
    backgroundColor: 'rgba(74, 49, 63, 0.8)',
    borderColor: 'rgba(255, 199, 205, 0.12)',
  },
  backInsightBubbleUp: {
    backgroundColor: 'rgba(39, 67, 61, 0.8)',
    borderColor: 'rgba(196, 255, 223, 0.12)',
  },
  backInsightBubbleDown: {
    backgroundColor: 'rgba(77, 63, 38, 0.82)',
    borderColor: 'rgba(255, 230, 188, 0.12)',
  },
  backBodyMuted: {
    color: 'rgba(245,249,252,0.64)',
    fontSize: 14,
    lineHeight: 22,
  },
  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  categoryDot: { width: 6, height: 6, borderRadius: 3 },
  categoryLabel: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  digestBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(162,89,255,0.5)',
    backgroundColor: 'rgba(125,76,217,0.46)',
  },
  digestText: { color: '#F7F3EA', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  actionBtns: { flexDirection: 'row', gap: 9 },
  actionBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnFallback: {
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderColor: 'rgba(255,255,255,0.38)',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 7,
  },
  actionBtnCompact: { width: 38, height: 38, borderRadius: 19 },
  content: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 22,
    paddingBottom: 24,
    paddingTop: 94,
    gap: 12,
  },
  contentCompact: { paddingHorizontal: 18, paddingBottom: 16, paddingTop: 58, gap: 8 },
  contentVeryCompact: { paddingTop: 48, gap: 6 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  publisherMeta: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 14,
    fontWeight: '700',
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  smallMapBadge: {
    width: MAP_BOX_SIZE,
    height: MAP_BOX_SIZE,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    backgroundColor: 'rgba(0,0,0,0.18)',
    position: 'relative',
  },
  smallMapVertical: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: '50%',
    width: 1,
    marginLeft: -0.5,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  smallMapHorizontal: {
    position: 'absolute',
    left: 3,
    right: 3,
    top: '50%',
    height: 1,
    marginTop: -0.5,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  smallMapDot: {
    position: 'absolute',
    width: 7,
    height: 7,
    marginLeft: -3.5,
    marginTop: -3.5,
    borderRadius: 3.5,
    backgroundColor: '#F5F9FC',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.2)',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 32,
    letterSpacing: -0.4,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  titleCompact: { fontSize: 19, lineHeight: 25, letterSpacing: -0.2 },
  footerRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  updatedText: {
    color: 'rgba(255,255,255,0.96)',
    fontSize: 13,
    fontWeight: '700',
  },
  updatedTextCompact: { fontSize: 11 },
  readPill: {
    height: 48,
    borderRadius: 18,
    paddingHorizontal: 19,
    backgroundColor: 'rgba(255,255,255,0.23)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.36)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  readPillCompact: { height: 40, borderRadius: 15, paddingHorizontal: 14, gap: 5 },
  readPillText: {
    color: '#F5F9FC',
    fontSize: 16,
    fontWeight: '700',
  },
  readPillTextCompact: { fontSize: 14 },
  swipeIndicator: {
    position: 'absolute',
    top: '40%',
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderColor: 'rgba(255,255,255,0.28)',
  },
  swipeLeft: {
    left: 20,
    transform: [{ rotate: '-8deg' }],
  },
  swipeRight: {
    right: 20,
    transform: [{ rotate: '8deg' }],
  },
});
