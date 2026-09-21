import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, TextInput, ScrollView, Pressable, Alert, ActivityIndicator, Image as RNImage, Platform, Keyboard, InputAccessoryView, useWindowDimensions, ViewStyle, InteractionManager } from 'react-native';
import Svg, { Circle, Image as SvgImage, Line, Text as SvgText } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { Link, router, useFocusEffect } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useOnboarding } from '../hooks/useOnboarding';
import { GraphOnboarding, type SpotlightRect } from '../components/onboarding/GraphOnboarding';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readCachedStreak, writeCachedStreak } from '../lib/streakCache';
import { useNewsPreferences } from '../context/NewsPreferencesContext';
import {
  ActiveQueryState,
  DEFAULT_GRAPH_POSITION,
  DEFAULT_GRAPH_RADIUS,
  DigestPreset,
  GraphPoint,
  isDefaultGraphSelection,
  readDigestPresets,
  readActiveQuery,
  readRecommendationRequest,
  readTopNewsGraphFilter,
  RecommendationRequestState,
  TopNewsGraphFilterState,
  writeDigestPresets,
} from '../lib/newsPreferences';
import {
  fetchTopics,
  fetchTrendingTopics,
  hydrateDiscoveryCache,
  readCachedTopics,
  readCachedTrendingTopics,
} from '../lib/discoveryData';
import {
  readReadingActivitySummary,
  subscribeReadingActivity,
} from '../lib/readingActivity';
import {
  getMockTopicArticles,
  SAFE_MODE_TOPIC_NAMES,
  SAFE_MODE_TRENDING_TOPIC_NAMES,
} from '../lib/mockPreviewData';
import { buildHref } from '../lib/buildHref';
import { getRecommenderConfig } from '../lib/recommenderConfig';
import { requestDailyDigestExit, writeDailyDigestOpenRequest } from '../lib/dailyDigest';
import { searchGraphArticles } from '../hooks/useFeedArticles';

const logoAp = require('../../assets/logos/ap.png');
const logoAtlantic = require('../../assets/logos/atlantic.png');
const logoBbc = require('../../assets/logos/bbc.png');
const logoBreitbart = require('../../assets/logos/breitbart.png');
const logoCnn = require('../../assets/logos/cnn.png');
const logoFox = require('../../assets/logos/fox.png');
const logoMsnbc = require('../../assets/logos/msnbc.png');
const logoNr = require('../../assets/logos/nr.png');
const logoNyt = require('../../assets/logos/nyt.png');
const logoPolitico = require('../../assets/logos/politico.png');
const logoReuters = require('../../assets/logos/reuters.png');
const logoVox = require('../../assets/logos/vox.png');
const logoWsj = require('../../assets/logos/wsj.png');
const logoUri = (module: number | string | { uri?: string } | undefined) => {
  if (!module) return '';
  if (typeof module === 'string') return module;
  if (typeof module === 'object' && typeof module.uri === 'string') return module.uri;
  if (typeof RNImage.resolveAssetSource === 'function') {
    return RNImage.resolveAssetSource(module as number)?.uri ?? '';
  }
  return '';
};

const GRAPH_MIN_SIZE = 220;
const GRAPH_MAX_SIZE = 540;
const FALLBACK_GRAPH_SIZE = 320;
const SEARCH_INPUT_ACCESSORY_ID = 'graph-search-dismiss';
const MAX_TOPIC_SUGGESTIONS = 12;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const PAGE = {
  background: '#F7F3EA',
  border: '#E7DEC9',
  text: '#2E2A25',
  textMuted: '#8A847C',
  textSoft: '#AAA39A',
  green: '#8DAE73',
  greenSoft: '#E8EFDB',
  orangeSoft: '#F9E6D6',
  chipBorder: '#DDD4C5',
  sliderTrack: '#E5DED4',
};

const FALLBACK_TOPICS = SAFE_MODE_TOPIC_NAMES;
const FALLBACK_TRENDING_TOPICS = SAFE_MODE_TRENDING_TOPIC_NAMES;

const OUTLETS = [
  { key: 'reuters', gx: 0, gy: 76, dx: -12, dy: -2, label: 'Reuters', labelDx: -25, labelAlign: 'end', logo: logoReuters, logoWeb: logoUri(logoReuters), width: 34, height: 12, labelDy: 10, blend: true },
  { key: 'ap', gx: 6, gy: 72, dx: 10, dy: -2, label: 'AP', labelDx: 24, labelAlign: 'start', logo: logoAp, logoWeb: logoUri(logoAp), width: 30, height: 18, labelDy: 9, blend: true },
  { key: 'bbc', gx: -2, gy: 64, dx: 14, dy: 6, label: 'BBC', labelDx: -23, labelAlign: 'end', logo: logoBbc, logoWeb: logoUri(logoBbc), width: 30, height: 12, labelDy: 10, blend: true },
  { key: 'nyt', gx: -14, gy: 50, dx: -24, dy: -12, label: '', labelDx: -26, labelAlign: 'end', logo: logoNyt, logoWeb: logoUri(logoNyt), width: 42, height: 42, labelDy: 13 },
  { key: 'politico', gx: -2, gy: 44, dx: 10, dy: 10, label: 'Politico', labelDx: 23, labelAlign: 'start', logo: logoPolitico, logoWeb: logoUri(logoPolitico), width: 38, height: 10, labelDy: 10, blend: true },
  { key: 'wsj', gx: 22, gy: 42, dx: 10, dy: -6, label: 'WSJ', labelDx: 23, labelAlign: 'start', logo: logoWsj, logoWeb: logoUri(logoWsj), width: 34, height: 34, labelDy: 11, blend: true },
  { key: 'cnn', gx: -18, gy: 34, dx: -6, dy: 14, label: 'CNN', labelDx: -21, labelAlign: 'end', logo: logoCnn, logoWeb: logoUri(logoCnn), width: 34, height: 18, labelDy: 10, blend: true },
  { key: 'fox', gx: 50, gy: 28, dx: 14, dy: -4, label: 'Fox News', labelDx: 23, labelAlign: 'start', logo: logoFox, logoWeb: logoUri(logoFox), width: 34, height: 34, labelDy: 10, blend: true },
  { key: 'msnbc', gx: -50, gy: 38, dx: -18, dy: -16, label: 'MSNBC', logo: logoMsnbc, logoWeb: logoUri(logoMsnbc), width: 28, height: 16, labelDy: 10, blend: true },
  { key: 'vox', gx: -50, gy: 24, dx: -14, dy: 18, label: 'Vox', logo: logoVox, logoWeb: logoUri(logoVox), width: 34, height: 22, labelDy: 11, blend: true },
  { key: 'breitbart', gx: 60, gy: -16, dx: 2, dy: -4, label: 'Breitbart', logo: logoBreitbart, logoWeb: logoUri(logoBreitbart), width: 32, height: 22, labelDy: 10, blend: true },
  { key: 'atlantic', gx: -20, gy: -36, dx: -8, dy: -4, label: 'The Atlantic', logo: logoAtlantic, logoWeb: logoUri(logoAtlantic), width: 28, height: 34, labelDy: 12, blend: true },
  { key: 'nr', gx: 46, gy: -38, dx: 10, dy: 6, label: 'National Review', logo: logoNr, logoWeb: logoUri(logoNr), width: 34, height: 16, labelDy: 10, blend: true },
];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const graphToSvg = (graphValue: number, size: number) => ((graphValue + 100) / 200) * size;

type GraphOutlet = {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  imageX: number;
  imageY: number;
  label: string;
  logo: number;
  logoWeb: string;
  inside: boolean;
};

// The ~25 logos + labels only change with the pin, the radius, the outlet
// list, or the canvas size. Before this memo every page state change (a
// search keystroke, the trending list arriving, a dropdown) re-rendered all
// of them on the JS thread: the "trending row feels laggy" and part of the
// "pinch is glitchy" reports (Ayuka, 2026-09-17/18). Axes and the two
// animated circles stay in the parent so the draw order is unchanged
// (circles under the logos).
const GraphOutletLayer = React.memo(function GraphOutletLayer({
  graphWidth,
  graphScale,
  outletsWithSelection,
  labeledOutletKeys,
}: {
  graphWidth: number;
  graphScale: number;
  outletsWithSelection: GraphOutlet[];
  labeledOutletKeys: Set<string>;
}) {
  return (
    <>
      {outletsWithSelection.map((outlet) => (
        <React.Fragment key={outlet.key}>
          <SvgImage
            x={outlet.imageX}
            y={outlet.imageY}
            width={outlet.width}
            height={outlet.height}
            href={Platform.OS === 'web' ? outlet.logoWeb : outlet.logo}
            preserveAspectRatio="xMidYMid meet"
            opacity={outlet.inside ? 1 : 0.4}
          />
          {outlet.label && labeledOutletKeys.has(outlet.key) ? (
            <SvgText
              // Centered under its own logo (the per-outlet offsets were
              // tuned for the old everyone-labeled layout and let names
              // drift onto neighboring logos), clamped into the canvas.
              x={clamp(outlet.x, 34, graphWidth - 34)}
              y={outlet.y + outlet.height / 2 + 11 * graphScale}
              textAnchor="middle"
              fill={PAGE.text}
              opacity={0.95}
              fontSize={clamp(9.5 * graphScale, 7.5, 12)}
              fontWeight="700"
            >
              {outlet.label}
            </SvgText>
          ) : null}
        </React.Fragment>
      ))}
    </>
  );
});
// Display-only spread: outlet coordinates cluster within ±76, which left the
// canvas rim empty and made the map read small. Positions and the selection
// radius scale together, so in/out membership is unchanged.
const OUTLET_SPREAD = 1.12;
// 0.36 * OUTLET_SPREAD (was 0.32): at full pinch the circle reaches ~80%
// of the map, "so that it feels nice to select the range" (Ayuka,
// 2026-09-19, msg 1499). Selection math shares this factor, so the lit
// sources always match the drawn circle.
const SELECTION_RADIUS_FACTOR = 0.4032;
const normalizeTopicId = (value: string) => value.trim().toLowerCase();
const topicToTestId = (topic: string) =>
  topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const topicIdToLabel = (topicId: string, topics: string[]) => {
  const exactTopic = topics.find((topic) => normalizeTopicId(topic) === topicId);
  if (exactTopic) return exactTopic;

  return topicId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
};
const normalizeArticleCoordinate = (value?: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (Math.abs(value) <= 1) return value;
  return clamp(value / 100, -1, 1);
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
const graphPointToCanvas = (point: GraphPoint, width: number, height: number) => ({
  x: ((point.x + 100) / 200) * width,
  y: ((100 - point.y) / 200) * height,
});
const canvasToGraphPoint = (x: number, y: number, width: number, height: number): GraphPoint => ({
  x: clamp(Math.round(((x / width) * 200) - 100), -100, 100),
  y: clamp(Math.round(100 - ((y / height) * 200)), -100, 100),
});

interface GraphPreferencesSeed {
  activeQuery: ActiveQueryState | null;
  recommendationRequest: RecommendationRequestState | null;
  topNewsGraphFilter: TopNewsGraphFilterState | null;
}

interface InitialGraphState {
  selectedTopics: string[];
  promptTerms: string[];
  hasAppliedTopNewsFilter: boolean;
  graphPosition: GraphPoint;
  radius: number;
}

interface PrefetchedQueryArticle {
  id: number;
  title: string;
  lede: string;
  image_url: string;
  url: string;
  ts_pub: string;
  x: number;
  y: number;
  publisher: {
    name: string;
    domain: string;
  } | null;
  topics: string[];
  source: string;
  category: 'business' | 'tech' | 'environment' | 'sports' | 'world';
  meta: {
    summary?: string;
    x_explanation?: string;
    y_explanation?: string;
    topics: string[];
  };
  reasons?: string[];
}

const DEFAULT_INITIAL_GRAPH_STATE: InitialGraphState = {
  selectedTopics: [],
  promptTerms: [],
  hasAppliedTopNewsFilter: false,
  graphPosition: DEFAULT_GRAPH_POSITION,
  radius: DEFAULT_GRAPH_RADIUS,
};

const buildInitialGraphState = ({
  activeQuery,
  recommendationRequest,
  topNewsGraphFilter,
}: GraphPreferencesSeed): InitialGraphState => {
  const savedQuery = activeQuery;
  const savedRecommendation = recommendationRequest;
  const savedTopNewsGraphFilter = topNewsGraphFilter;

  const selectedTopics = (savedQuery?.topics || []).map(normalizeTopicId);
  const promptTerms = savedQuery?.promptTerms || [];

  if (
    savedRecommendation &&
    typeof savedRecommendation.position?.x === 'number' &&
    typeof savedRecommendation.position?.y === 'number' &&
    typeof savedRecommendation.radius === 'number'
  ) {
    return {
      selectedTopics,
      promptTerms,
      hasAppliedTopNewsFilter: false,
      graphPosition: {
        x: Math.round(savedRecommendation.position.x * 100),
        y: Math.round(savedRecommendation.position.y * 100),
      },
      radius: Math.round(savedRecommendation.radius * 100),
    };
  }

  if (savedTopNewsGraphFilter) {
    return {
      selectedTopics,
      promptTerms,
      hasAppliedTopNewsFilter:
        selectedTopics.length === 0 && promptTerms.length === 0,
      graphPosition: savedTopNewsGraphFilter.position,
      radius: savedTopNewsGraphFilter.radius,
    };
  }

  return {
    selectedTopics,
    promptTerms,
    hasAppliedTopNewsFilter: false,
    graphPosition: DEFAULT_GRAPH_POSITION,
    radius: DEFAULT_GRAPH_RADIUS,
  };
};

const buildSafeModePrefetchedArticles = ({
  topics,
  promptTerms,
  position,
  radius,
}: {
  topics: string[];
  promptTerms: string[];
  position: GraphPoint;
  radius: number;
}): PrefetchedQueryArticle[] =>
  getMockTopicArticles(
    topics,
    [],
    {
      position,
      radius,
    },
    20,
    promptTerms,
  ).map((article) => {
    const normalizedX = normalizeArticleCoordinate(article.x);
    const normalizedY = normalizeArticleCoordinate(article.y);

    return {
      id: article.id,
      title: article.title,
      lede: article.lede,
      image_url: article.image_url,
      url: article.url,
      ts_pub: article.ts_pub,
      x: normalizedX,
      y: normalizedY,
      publisher: article.publisher
        ? {
            name: article.publisher,
            domain: '',
          }
        : null,
      topics: article.topics,
      source: article.source,
      category: article.category,
      meta: {
        summary: article.lede,
        x_explanation: `${article.source} approaches ${(article.topics[0] || 'this story').toLowerCase()} from a ${getPoliticalLeanLabel(normalizedX).toLowerCase()} vantage point, highlighting the tradeoffs and actors it sees as most important.`,
        y_explanation: `${article.source} presents ${(article.topics[1] || article.topics[0] || 'the news cycle').toLowerCase()} in a ${getReportingTypeLabel(normalizedY).toLowerCase()} style, shaping whether the piece feels more interpretive or more straight-news.`,
        topics: article.topics,
      },
      reasons: [
        `${article.publisher} coverage`,
        `${article.category} context`,
        article.topics[0] ? `${article.topics[0]} relevance` : null,
      ].filter((value): value is string => Boolean(value)),
    };
  });

export default function GraphScreen() {
  const { isGuestMode, user, profile, session } = useAuth();
  // Two-step spotlight tour (port of the web GraphOnboarding): the topics
  // control, then the graph. Targets are measured in window coordinates and
  // converted to the SafeAreaView's frame.
  const { shouldShowGraphOnboarding, markGraphVisited, completeStep: completeOnboardingStep } = useOnboarding(session);
  // Reaching the Graph tab on your own makes the feed banner pointless.
  useEffect(() => {
    void completeOnboardingStep('onboarding_graph_banner_completed');
  }, [completeOnboardingStep]);
  const onboardingRootRef = useRef<View>(null);
  const onboardingTopicsRef = useRef<View>(null);
  const onboardingGraphRef = useRef<View>(null);
  const [onboardingTopicsRect, setOnboardingTopicsRect] = useState<SpotlightRect | null>(null);
  const [onboardingGraphRect, setOnboardingGraphRect] = useState<SpotlightRect | null>(null);
  const measureOnboardingTargets = useCallback(() => {
    const root = onboardingRootRef.current;
    if (!root) return;
    root.measureInWindow((rootX, rootY) => {
      onboardingTopicsRef.current?.measureInWindow((x, y, width, height) => {
        if (width > 0 && height > 0) setOnboardingTopicsRect({ x: x - rootX, y: y - rootY, width, height });
      });
      onboardingGraphRef.current?.measureInWindow((x, y, width, height) => {
        if (width > 0 && height > 0) setOnboardingGraphRect({ x: x - rootX, y: y - rootY, width, height });
      });
    });
  }, []);
  useEffect(() => {
    if (!shouldShowGraphOnboarding) return;
    const timer = setTimeout(measureOnboardingTargets, 350);
    return () => clearTimeout(timer);
  }, [shouldShowGraphOnboarding, measureOnboardingTargets]);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isNarrowScreen = windowWidth < 350;
  const graphMinSize = windowHeight < 620 ? 184 : windowHeight < 740 ? 206 : 240;
  const {
    preferences,
    applyQueryPreferences,
    applyTopNewsPreferences,
    syncTopNewsFallbackState,
  } = useNewsPreferences();
  // A ref, not useIsFocused(): that hook re-rendered this whole screen (13
  // SVG logos on Hermes) on every tab switch just to flip a boolean the
  // blur-time effect reads. The focus effect below keeps it current.
  const isFocusedRef = useRef(false);
  const [graphViewport, setGraphViewport] = useState({ width: 0, height: 0 });
  const graphWidth = useMemo(() => {
    // Tighter margins since the readout became a two-line whisper — the
    // map is the page's hero, give it the room (Ayuka, 2026-09-14).
    const fallbackWidth = Math.min(
      Math.max(windowWidth - 24, graphMinSize),
      GRAPH_MAX_SIZE,
    );
    const viewportHeightLimit = Math.min(
      Math.max(windowHeight - 310, graphMinSize),
      GRAPH_MAX_SIZE,
    );
    const availableWidth = Math.max(graphViewport.width - 2, 0);
    // The readout line (30 margin clearing the OPINION pill + 18 text) and
    // Apply's slot (18 + 44 button), both always laid out, live inside the
    // same wrap as the canvas, so the square must leave room for them.
    const availableHeight = Math.max(
      Math.min(graphViewport.height - 110, viewportHeightLimit),
      0,
    );
    const availableSquare = Math.min(
      availableWidth || fallbackWidth,
      availableHeight || viewportHeightLimit || fallbackWidth,
    );

    return Math.min(
      Math.max(availableSquare || FALLBACK_GRAPH_SIZE, graphMinSize),
      GRAPH_MAX_SIZE,
    );
  }, [graphMinSize, graphViewport.height, graphViewport.width, windowHeight, windowWidth]);
  const graphHeight = graphWidth;
  // Denominator under the fallback size + a higher cap: logos, dot, and
  // labels render meaningfully larger on real phones, not just tablets.
  const graphScale = clamp(graphWidth / 300, 0.58, 1.35);
  const graphAxisInset = clamp(graphWidth * 0.1, 20, 34);
  const graphSizeRef = useRef({ width: graphWidth, height: graphHeight });
  const centerX = graphWidth / 2;
  const centerY = graphHeight / 2;
  const readPersistedGraphState = useCallback(
    () =>
      buildInitialGraphState({
        activeQuery: readActiveQuery(),
        recommendationRequest: readRecommendationRequest(),
        topNewsGraphFilter: readTopNewsGraphFilter(),
      }),
    [],
  );
  const [initialGraphState] = useState<InitialGraphState>(() => DEFAULT_INITIAL_GRAPH_STATE);
  const searchInputRef = useRef<TextInput | null>(null);
  const dropdownCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialPin = graphPointToCanvas(
    initialGraphState.graphPosition,
    graphWidth,
    graphHeight,
  );

  const [search, setSearch] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [selectedTopics, setSelectedTopics] = useState<string[]>(
    () => initialGraphState.selectedTopics,
  );
  const [promptTerms, setPromptTerms] = useState<string[]>(
    () => initialGraphState.promptTerms,
  );
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  // One-time discoverability whisper for pinch-to-resize (the slider is
  // gone and nobody would guess the gesture). Shows once, ever.
  const [showPinchHint, setShowPinchHint] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    AsyncStorage.getItem('praxis.pinchHint.v1')
      .then((seen) => {
        if (seen) return;
        setShowPinchHint(true);
        void AsyncStorage.setItem('praxis.pinchHint.v1', 'shown');
        hideTimer = setTimeout(() => setShowPinchHint(false), 8000);
      })
      .catch(() => {});
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showSignInDialog, setShowSignInDialog] = useState(false);
  const [digestName, setDigestName] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [localStreakCount, setLocalStreakCount] = useState(0);
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
  const [seedTopics, setSeedTopics] = useState<string[]>(FALLBACK_TOPICS);
  const [allTopics, setAllTopics] = useState<string[]>(FALLBACK_TOPICS);
  const [trendingTopics, setTrendingTopics] = useState<string[]>(FALLBACK_TRENDING_TOPICS);
  const [digests, setDigests] = useState<DigestPreset[]>([]);
  const [radius, setRadius] = useState(initialGraphState.radius / 100);
  const [hasAppliedTopNewsFilter, setHasAppliedTopNewsFilter] = useState(
    () => initialGraphState.hasAppliedTopNewsFilter,
  );
  const [pinX, setPinX] = useState(initialPin.x);
  const [pinY, setPinY] = useState(initialPin.y);
  const animatedPinX = useSharedValue(initialPin.x);
  const animatedPinY = useSharedValue(initialPin.y);
  const animatedRadius = useSharedValue(initialGraphState.radius / 100);
  const graphResetRevision = useSharedValue(0);
  const activeGraphGestureRevision = useSharedValue(0);
  const activeSliderGestureRevision = useSharedValue(0);
  const graphResetRevisionRef = useRef(0);
  const isDefaultResetLockedRef = useRef(false);
  const graphPositionRef = useRef<GraphPoint>(initialGraphState.graphPosition);
  const previousGraphSizeRef = useRef({
    width: graphWidth,
    height: graphHeight,
  });
  const currentGraphPosition = useMemo(
    () => isDefaultResetLockedRef.current
      ? { ...DEFAULT_GRAPH_POSITION }
      : canvasToGraphPoint(pinX, pinY, graphWidth, graphHeight),
    [pinX, pinY, graphWidth, graphHeight],
  );
  const [initialState, setInitialState] = useState({
    topics: initialGraphState.selectedTopics,
    promptTerms: initialGraphState.promptTerms,
    position: initialGraphState.graphPosition,
    radius: initialGraphState.radius,
  });

  useEffect(() => {
    graphSizeRef.current = { width: graphWidth, height: graphHeight };
  }, [graphHeight, graphWidth]);

  const syncGraphStateFromPreferences = useCallback(() => {
    const nextGraphState = readPersistedGraphState();
    isDefaultResetLockedRef.current = false;
    graphPositionRef.current = { ...nextGraphState.graphPosition };
    const currentGraphSize = graphSizeRef.current;
    const nextPin = graphPointToCanvas(
      nextGraphState.graphPosition,
      currentGraphSize.width,
      currentGraphSize.height,
    );

    setSelectedTopics(nextGraphState.selectedTopics);
    setPromptTerms(nextGraphState.promptTerms);
    setPinX(nextPin.x);
    setPinY(nextPin.y);
    setRadius(nextGraphState.radius / 100);
    animatedPinX.value = nextPin.x;
    animatedPinY.value = nextPin.y;
    animatedRadius.value = nextGraphState.radius / 100;
    setHasAppliedTopNewsFilter(nextGraphState.hasAppliedTopNewsFilter);
    setInitialState({
      topics: nextGraphState.selectedTopics,
      promptTerms: nextGraphState.promptTerms,
      position: nextGraphState.graphPosition,
      radius: nextGraphState.radius,
    });
    setSearch('');
    setIsDropdownOpen(false);
    setIsApplying(false);
  }, [animatedPinX, animatedPinY, animatedRadius, readPersistedGraphState]);

  // Focus used to re-sync unconditionally: nine setStates with fresh array
  // and object identities, i.e. a full re-render of this 2.7k-line screen
  // (13 SVG logos included) in the middle of the tab fade. The blur-time
  // effect below already keeps the graph current whenever preferences
  // change, so on focus there is nothing to do unless the user walked away
  // from unapplied edits — then the old reset still runs. Read through a
  // ref so the focus callback stays stable; putting live state in its deps
  // would re-run the reset on every keystroke while focused.
  const focusSyncStateRef = useRef({
    search,
    isDropdownOpen,
    isApplying,
    selectedTopics,
    promptTerms,
    radius,
    hasAppliedTopNewsFilter,
  });
  focusSyncStateRef.current = {
    search,
    isDropdownOpen,
    isApplying,
    selectedTopics,
    promptTerms,
    radius,
    hasAppliedTopNewsFilter,
  };
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      const unfocus = () => {
        isFocusedRef.current = false;
      };
      const live = focusSyncStateRef.current;
      const persisted = readPersistedGraphState();
      const position = graphPositionRef.current;
      const sameList = (a: string[], b: string[]) =>
        a.length === b.length && a.every((value, index) => value === b[index]);
      const dirty =
        live.search !== '' ||
        live.isDropdownOpen ||
        live.isApplying ||
        Math.abs(position.x - persisted.graphPosition.x) > 1e-6 ||
        Math.abs(position.y - persisted.graphPosition.y) > 1e-6 ||
        Math.abs(live.radius - persisted.radius / 100) > 1e-6 ||
        live.hasAppliedTopNewsFilter !== persisted.hasAppliedTopNewsFilter ||
        !sameList(live.selectedTopics, persisted.selectedTopics) ||
        !sameList(live.promptTerms, persisted.promptTerms);
      if (dirty) syncGraphStateFromPreferences();
      return unfocus;
    }, [readPersistedGraphState, syncGraphStateFromPreferences]),
  );

  useEffect(() => {
    if (isFocusedRef.current) {
      return;
    }

    syncGraphStateFromPreferences();
  }, [
    preferences.activeQuery,
    preferences.isTopNewsActive,
    preferences.recommendationRequest,
    preferences.requestNonce,
    preferences.topNewsGraphFilter,
    syncGraphStateFromPreferences,
  ]);

  useEffect(() => {
    if (!user?.id) {
      setDigests([]);
      return;
    }

    try {
      const normalizedDigests = readDigestPresets(user.id)
        .map((digest: any) => {
          if (
            typeof digest?.id !== 'string' ||
            typeof digest?.name !== 'string' ||
            !Array.isArray(digest?.topics) ||
            typeof digest?.radius !== 'number'
          ) {
            return null;
          }

          if (
            typeof digest?.position?.x === 'number' &&
            typeof digest?.position?.y === 'number'
          ) {
            return {
              id: digest.id,
              name: digest.name,
              topics: digest.topics
                .filter((value: unknown) => typeof value === 'string')
                .map((value: string) => normalizeTopicId(value)),
              position: digest.position,
              radius: digest.radius,
              createdAt: typeof digest?.createdAt === 'number' ? digest.createdAt : Date.now(),
            } satisfies DigestPreset;
          }

          if (
            typeof digest?.pinX === 'number' &&
            typeof digest?.pinY === 'number'
          ) {
            return {
              id: digest.id,
              name: digest.name,
              topics: digest.topics
                .filter((value: unknown) => typeof value === 'string')
                .map((value: string) => normalizeTopicId(value)),
              position: canvasToGraphPoint(digest.pinX, digest.pinY, graphWidth, graphHeight),
              radius: digest.radius,
              createdAt: typeof digest?.createdAt === 'number' ? digest.createdAt : Date.now(),
            } satisfies DigestPreset;
          }

          return null;
        })
        .filter(Boolean) as DigestPreset[];

      setDigests(normalizedDigests);
    } catch {}
  }, [graphHeight, graphWidth, user?.id]);

  const persistDigests = (nextDigests: DigestPreset[]) => {
    setDigests(nextDigests);
    if (user?.id) {
      writeDigestPresets(user.id, nextDigests);
    }
  };

  const loadTopics = useCallback(async (isActive: () => boolean) => {
    const applyTopics = async () => {
      await hydrateDiscoveryCache();
      const cachedTopics = readCachedTopics();
      const cachedTrendingTopics = readCachedTrendingTopics();

      if (isActive()) {
        if (cachedTopics?.seedTopics?.length) {
          setSeedTopics(cachedTopics.seedTopics.map((topic) => topic.name).filter(Boolean));
        }
        if (cachedTopics?.allTopics?.length) {
          setAllTopics(cachedTopics.allTopics.map((topic) => topic.name).filter(Boolean));
        }
        if (cachedTrendingTopics?.length) {
          setTrendingTopics(cachedTrendingTopics.map((topic) => topic.name).filter(Boolean));
        }
      }

      try {
        const [topicsResponse, trendingResponse] = await Promise.allSettled([
          fetchTopics(),
          fetchTrendingTopics(),
        ]);

        let nextSeedTopics: string[] = [];
        let nextAllTopics: string[] = [];
        let nextTrendingTopics: string[] = [];

        if (topicsResponse.status === 'fulfilled') {
          nextSeedTopics = topicsResponse.value.seedTopics
            .map((topic) => topic.name)
            .filter(Boolean);
          nextAllTopics = topicsResponse.value.allTopics
            .map((topic) => topic.name)
            .filter(Boolean);
        }

        if (trendingResponse.status === 'fulfilled') {
          nextTrendingTopics = trendingResponse.value
            .map((topic) => topic.name)
            .filter(Boolean);
        }

        if (isActive()) {
          setSeedTopics(
            nextSeedTopics.length
              ? nextSeedTopics
              : cachedTopics?.seedTopics?.length
                ? cachedTopics.seedTopics.map((topic) => topic.name).filter(Boolean)
                : FALLBACK_TOPICS,
          );
          setAllTopics(
            nextAllTopics.length
              ? nextAllTopics
              : cachedTopics?.allTopics?.length
                ? cachedTopics.allTopics.map((topic) => topic.name).filter(Boolean)
                : FALLBACK_TOPICS,
          );
          setTrendingTopics(
            nextTrendingTopics.length
              ? nextTrendingTopics
              : cachedTrendingTopics?.length
                ? cachedTrendingTopics.map((topic) => topic.name).filter(Boolean)
                : FALLBACK_TRENDING_TOPICS,
          );
        }
      } catch {
        if (isActive()) {
          setSeedTopics(
            cachedTopics?.seedTopics?.length
              ? cachedTopics.seedTopics.map((topic) => topic.name).filter(Boolean)
              : FALLBACK_TOPICS,
          );
          setAllTopics(
            cachedTopics?.allTopics?.length
              ? cachedTopics.allTopics.map((topic) => topic.name).filter(Boolean)
              : FALLBACK_TOPICS,
          );
          setTrendingTopics(
            cachedTrendingTopics?.length
              ? cachedTrendingTopics.map((topic) => topic.name).filter(Boolean)
              : FALLBACK_TRENDING_TOPICS,
          );
        }
      }
    };

    return applyTopics();
  }, []);

  useEffect(() => {
    let isActive = true;
    const task = InteractionManager.runAfterInteractions(() => {
      void loadTopics(() => isActive);
    });

    return () => {
      isActive = false;
      task.cancel();
    };
  }, [loadTopics]);

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

  const query = search.toLowerCase().trim();
  const visibleTopics = useMemo(() => {
    // Browsing (no query): show every seed topic — the curated list is small
    // and users expect the full set of categories in the dropdown.
    // Typing: filter the full 12k-topic catalog but keep the suggestion set
    // short, since rendering the entire catalog per keystroke lags the field.
    // Matches rank exact, then prefix, then shortest title — typing
    // "europe" must surface Europe itself, not bury it under every
    // "… in Europe" subtopic in catalog order (Mariel, 2026-09-18).
    const pool = query
      ? allTopics
          .map(topic => [topic, topic.toLowerCase()] as const)
          .filter(([, lower]) => lower.includes(query))
          .sort(([, a], [, b]) => {
            const rank = (t: string) => (t === query ? 0 : t.startsWith(query) ? 1 : 2);
            return rank(a) - rank(b) || a.length - b.length;
          })
          .map(([topic]) => topic)
      : seedTopics;
    const filtered = pool.filter(topic => !selectedTopics.includes(normalizeTopicId(topic)));
    return query ? filtered.slice(0, MAX_TOPIC_SUGGESTIONS) : filtered;
  }, [allTopics, query, seedTopics, selectedTopics]);

  const exactMatchingTopicLabel = useMemo(
    () => allTopics.find((topic) => normalizeTopicId(topic) === normalizeTopicId(search.trim())) || null,
    [allTopics, search],
  );
  const isAlreadySelectedTopic = useMemo(
    () => Boolean(exactMatchingTopicLabel && selectedTopics.includes(normalizeTopicId(exactMatchingTopicLabel))),
    [exactMatchingTopicLabel, selectedTopics],
  );

  const hasSearchCriteria = selectedTopics.length > 0 || promptTerms.length > 0;
  const radiusPercent = Math.round(radius * 100);
  const hasChanges =
    JSON.stringify(selectedTopics) !== JSON.stringify(initialState.topics) ||
    JSON.stringify(promptTerms) !== JSON.stringify(initialState.promptTerms) ||
    currentGraphPosition.x !== initialState.position.x ||
    currentGraphPosition.y !== initialState.position.y ||
    radiusPercent !== initialState.radius;
  const topNewsFilterState =
    hasSearchCriteria
      ? null
      : !isDefaultGraphSelection(currentGraphPosition, radiusPercent)
        ? 'active'
        : null;
  const showSelectedFilters = Boolean(topNewsFilterState || hasSearchCriteria);
  const availableTrendingTopics = useMemo(
    () => trendingTopics.filter((topic) => !selectedTopics.includes(normalizeTopicId(topic))),
    [selectedTopics, trendingTopics],
  );
  const selectedTrendingTopicIds = useMemo(
    () => new Set(trendingTopics.map((topic) => normalizeTopicId(topic))),
    [trendingTopics],
  );

  const cancelScheduledDropdownClose = useCallback(() => {
    if (dropdownCloseTimeoutRef.current) {
      clearTimeout(dropdownCloseTimeoutRef.current);
      dropdownCloseTimeoutRef.current = null;
    }
  }, []);

  const closeDropdown = useCallback(() => {
    cancelScheduledDropdownClose();
    setIsDropdownOpen(false);
  }, [cancelScheduledDropdownClose]);

  const dismissSearch = useCallback(() => {
    cancelScheduledDropdownClose();
    searchInputRef.current?.blur();
    Keyboard.dismiss();
    setIsDropdownOpen(false);
  }, [cancelScheduledDropdownClose]);

  const scheduleDropdownClose = useCallback(() => {
    cancelScheduledDropdownClose();
    dropdownCloseTimeoutRef.current = setTimeout(() => {
      setIsDropdownOpen(false);
      dropdownCloseTimeoutRef.current = null;
    }, 180);
  }, [cancelScheduledDropdownClose]);

  const openDropdown = useCallback(() => {
    cancelScheduledDropdownClose();
    setIsDropdownOpen(true);
  }, [cancelScheduledDropdownClose]);

  useEffect(() => () => cancelScheduledDropdownClose(), [cancelScheduledDropdownClose]);

  useEffect(() => {
    graphPositionRef.current = isDefaultResetLockedRef.current
      ? { ...DEFAULT_GRAPH_POSITION }
      : canvasToGraphPoint(pinX, pinY, graphWidth, graphHeight);
    // A canvas resize must preserve the normalized position already in the ref.
    // The resize effect below converts that position back to the new pixel size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinX, pinY]);

  useEffect(() => {
    const previousSize = previousGraphSizeRef.current;
    if (
      previousSize.width === graphWidth &&
      previousSize.height === graphHeight
    ) {
      return;
    }

    previousGraphSizeRef.current = {
      width: graphWidth,
      height: graphHeight,
    };

    const nextPosition = isDefaultResetLockedRef.current
      ? DEFAULT_GRAPH_POSITION
      : graphPositionRef.current;
    const nextPin = graphPointToCanvas(nextPosition, graphWidth, graphHeight);

    setPinX(nextPin.x);
    setPinY(nextPin.y);
    animatedPinX.value = nextPin.x;
    animatedPinY.value = nextPin.y;
  }, [animatedPinX, animatedPinY, graphHeight, graphWidth]);

  const commitGraphPosition = useCallback((x: number, y: number, revision: number) => {
    if (revision !== graphResetRevisionRef.current) return;
    isDefaultResetLockedRef.current = false;
    const nextX = clamp(x, 0, graphWidth);
    const nextY = clamp(y, 0, graphHeight);
    setPinX(nextX);
    setPinY(nextY);
    graphPositionRef.current = canvasToGraphPoint(nextX, nextY, graphWidth, graphHeight);
  }, [graphHeight, graphWidth]);

  const commitRadius = useCallback((nextRadius: number, revision: number) => {
    if (revision !== graphResetRevisionRef.current) return;
    isDefaultResetLockedRef.current = false;
    setRadius(nextRadius);
    setShowPinchHint(false); // they found the gesture
  }, []);

  // Sources light up live while the dot drags too (throttled to ~14px of
  // travel so the SVG re-render can't flood the JS thread).
  const lastLivePanX = useSharedValue(-1);
  const lastLivePanY = useSharedValue(-1);
  const panDidActivate = useSharedValue(false);
  const graphPanGesture = useMemo(
    () => Gesture.Pan()
      .minDistance(4)
      // Single finger only: with two down, the pan centroid moved as the
      // pinch spread and dragged the dot around mid-gesture — the "glitchy
      // and finicky" pinch (Ayuka, 2026-09-16).
      .maxPointers(1)
      // onBegin fires on plain touch-down, BEFORE the gesture qualifies —
      // moving the pin there teleported the dot to the first finger of an
      // incoming pinch, and onFinalize (which also runs for gestures that
      // never activated) then committed it (Ayuka, 2026-09-19, msg 1499).
      // The pin now moves only once the pan actually activates; bare taps
      // stay the tap gesture's job.
      .onBegin(() => {
        activeGraphGestureRevision.value = graphResetRevision.value;
        panDidActivate.value = false;
      })
      .onStart((event) => {
        panDidActivate.value = true;
        animatedPinX.value = Math.max(0, Math.min(graphWidth, event.x));
        animatedPinY.value = Math.max(0, Math.min(graphHeight, event.y));
        lastLivePanX.value = animatedPinX.value;
        lastLivePanY.value = animatedPinY.value;
      })
      .onUpdate((event) => {
        animatedPinX.value = Math.max(0, Math.min(graphWidth, event.x));
        animatedPinY.value = Math.max(0, Math.min(graphHeight, event.y));
        if (
          Math.hypot(
            animatedPinX.value - lastLivePanX.value,
            animatedPinY.value - lastLivePanY.value,
          ) > 14
        ) {
          lastLivePanX.value = animatedPinX.value;
          lastLivePanY.value = animatedPinY.value;
          runOnJS(commitGraphPosition)(
            animatedPinX.value,
            animatedPinY.value,
            activeGraphGestureRevision.value,
          );
        }
      })
      .onFinalize(() => {
        if (!panDidActivate.value) return;
        panDidActivate.value = false;
        runOnJS(commitGraphPosition)(
          animatedPinX.value,
          animatedPinY.value,
          activeGraphGestureRevision.value,
        );
      }),
    [
      activeGraphGestureRevision,
      animatedPinX,
      animatedPinY,
      commitGraphPosition,
      graphHeight,
      graphResetRevision,
      graphWidth,
      lastLivePanX,
      lastLivePanY,
      panDidActivate,
    ],
  );

  const graphTapGesture = useMemo(
    () => Gesture.Tap()
      .maxDistance(8)
      .onBegin(() => {
        activeGraphGestureRevision.value = graphResetRevision.value;
      })
      .onEnd((event, success) => {
        if (!success) return;
        animatedPinX.value = Math.max(0, Math.min(graphWidth, event.x));
        animatedPinY.value = Math.max(0, Math.min(graphHeight, event.y));
        runOnJS(commitGraphPosition)(
          animatedPinX.value,
          animatedPinY.value,
          activeGraphGestureRevision.value,
        );
      }),
    [
      activeGraphGestureRevision,
      animatedPinX,
      animatedPinY,
      commitGraphPosition,
      graphHeight,
      graphResetRevision,
      graphWidth,
    ],
  );

  // Pinch anywhere on the graph to grow/shrink the selection circle —
  // the radius control lives on the map itself. Sources light up LIVE as
  // the circle crosses them — updating only on release made
  // the gesture feel glitchy (Ayuka, 2026-09-15).
  // Time-throttle live JS commits while the circle previews on the UI thread:
  // step-based updates made pinch feel uneven (Ayuka, 2026-09-16, 2026-09-18).
  const pinchBaseRadius = useSharedValue(0);
  const lastPinchCommitAt = useSharedValue(0);
  const graphPinchGesture = useMemo(
    () => Gesture.Pinch()
      .onBegin(() => {
        activeSliderGestureRevision.value = graphResetRevision.value;
        pinchBaseRadius.value = animatedRadius.value;
        lastPinchCommitAt.value = 0;
      })
      .onUpdate((event) => {
        const preview = Math.max(0.05, Math.min(1, pinchBaseRadius.value * event.scale));
        animatedRadius.value = preview;
        const now = Date.now();
        if (now - lastPinchCommitAt.value >= 50) {
          lastPinchCommitAt.value = now;
          runOnJS(commitRadius)(preview, activeSliderGestureRevision.value);
        }
      })
      .onFinalize(() => {
        const stepped = Math.max(0.05, Math.min(1, Math.round(animatedRadius.value * 20) / 20));
        animatedRadius.value = withTiming(stepped, { duration: 120 });
        runOnJS(commitRadius)(stepped, activeSliderGestureRevision.value);
      }),
    [activeSliderGestureRevision, animatedRadius, commitRadius, graphResetRevision, lastPinchCommitAt, pinchBaseRadius],
  );

  const graphGesture = useMemo(
    () => Gesture.Simultaneous(Gesture.Race(graphPanGesture, graphTapGesture), graphPinchGesture),
    [graphPanGesture, graphTapGesture, graphPinchGesture],
  );

  const radiusCircleAnimatedProps = useAnimatedProps(() => ({
    cx: animatedPinX.value,
    cy: animatedPinY.value,
    r: animatedRadius.value * (graphWidth * SELECTION_RADIUS_FACTOR),
  }));
  const markerCircleAnimatedProps = useAnimatedProps(() => ({
    cx: animatedPinX.value,
    cy: animatedPinY.value,
  }));

  const handleTopicSelect = (topic: string) => {
    const normalizedTopic = normalizeTopicId(topic);
    if (!selectedTopics.includes(normalizedTopic)) {
      setSelectedTopics((prev) => [...prev, normalizedTopic]);
    }
    setSearch('');
    searchInputRef.current?.blur();
    closeDropdown();
  };

  const removeTopic = (topic: string) => {
    setSelectedTopics((prev) => prev.filter((item) => item !== topic));
  };

  const removePrompt = (term: string) => {
    setPromptTerms((prev) => prev.filter((item) => item !== term));
  };

  const applyGraphChanges = (
    nextTopics: string[],
    nextPromptTerms: string[],
  ) => {
    if (isApplying) return;
    setIsApplying(true);

    try {
      const nextRecommendationRequest: RecommendationRequestState = {
        prompt: nextPromptTerms.join('; '),
        topics: nextTopics,
        position: {
          x: currentGraphPosition.x / 100,
          y: currentGraphPosition.y / 100,
        },
        radius: radiusPercent / 100,
      };
      const nextHasSearchCriteria = nextTopics.length > 0 || nextPromptTerms.length > 0;
      const nextTopNewsGraphFilter =
        nextHasSearchCriteria || isDefaultGraphSelection(currentGraphPosition, radiusPercent)
          ? null
          : {
              position: { ...currentGraphPosition },
              radius: radiusPercent,
            };

      setInitialState({
        topics: [...nextTopics],
        promptTerms: [...nextPromptTerms],
        position: { ...currentGraphPosition },
        radius: radiusPercent,
      });

      if (nextHasSearchCriteria) {
        setHasAppliedTopNewsFilter(false);
        closeDropdown();
        const prefetchedArticles = getRecommenderConfig().isEnabled
          ? null
          : buildSafeModePrefetchedArticles({
              topics: nextTopics,
              promptTerms: nextPromptTerms,
              position: currentGraphPosition,
              radius: radiusPercent,
            });
        applyQueryPreferences({
          activeQuery: {
            topics: nextTopics,
            promptTerms: nextPromptTerms,
          },
          recommendationRequest: nextRecommendationRequest,
          prefetchedArticles,
        });

        router.navigate('/');
        return;
      }

      setHasAppliedTopNewsFilter(Boolean(nextTopNewsGraphFilter));
      closeDropdown();
      // Applying a range is a request to see the range, not today's Digest.
      requestDailyDigestExit();
      applyTopNewsPreferences(nextTopNewsGraphFilter);

      router.navigate('/');
    } catch (error) {
      console.warn('[GraphScreen] Failed to apply changes', error);
      setIsApplying(false);
      Alert.alert(
        'Could not apply changes',
        'Please try again.',
      );
    }
  };

  const runDeterministicGraphSearch = async (
    query: string,
    nextTopics: string[],
    nextPromptTerms: string[],
  ) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (isApplying) return;
    setIsApplying(true);

    const nextRecommendationRequest: RecommendationRequestState = {
      prompt: trimmed,
      topics: nextTopics,
      position: {
        x: currentGraphPosition.x / 100,
        y: currentGraphPosition.y / 100,
      },
      radius: radiusPercent / 100,
      searchStrategy: 'deterministic',
    };

    try {
      // This is the only live lookup a free-text Graph search performs. The
      // helper uses the five-minute article cache and never calls AI.
      const prefetchedArticles = await searchGraphArticles(trimmed, {
        position: { ...currentGraphPosition },
        radius: radiusPercent,
      });

      setInitialState({
        topics: [...nextTopics],
        promptTerms: [...nextPromptTerms],
        position: { ...currentGraphPosition },
        radius: radiusPercent,
      });
      setSelectedTopics(nextTopics);
      setPromptTerms(nextPromptTerms);
      setSearch('');
      dismissSearch();
      closeDropdown();
      setHasAppliedTopNewsFilter(false);
      applyQueryPreferences({
        activeQuery: {
          topics: nextTopics,
          promptTerms: nextPromptTerms,
        },
        recommendationRequest: nextRecommendationRequest,
        prefetchedArticles,
      });
      router.navigate('/');
    } catch (error) {
      console.warn('[GraphScreen] Text search failed', error);
      Alert.alert(
        'Search unavailable',
        'We could not load articles right now. Please try again.',
      );
    } finally {
      setIsApplying(false);
    }
  };

  const handleApplyChanges = () => {
    // Typed terms wait as chips until the circle is set; Apply runs the
    // deterministic full-corpus search (newest first inside the circle),
    // never the AI stream.
    if (promptTerms.length > 0) {
      void runDeterministicGraphSearch(promptTerms.join(' '), selectedTopics, promptTerms);
      return;
    }
    // One selected preset/topic is a search intent, not a recommendation
    // prompt. Send it through the same full-corpus Graph search as typed
    // terms so choosing “Landslides and Flooding” reliably returns that story
    // area without an AI stream.
    if (selectedTopics.length === 1 && promptTerms.length === 0) {
      void runDeterministicGraphSearch(selectedTopics[0], selectedTopics, []);
      return;
    }
    applyGraphChanges(selectedTopics, promptTerms);
  };

  const handleGraphSearch = async () => {
    const trimmed = search.trim();
    if (!trimmed) {
      dismissSearch();
      return;
    }

    const matchedTopic = allTopics.find(
      (topic) => normalizeTopicId(topic) === normalizeTopicId(trimmed),
    );
    const normalizedTopic = matchedTopic ? normalizeTopicId(matchedTopic) : null;
    const nextTopics = normalizedTopic && !selectedTopics.includes(normalizedTopic)
      ? [...selectedTopics, normalizedTopic]
      : selectedTopics;
    const nextPromptTerms = matchedTopic || promptTerms.includes(trimmed)
      ? promptTerms
      : [...promptTerms, trimmed];

    // Stage the term as a chip, like the web preferences page. The user
    // adjusts the circle first; "Apply Changes" runs the search.
    setSelectedTopics(nextTopics);
    setPromptTerms(nextPromptTerms);
    setSearch('');
    dismissSearch();
    closeDropdown();
  };

  const handleTopNewsReset = () => {
    graphResetRevisionRef.current += 1;
    graphResetRevision.value = graphResetRevisionRef.current;
    isDefaultResetLockedRef.current = true;
    const defaultPin = graphPointToCanvas(
      DEFAULT_GRAPH_POSITION,
      graphWidth,
      graphHeight,
    );
    setPinX(defaultPin.x);
    setPinY(defaultPin.y);
    setRadius(DEFAULT_GRAPH_RADIUS / 100);
    animatedPinX.value = defaultPin.x;
    animatedPinY.value = defaultPin.y;
    animatedRadius.value = DEFAULT_GRAPH_RADIUS / 100;
    graphPositionRef.current = { ...DEFAULT_GRAPH_POSITION };
    setHasAppliedTopNewsFilter(false);
    closeDropdown();
    syncTopNewsFallbackState(null);
  };

  const handleOpenDailyDigest = useCallback(() => {
    void writeDailyDigestOpenRequest(true);
    router.navigate('/');
  }, []);

  const handleOpenSaveDialog = () => {
    if (!hasSearchCriteria) return;
    if (!user) {
      setShowSignInDialog(true);
      return;
    }
    setDigestName('');
    setShowSaveDialog(true);
  };

  const handleSavePreset = () => {
    if (!user || !digestName.trim()) return;

    const nextPreset: DigestPreset = {
      id: String(Date.now()),
      name: digestName.trim(),
      topics: [...selectedTopics],
      position: { ...currentGraphPosition },
      radius: radiusPercent,
      createdAt: Date.now(),
    };

    persistDigests([...digests, nextPreset]);
    setDigestName('');
    setShowSaveDialog(false);
  };

  const handleLoadPreset = (preset: DigestPreset) => {
    isDefaultResetLockedRef.current = false;
    graphPositionRef.current = { ...preset.position };
    const point = graphPointToCanvas(preset.position, graphWidth, graphHeight);
    setSelectedTopics(preset.topics.map(normalizeTopicId));
    setPromptTerms([]);
    setPinX(point.x);
    setPinY(point.y);
    setRadius(preset.radius / 100);
    animatedPinX.value = point.x;
    animatedPinY.value = point.y;
    animatedRadius.value = preset.radius / 100;
    searchInputRef.current?.blur();
    closeDropdown();
  };

  const handleDeletePreset = (presetId: string, presetName: string) => {
    const removePreset = () => {
      persistDigests(digests.filter((preset) => preset.id !== presetId));
    };

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(`Delete the preset "${presetName}"?`)) return;
      removePreset();
      return;
    }

    Alert.alert(
      'Delete preset',
      `Delete the preset "${presetName}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: removePreset },
      ],
    );
  };

  const positionedOutlets = useMemo(
    () =>
      OUTLETS.map((outlet) => ({
        ...outlet,
        width: outlet.width * graphScale,
        height: outlet.height * graphScale,
        x: graphToSvg(outlet.gx * OUTLET_SPREAD, graphWidth) + (outlet.dx ?? 0) * graphScale,
        y: graphHeight - graphToSvg(outlet.gy * OUTLET_SPREAD, graphHeight) + outlet.dy * graphScale,
        imageX: graphToSvg(outlet.gx * OUTLET_SPREAD, graphWidth) + (outlet.dx ?? 0) * graphScale - (outlet.width * graphScale) / 2,
        imageY: graphHeight - graphToSvg(outlet.gy * OUTLET_SPREAD, graphHeight) + outlet.dy * graphScale - (outlet.height * graphScale) / 2,
        labelX: graphToSvg(outlet.gx * OUTLET_SPREAD, graphWidth) + (outlet.dx ?? 0) * graphScale + (outlet.labelDx ?? 0) * graphScale,
        labelY: graphHeight - graphToSvg(outlet.gy * OUTLET_SPREAD, graphHeight) + outlet.dy * graphScale + (outlet.height * graphScale) / 2 + (outlet.labelDy ?? 10) * graphScale,
      })),
    [graphHeight, graphScale, graphWidth],
  );

  // Which sources fall inside the selection circle (canvas-space distance,
  // padded by half the logo size so "touching" counts as in).
  const selectionRadiusPx = radius * graphWidth * SELECTION_RADIUS_FACTOR;
  const outletsWithSelection = useMemo(
    () =>
      positionedOutlets.map((outlet) => ({
        ...outlet,
        inside:
          Math.hypot(outlet.x - pinX, outlet.y - pinY) <=
          selectionRadiusPx + Math.max(outlet.width, outlet.height) / 2,
      })),
    [positionedOutlets, pinX, pinY, selectionRadiusPx],
  );
  const insideOutlets = useMemo(
    () => outletsWithSelection.filter((outlet) => outlet.inside),
    [outletsWithSelection],
  );
  // Only the 3 sources closest to the dot carry a name — the same 3 the
  // readout line cites. Everything else is logo-only, so labels can never
  // pile up or clip at the canvas edge (Ayuka, 2026-09-15: "too crowded").
  const labeledOutletKeys = useMemo(() => {
    const byDistance = insideOutlets
      .filter((outlet) => outlet.label)
      .sort(
        (a, b) => Math.hypot(a.x - pinX, a.y - pinY) - Math.hypot(b.x - pinX, b.y - pinY),
      );
    return new Set(byDistance.slice(0, 3).map((outlet) => outlet.key));
  }, [insideOutlets, pinX, pinY]);
  return (
    <SafeAreaView ref={onboardingRootRef} style={[s.container, { backgroundColor: PAGE.background }]}>
      {isHelpOpen || showSaveDialog || showSignInDialog ? (
        <Pressable
          style={s.modalBackdrop}
          onPress={() => {
            setIsHelpOpen(false);
            setShowSaveDialog(false);
            setShowSignInDialog(false);
          }}
        />
      ) : null}

      <Pressable onPress={dismissSearch}>
      <View style={[s.header, isNarrowScreen && s.headerNarrow, { borderBottomColor: PAGE.border }]}>
        <View style={[s.headerLeft, isNarrowScreen && s.headerSideNarrow]}>
          {isGuestMode || !user ? (
            <Link href={buildHref('/login', { returnTo: '/graph' })} asChild>
              <TouchableOpacity
                style={s.signInBtn}
                accessibilityRole="link"
                accessibilityLabel="Sign in"
              >
                <Text style={s.signInText}>Sign In</Text>
              </TouchableOpacity>
            </Link>
          ) : (
            <>
              <TouchableOpacity
                style={s.headerIcon}
                onPress={() => router.push('/profile')}
                accessibilityRole="button"
                accessibilityLabel="Open profile"
              >
                <Ionicons name="person-outline" size={20} color={PAGE.text} />
              </TouchableOpacity>
              <View style={[s.streakPill, { backgroundColor: '#E9EDD8', borderColor: '#D9DEC5' }]}>
                <Ionicons name="flame-outline" size={15} color="#8DAE73" />
                <Text style={s.streakText}>{user ? (profile ? (profile.current_streak ?? 0) : (cachedStreak ?? '–')) : localStreakCount}</Text>
              </View>
            </>
          )}
        </View>
        <Text style={[s.headerTitle, isNarrowScreen && s.headerTitleNarrow]}>Praxis</Text>
        <View style={[s.headerRight, isNarrowScreen && s.headerSideNarrow]}>
          {isGuestMode || !user ? (
            <Link href={buildHref('/login', { returnTo: '/saved' })} asChild>
              <TouchableOpacity
                style={s.headerIcon}
                accessibilityRole="link"
                accessibilityLabel="Sign in to view saved articles"
              >
                <Ionicons name="bookmark-outline" size={20} color={PAGE.text} />
              </TouchableOpacity>
            </Link>
          ) : (
            <TouchableOpacity
              style={s.headerIcon}
              onPress={() => router.push('saved' as any)}
              accessibilityRole="button"
              accessibilityLabel="Open saved articles"
            >
              <Ionicons name="bookmark-outline" size={20} color={PAGE.text} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={s.headerIcon}
            onPress={() => router.push('/search')}
            accessibilityRole="button"
            accessibilityLabel="Open search"
          >
            <Ionicons name="search-outline" size={20} color={PAGE.text} />
          </TouchableOpacity>
        </View>
      </View>
      </Pressable>

      <View style={s.controls}>
        <View ref={onboardingTopicsRef} collapsable={false} style={s.searchRow}>
          <View style={s.searchFieldWrap}>
            <View style={[s.searchShell, { borderColor: PAGE.chipBorder }]}>
              <Ionicons name="search-outline" size={18} color={PAGE.textMuted} />
              <TextInput
                ref={searchInputRef}
                value={search}
                onChangeText={(value) => {
                  setSearch(value);
                  if (!isDropdownOpen) openDropdown();
                }}
                onFocus={() => {
                  setIsSearchFocused(true);
                  openDropdown();
                }}
                onBlur={() => {
                  setIsSearchFocused(false);
                  scheduleDropdownClose();
                }}
                onSubmitEditing={handleGraphSearch}
                placeholder="Search topics or add keywords..."
                placeholderTextColor={PAGE.textMuted}
                style={s.searchInput}
                blurOnSubmit
                inputAccessoryViewID={Platform.OS === 'ios' ? SEARCH_INPUT_ACCESSORY_ID : undefined}
                returnKeyType="search"
                testID="graph-search-input"
                accessibilityLabel="Search topics or add keywords"
              />
              {isSearchFocused ? (
                <TouchableOpacity
                  onPress={dismissSearch}
                  style={s.clearButton}
                  accessibilityRole="button"
                  accessibilityLabel="Close topic search and hide keyboard"
                >
                  <Ionicons name="close" size={16} color={PAGE.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>

            {isDropdownOpen ? (
              <View style={s.dropdownOverlay} onTouchStart={cancelScheduledDropdownClose}>
                <ScrollView
                  style={s.dropdown}
                  contentContainerStyle={s.dropdownContent}
                  showsVerticalScrollIndicator
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="always"
                >
                  {!query || digests.length > 0 || hasSearchCriteria ? (
                    <View style={s.presetsBlock}>
                      {digests.length > 0 || (query && hasSearchCriteria) ? (
                        <Text style={s.dropdownLabel}>Saved presets</Text>
                      ) : null}
                      <View style={s.presetsRow}>
                        {!query ? (
                          <TouchableOpacity
                            onPress={handleOpenDailyDigest}
                            style={s.dailyDigestShortcutChip}
                            accessibilityRole="button"
                            accessibilityLabel="Open today's Daily Digest"
                            testID="graph-daily-digest"
                          >
                            <Ionicons name="sparkles-outline" size={13} color="#5F438E" />
                            <Text style={s.dailyDigestShortcutText}>Daily Digest</Text>
                          </TouchableOpacity>
                        ) : null}
                        {digests.map((preset) => (
                          <View key={preset.id} style={s.presetWrap}>
                            <TouchableOpacity
                              style={s.presetChip}
                              onPress={() => handleLoadPreset(preset)}
                              accessibilityRole="button"
                              accessibilityLabel={`Load preset ${preset.name}`}
                              testID={`graph-preset-${topicToTestId(preset.name)}`}
                            >
                              <Text style={s.presetChipText}>{preset.name}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={s.presetDelete}
                              onPress={() => handleDeletePreset(preset.id, preset.name)}
                              accessibilityRole="button"
                              accessibilityLabel={`Delete preset ${preset.name}`}
                            >
                              <Ionicons name="close" size={10} color={PAGE.textMuted} />
                            </TouchableOpacity>
                          </View>
                        ))}
                      </View>
                      {digests.length === 0 && query && hasSearchCriteria ? (
                        <Text style={s.emptyDropdownText}>No saved presets yet.</Text>
                      ) : null}
                    </View>
                  ) : null}

                  {query ? (
                    <TouchableOpacity
                      onPress={handleGraphSearch}
                      disabled={isApplying}
                      style={s.dropdownSearchRow}
                      accessibilityRole="button"
                      accessibilityLabel={`Search articles for ${search.trim()}`}
                      accessibilityState={{ disabled: isApplying, busy: isApplying }}
                    >
                      <View style={s.dropdownSearchLeft}>
                        <Ionicons name="search-outline" size={14} color={PAGE.textMuted} />
                        <Text style={s.dropdownSearchText} numberOfLines={1}>
                          {isApplying ? 'Searching articles…' : <>Search articles for "<Text style={s.dropdownSearchTerm}>{search.trim()}</Text>"</>}
                        </Text>
                      </View>
                      {isApplying ? (
                        <ActivityIndicator size="small" color={PAGE.green} />
                      ) : (
                        <Ionicons name="arrow-forward" size={15} color={PAGE.textMuted} />
                      )}
                    </TouchableOpacity>
                  ) : null}

                  {visibleTopics.length > 0 ? (
                    <View style={s.dropdownTopicsBlock}>
                      <Text style={s.dropdownLabel}>{query ? 'Matching topics' : 'Categories'}</Text>
                      <View style={s.dropdownTopics}>
                        {visibleTopics.map((topic) => (
                          <TouchableOpacity
                            key={topic}
                            style={s.dropdownTopicChip}
                            onPress={() => handleTopicSelect(topic)}
                            accessibilityRole="button"
                            accessibilityLabel={`Select topic ${topic}`}
                            testID={`graph-topic-${topicToTestId(topic)}`}
                          >
                            <Text style={s.dropdownTopicText}>{topic}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  ) : query ? (
                    <Text style={[s.emptyDropdownText, s.emptyDropdownCentered]}>
                      {isAlreadySelectedTopic ? 'Topic already selected' : 'No matching topics'}
                    </Text>
                  ) : null}
                </ScrollView>
              </View>
            ) : null}
          </View>

          <TouchableOpacity
            style={[
              s.saveButton,
              {
                borderColor: PAGE.chipBorder,
                backgroundColor: hasSearchCriteria ? '#EAF2E1' : '#F3EEE3',
              },
            ]}
            onPress={handleOpenSaveDialog}
            disabled={!hasSearchCriteria}
            accessibilityRole="button"
            accessibilityLabel="Save graph preset"
            testID="graph-save-button"
          >
            <Ionicons name="add" size={18} color={hasSearchCriteria ? PAGE.green : PAGE.textSoft} />
            <Text style={[s.saveButtonText, { color: hasSearchCriteria ? '#5D7650' : PAGE.textSoft }]}>Save</Text>
          </TouchableOpacity>
        </View>

        <View style={s.selectedFiltersSection}>
          {topNewsFilterState ? (
            <TouchableOpacity
              onPress={handleTopNewsReset}
              style={s.topNewsPill}
              accessibilityRole="button"
              accessibilityLabel="Reset Top News to defaults"
              testID="graph-top-news-reset"
            >
              <Ionicons name="flame-outline" size={14} color="#D57A24" />
              <Text style={s.topNewsPillText}>Top News</Text>
            </TouchableOpacity>
          ) : hasSearchCriteria ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.selectedFiltersRow}
            >
              {selectedTopics.map((topic) => (
                <TouchableOpacity
                  key={topic}
                  onPress={() => removeTopic(topic)}
                  activeOpacity={0.82}
                  style={[
                    s.selectedTopicPill,
                    selectedTrendingTopicIds.has(topic) ? s.selectedTrendingTopicPill : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove topic ${topicIdToLabel(topic, allTopics)}`}
                >
                  {selectedTrendingTopicIds.has(topic) ? (
                    <Ionicons name="trending-up-outline" size={12} color="#A56F2A" />
                  ) : null}
                  <Text
                    style={[
                      s.selectedTopicText,
                      selectedTrendingTopicIds.has(topic) ? s.selectedTrendingTopicText : null,
                    ]}
                  >
                    {topicIdToLabel(topic, allTopics)}
                  </Text>
                  <Ionicons
                    name="close"
                    size={12}
                    color={selectedTrendingTopicIds.has(topic) ? '#A56F2A' : PAGE.textMuted}
                  />
                </TouchableOpacity>
              ))}
              {promptTerms.map((term) => (
                <TouchableOpacity
                  key={term}
                  onPress={() => removePrompt(term)}
                  activeOpacity={0.82}
                  style={s.promptPill}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove keyword ${term}`}
                >
                  <Ionicons name="chatbubble-ellipses-outline" size={12} color={PAGE.textMuted} />
                  <Text style={s.promptPillText}>{term}</Text>
                  <Ionicons name="close" size={12} color={PAGE.textMuted} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
        </View>

        {/*
          Trending stays put under the search box; the selected pill (Top
          News, or the chosen topics/keywords) goes UNDER trending instead of
          between them, so the row he scans never moves and HARD NEWS stops
          colliding with it (Ayuka, 2026-09-17, msg 1238). The section below
          drops by one row only while a filter is active.
        */}
        <View style={s.filterArea}>
          {availableTrendingTopics.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.topicRow}
            >
              <View style={s.topicRowLead}>
                <Ionicons name="trending-up-outline" size={14} color={PAGE.textSoft} />
              </View>
              {availableTrendingTopics.map((topic) => (
                <TouchableOpacity
                  key={topic}
                  style={s.topicChip}
                  onPress={() => handleTopicSelect(topic)}
                  accessibilityRole="button"
                  accessibilityLabel={`Select trending topic ${topic}`}
                  testID={`graph-trending-${topicToTestId(topic)}`}
                >
                  <Text style={s.topicChipText}>{topic}</Text>
                  <Text style={s.topicChipPlus}>+</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>

      {Platform.OS === 'ios' ? (
        <InputAccessoryView nativeID={SEARCH_INPUT_ACCESSORY_ID}>
          <View style={s.keyboardAccessory}>
            <TouchableOpacity
              onPress={dismissSearch}
              accessibilityRole="button"
              accessibilityLabel="Done typing"
              style={s.keyboardDoneButton}
            >
              <Text style={s.keyboardDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </InputAccessoryView>
      ) : null}

      <Pressable style={s.graphSection} onPress={dismissSearch}>
        <View
          ref={onboardingGraphRef}
          collapsable={false}
          style={s.graphWrap}
          onLayout={(event) => {
            if (shouldShowGraphOnboarding) measureOnboardingTargets();
            const { width, height } = event.nativeEvent.layout;
            setGraphViewport((previous) => {
              const nextWidth = Math.round(width);
              const nextHeight = Math.round(height);
              if (
                previous.width === nextWidth &&
                previous.height === nextHeight
              ) {
                return previous;
              }

              return {
                width: nextWidth,
                height: nextHeight,
              };
            });
          }}
        >
          <View
            style={[s.graphCanvas, { width: graphWidth, height: graphHeight }]}
          >
            <TouchableOpacity
              style={[
                s.helpButton,
                {
                  borderColor: PAGE.chipBorder,
                  width: clamp(44 * graphScale, 34, 44),
                  height: clamp(44 * graphScale, 34, 44),
                  borderRadius: clamp(22 * graphScale, 17, 22),
                },
              ]}
              activeOpacity={0.85}
              onPress={() => setIsHelpOpen(true)}
            >
              <Ionicons name="help-circle-outline" size={clamp(26 * graphScale, 20, 26)} color={PAGE.text} />
            </TouchableOpacity>
            <GestureDetector gesture={graphGesture}>
              <Animated.View style={{ width: graphWidth, height: graphHeight }}>
                <Svg width={graphWidth} height={graphHeight}>
                  {/* The vertical line runs out to its labels — 8 from HARD
                      NEWS, 16 from OPINION; the pills sit 21 outside the
                      canvas and are 18 tall, so their inner edges are 3
                      outside it. Left/Right already touch the horizontal
                      line, which keeps the inset (Ayuka, 2026-09-18). */}
                  <Line x1={centerX} y1={5} x2={centerX} y2={graphHeight - 13} stroke="#DED6C8" strokeWidth={1.25} />
                  <Line x1={graphAxisInset} y1={centerY} x2={graphWidth - graphAxisInset} y2={centerY} stroke="#DED6C8" strokeWidth={1.25} />
                  <AnimatedCircle
                    animatedProps={radiusCircleAnimatedProps}
                    fill="rgba(141,174,115,0.06)"
                    stroke={PAGE.green}
                    strokeOpacity={0.75}
                    strokeWidth={1.75}
                    strokeDasharray="1,7"
                    strokeLinecap="round"
                  />
                  <AnimatedCircle animatedProps={markerCircleAnimatedProps} r={clamp(16 * graphScale, 11, 20)} fill={PAGE.green} stroke="#FFFFFF" strokeWidth={clamp(5 * graphScale, 3.5, 6)} />
                  <GraphOutletLayer
                    graphWidth={graphWidth}
                    graphScale={graphScale}
                    outletsWithSelection={outletsWithSelection}
                    labeledOutletKeys={labeledOutletKeys}
                  />
                </Svg>
              </Animated.View>
            </GestureDetector>
            <View style={[s.axisWord, s.axisTopPill]} pointerEvents="none">
              <Text style={s.axisPillText}>Hard News</Text>
            </View>
            <View style={[s.axisWord, s.axisBottomPill]} pointerEvents="none">
              <Text style={s.axisPillText}>Opinion</Text>
            </View>
            <View style={[s.axisWord, s.axisLeftPill]} pointerEvents="none">
              <Text style={s.axisPillText}>Left</Text>
            </View>
            <View style={[s.axisWord, s.axisRightPill]} pointerEvents="none">
              <Text style={s.axisPillText}>Right</Text>
            </View>
            {showPinchHint ? (
              <View style={s.pinchHint} pointerEvents="none">
                <Text style={s.pinchHintText}>Pinch to resize your range</Text>
              </View>
            ) : null}
          </View>

          {/*
            The one-line "CENTER · MIXED" readout, back by his ask (msg
            1442, option C) after the two-line card was cut 2026-09-17
            (msg 1246). Its own always-laid-out line ABOVE Apply's slot —
            not swapping with the button (his 1451) — so it tracks the
            dot live while dragging and Apply pins it.
          */}
          <Text style={s.readoutText} accessibilityLiveRegion="polite">
            {`${getPoliticalLeanLabel(currentGraphPosition.x / 100)} · ${getReportingTypeLabel(currentGraphPosition.y / 100)}`}
          </Text>
          <View
            style={[s.applySlot, !(hasChanges || isApplying) && s.applySlotIdle]}
            pointerEvents={hasChanges || isApplying ? 'auto' : 'none'}
          >
            <TouchableOpacity
              style={[s.applyButton, isApplying && s.applyButtonDisabled]}
              onPress={handleApplyChanges}
              disabled={!hasChanges || isApplying}
              accessibilityRole="button"
              accessibilityLabel="Apply graph changes"
              testID="graph-apply-button"
            >
              <Text style={s.applyButtonText}>
                {isApplying ? 'Loading...' : 'Apply Changes →'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>

      {isHelpOpen ? (
        <View style={s.modalWrap} pointerEvents="box-none">
          <View style={s.helpModal}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={s.helpModalContent}
            >
              <View style={s.helpHeader}>
                <View style={s.helpTitleBlock}>
                  <Text style={s.helpTitle}>About the News Map</Text>
                  <Text style={s.helpSubtitle}>Understanding the news positioning graph</Text>
                </View>
                <TouchableOpacity style={s.helpCloseButton} onPress={() => setIsHelpOpen(false)}>
                  <Ionicons name="close" size={18} color="#8DAE73" />
                </TouchableOpacity>
              </View>

              <View style={s.helpSection}>
                <Text style={s.helpSectionTitle}>Political Leaning (← Left ↔ Right →)</Text>
                <Text style={s.helpBody}>
                  The horizontal axis represents the political perspective of news sources. Left side shows progressive viewpoints, right side shows conservative viewpoints.
                </Text>
              </View>

              <View style={s.helpSection}>
                <Text style={s.helpSectionTitle}>Reporting Style (↑ Hard News ↔ Opinion ↓)</Text>
                <Text style={s.helpBody}>
                  The vertical axis represents how factual vs. opinionated the coverage is. Higher is straight reporting and analysis. Lower is opinion pieces and commentary.
                </Text>
              </View>

              <View style={s.helpSection}>
                <Text style={s.helpSectionTitle}>How to Use</Text>
                <Text style={s.helpBody}>
                  Tap or drag on the map to set your position, and pinch with two fingers to grow or shrink your range — a larger circle draws from more diverse sources.
                </Text>
              </View>
            </ScrollView>
          </View>
        </View>
      ) : null}

      {showSaveDialog ? (
        <View style={s.modalWrap} pointerEvents="box-none">
          <View style={s.dialogCard}>
            <Text style={s.dialogTitle}>Save Preset</Text>
            <Text style={s.dialogDescription}>
              Give your personalized news configuration a name to save it as a preset.
            </Text>
            <TextInput
              value={digestName}
              onChangeText={setDigestName}
              placeholder="Preset name..."
              placeholderTextColor={PAGE.textMuted}
              style={s.dialogInput}
              autoFocus
            />
            <View style={s.dialogActions}>
              <TouchableOpacity
                style={s.dialogSecondaryButton}
                onPress={() => setShowSaveDialog(false)}
              >
                <Text style={s.dialogSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.dialogPrimaryButton,
                  !digestName.trim() && s.dialogPrimaryButtonDisabled,
                ]}
                disabled={!digestName.trim()}
                onPress={handleSavePreset}
              >
                <Text style={s.dialogPrimaryText}>Save Preset</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      {showSignInDialog ? (
        <View style={s.modalWrap} pointerEvents="box-none">
          <View style={s.dialogCard}>
            <Text style={s.dialogTitle}>Sign in to save presets</Text>
            <Text style={s.dialogDescription}>
              You can keep adjusting this filter, but you need an account to save presets for later.
            </Text>
            <View style={s.dialogActions}>
              <TouchableOpacity
                style={s.dialogSecondaryButton}
                onPress={() => setShowSignInDialog(false)}
              >
                <Text style={s.dialogSecondaryText}>Not now</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.dialogPrimaryButton}
                onPress={() => {
                  setShowSignInDialog(false);
                  router.push(buildHref('/login', { returnTo: '/graph' }));
                }}
              >
                <Text style={s.dialogPrimaryText}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      {shouldShowGraphOnboarding ? (
        <GraphOnboarding
          topicsRect={onboardingTopicsRect}
          graphRect={onboardingGraphRect}
          onComplete={() => void markGraphVisited()}
        />
      ) : null}

    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(34, 32, 29, 0.26)',
    zIndex: 70,
  },
  header: {
    height: 88,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  headerNarrow: {
    height: 76,
    paddingHorizontal: 10,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: PAGE.text,
    letterSpacing: -0.5,
  },
  headerTitleNarrow: { fontSize: 20 },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 92,
  },
  headerSideNarrow: { minWidth: 78, gap: 2 },
  headerIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signInBtn: {
    minHeight: 38,
    justifyContent: 'center',
    paddingRight: 8,
  },
  signInText: {
    fontSize: 15,
    fontWeight: '500',
    color: PAGE.text,
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
  streakText: {
    color: '#5F6A4F',
    fontSize: 14,
    fontWeight: '700',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 92,
    justifyContent: 'flex-end',
  },
  controls: {
    // This is a stable stage for the optional filter rows. The rows themselves
    // float below Search, so Trending can sit directly below it when there is
    // no active filter without changing the map's available space.
    height: 136,
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 2,
    gap: 8,
    zIndex: 20,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    zIndex: 25,
  },
  searchFieldWrap: {
    flex: 1,
    position: 'relative',
    zIndex: 60,
  },
  searchShell: {
    width: '100%',
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFFCF6',
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: PAGE.text,
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0E9DD',
    borderWidth: 1,
    borderColor: '#DDD4C5',
  },
  keyboardAccessory: {
    height: 42,
    backgroundColor: '#F7F3EA',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DDD4C5',
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  keyboardDoneButton: {
    minWidth: 56,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardDoneText: {
    color: '#58704E',
    fontSize: 16,
    fontWeight: '700',
  },
  saveButton: {
    height: 40,
    minWidth: 84,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
  },
  saveButtonText: {
    color: PAGE.textSoft,
    fontSize: 14,
    fontWeight: '500',
  },
  dropdownOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 46,
    zIndex: 60,
  },
  dropdown: {
    maxHeight: 320,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E7DECF',
    backgroundColor: '#FFFCF6',
    shadowColor: '#A39B8E',
    shadowOpacity: 0.16,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  dropdownContent: {
    padding: 12,
    gap: 12,
  },
  presetsBlock: {
    gap: 8,
  },
  presetsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  presetWrap: {
    position: 'relative',
    maxWidth: '100%',
    paddingTop: 4,
    paddingRight: 4,
  },
  presetChip: {
    maxWidth: 156,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#BCD2A8',
    backgroundColor: '#DCE9CA',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  presetChipText: {
    fontSize: 12.5,
    color: '#47513F',
    fontWeight: '600',
  },
  presetDelete: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#FBF7EF',
    borderWidth: 1,
    borderColor: '#DDD4C5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropdownSearchRow: {
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#E4DDD1',
    backgroundColor: '#F4EFE4',
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownSearchLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    paddingRight: 10,
  },
  dropdownSearchText: {
    fontSize: 14,
    color: PAGE.text,
    flexShrink: 1,
  },
  dropdownSearchTerm: {
    fontWeight: '600',
  },
  dropdownLabel: {
    fontSize: 12,
    color: PAGE.textMuted,
    fontWeight: '600',
    paddingHorizontal: 2,
  },
  dropdownTopicsBlock: {
    gap: 8,
  },
  dropdownTopics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    paddingBottom: 4,
  },
  dropdownTopicChip: {
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#E3DACB',
    backgroundColor: '#FFFCF6',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dropdownTopicText: {
    fontSize: 12.5,
    color: '#4C4740',
    fontWeight: '500',
  },
  emptyDropdownText: {
    fontSize: 13,
    color: PAGE.textMuted,
    paddingVertical: 8,
  },
  emptyDropdownCentered: {
    paddingVertical: 16,
    textAlign: 'center',
  },
  filterArea: {
    position: 'absolute',
    // Trending 6pt closer to the search box; the pill row 8 under trending;
    // HARD NEWS 12 under the pill row. "Less spaced" (Ayuka, 2026-09-17).
    top: 54,
    left: 18,
    right: 0,
    minHeight: 30,
    justifyContent: 'center',
    zIndex: 10,
  },
  selectedFiltersSection: {
    position: 'absolute',
    top: 92,
    left: 18,
    right: 0,
    minHeight: 36,
    justifyContent: 'center',
    zIndex: 10,
  },
  selectedFiltersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 24,
  },
  selectedTopicPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#DDD4C5',
    backgroundColor: '#F7F3EB',
  },
  selectedTrendingTopicPill: {
    borderColor: '#E9BF78',
    backgroundColor: '#F8E4B8',
  },
  selectedTopicText: {
    fontSize: 12,
    color: '#4C4740',
    fontWeight: '500',
  },
  selectedTrendingTopicText: {
    color: '#A56F2A',
    fontWeight: '600',
  },
  promptPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D9D1C3',
    backgroundColor: '#F4EFE6',
  },
  promptPillText: {
    fontSize: 12,
    color: '#706A62',
    fontWeight: '500',
  },
  topNewsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#F1C58A',
    backgroundColor: '#FAE9D2',
  },
  topNewsPillText: {
    fontSize: 12,
    color: '#D57A24',
    fontWeight: '600',
  },
  dailyDigestShortcutChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D9CFEB',
    backgroundColor: '#F7F2FC',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  dailyDigestShortcutText: { color: '#5F438E', fontSize: 12, fontWeight: '700' },
  topicRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingRight: 24,
    minHeight: 30,
  },
  topicRowLead: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 2,
  },
  topicChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 1,
  },
  topicChipText: {
    fontSize: 13.5,
    color: '#6E6962',
    fontWeight: '500',
  },
  topicChipPlus: {
    fontSize: 16,
    color: '#B4AEA6',
    fontWeight: '500',
  },
  graphSection: {
    flex: 1,
    minHeight: 0,
    flexShrink: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // 11pt a side lands the canvas at ~370 on a 393pt phone, his pick over
    // full bleed (2026-09-17): the readout still breathes under it. The
    // bottom padding is the floating bar's clearance (66 bar + 30 offset +
    // 16 gap), which the old Apply bar used to carry.
    paddingHorizontal: 11,
    // The selected-pill row under trending is reserved whether or not a
    // pill is showing: "I don't want the map to move ever" (Ayuka,
    // 2026-09-17, msg 1245). With the rows above pulled tighter, 24 is what
    // the HARD NEWS pill needs to clear the pill row by ~12, and the map
    // is width-bound at ~369 again.
    paddingTop: 24,
    // The page is a SafeAreaView, so its 34pt bottom inset already lifts
    // the content: clearance = bar 66 + offset 30 - inset 34 + 14 gap = 76.
    // 108 here left 44pt of dead air under Apply and cost the map 34pt,
    // measured on his build-127 screenshot (2026-09-18).
    paddingBottom: 76,
    position: 'relative',
    zIndex: 1,
  },
  modalWrap: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 80,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  helpModal: {
    width: '100%',
    maxHeight: '88%',
    borderRadius: 18,
    backgroundColor: '#F8F5EE',
    borderWidth: 1,
    borderColor: '#DDD4C5',
    shadowColor: '#312C26',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  helpModalContent: { paddingHorizontal: 22, paddingVertical: 20 },
  dialogCard: {
    width: '100%',
    borderRadius: 18,
    backgroundColor: '#F8F5EE',
    borderWidth: 1,
    borderColor: '#DDD4C5',
    paddingHorizontal: 22,
    paddingVertical: 20,
    shadowColor: '#312C26',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    gap: 14,
  },
  dialogTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#322E29',
  },
  dialogDescription: {
    fontSize: 13,
    lineHeight: 20,
    color: '#6A645C',
  },
  dialogInput: {
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD4C5',
    backgroundColor: '#FFFDF7',
    paddingHorizontal: 14,
    color: '#322E29',
    fontSize: 15,
  },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  dialogSecondaryButton: {
    height: 42,
    borderRadius: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#DDD4C5',
    backgroundColor: '#FFFDF7',
  },
  dialogSecondaryText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#5F5850',
  },
  dialogPrimaryButton: {
    height: 42,
    borderRadius: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2F2A24',
  },
  dialogPrimaryButtonDisabled: {
    opacity: 0.45,
  },
  dialogPrimaryText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FBF7EF',
  },
  helpHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14,
    marginBottom: 14,
  },
  helpTitleBlock: {
    flex: 1,
    gap: 4,
  },
  helpTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#322E29',
  },
  helpSubtitle: {
    fontSize: 13,
    color: '#8B847C',
  },
  helpCloseButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: '#B8C99E',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAF8F1',
  },
  helpSection: {
    gap: 6,
    marginBottom: 14,
  },
  helpSectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#322E29',
  },
  helpBody: {
    fontSize: 13,
    lineHeight: 21,
    color: '#5D5750',
  },
  helpButton: {
    position: 'absolute',
    right: 8,
    top: 6,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,253,247,0.88)',
    zIndex: 3,
  },
  graphWrap: {
    flex: 1,
    width: '100%',
    minHeight: 0,
    flexShrink: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    // Map + readout sit UP under the topic controls; spare space falls to
    // the bottom instead of becoming an awkward gap above the map
    // (Ayuka, 2026-09-15).
    justifyContent: 'flex-start',
    maxWidth: 620,
    paddingHorizontal: 0,
    paddingTop: 4,
    paddingBottom: 6,
  },
  graphCanvas: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  axisWord: {
    position: 'absolute',
  },
  axisPillText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 2,
    color: '#8A8272',
    textTransform: 'uppercase',
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(247,243,234,0.85)',
    overflow: 'hidden',
  },
  axisTopPill: {
    top: -21,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  axisBottomPill: {
    bottom: -21,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  axisLeftPill: {
    left: 0,
    top: '50%',
    transform: [{ translateY: -10 }],
  },
  axisRightPill: {
    right: 0,
    top: '50%',
    transform: [{ translateY: -10 }],
  },
  pinchHint: {
    position: 'absolute',
    bottom: 6,
    alignSelf: 'center',
    backgroundColor: 'rgba(46,42,37,0.82)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pinchHintText: {
    color: '#F7F3EA',
    fontSize: 11.5,
    fontWeight: '600',
  },
  sliderSection: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 18,
    alignItems: 'center',
    flexShrink: 0,
  },
  sliderInner: {
    width: '100%',
    maxWidth: 480,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 10,
  },
  // Apply's fixed slot under the map. Reserved even while idle (opacity 0,
  // no touches) so the canvas never moves when a change appears.
  applySlot: {
    alignSelf: 'stretch',
    marginHorizontal: 24,
    // The readout line above already clears the OPINION pill; 18 of air
    // between it and the 44pt button ("spaced out", Ayuka, 2026-09-18).
    marginTop: 18,
    height: 44,
  },
  applySlotIdle: {
    opacity: 0,
  },
  // Green and bigger than the axis pills so it reads as YOUR setting, not
  // more axis furniture — option B of the style renders (Ayuka,
  // 2026-09-19). 30 top margin clears the OPINION pill (21) with air.
  readoutText: {
    alignSelf: 'center',
    marginTop: 30,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    letterSpacing: 3,
    color: '#7A9A62',
    textTransform: 'uppercase',
  },
  applyButton: {
    pointerEvents: 'auto',
    alignSelf: 'stretch',
    height: 44,
    borderRadius: 14,
    backgroundColor: '#2F2A24',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2F2A24',
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  applyButtonDisabled: {
    opacity: 0.72,
  },
  applyButtonText: {
    fontSize: 14,
    color: '#FBF7EF',
    fontWeight: '700',
  },
  sliderLabel: {
    width: 50,
    fontSize: 14,
    color: PAGE.textMuted,
    fontWeight: '500',
    lineHeight: 14,
  },
  sliderTrackWrap: {
    justifyContent: 'center',
    paddingVertical: 13,
  },
  sliderTrack: {
    height: 8,
    borderRadius: 999,
    overflow: 'visible',
    justifyContent: 'center',
  },
  sliderFill: {
    height: 8,
    borderRadius: 999,
  },
  sliderThumb: {
    position: 'absolute',
    marginLeft: -14,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#F7F3EA',
    borderWidth: 1,
    top: -10,
    shadowColor: '#8DAE73',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  percentPill: {
    minWidth: 54,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    backgroundColor: 'transparent',
  },
  percentText: {
    fontSize: 14,
    color: PAGE.text,
    fontWeight: '500',
  },
});
