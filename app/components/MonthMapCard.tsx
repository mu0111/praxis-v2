import { useCallback, useRef, useState } from 'react';
import { Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { router, useFocusEffect } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { supabase } from '../services/supabase';

// "Your month on the map" — the ink window (design locked 2026-09-19):
// white card chrome, the map itself a dark panel, cream dots, one dot per
// article read this month, opacity = recency, tap = open the article.
// Copy rule: the headline states what the reader DID; a lopsided month gets
// a neutral line, never a corrective one.

const PANEL = 326;
const HALF = PANEL / 2;
const SPAN = 123; // dot field radius in px; coords are -1..1

const INK = '#2B2823';
const INK_LINE = '#454037';
const CREAM = '#EFE9DB';
const GREEN = '#7A9A62';

interface MonthDot {
  articleId: string;
  x: number;
  y: number;
  order: number; // 0 = most recent
}

interface MonthStats {
  reads: number;
  sources: number;
  leftReads: number;
  rightReads: number;
}

const monthStartIso = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
};

export function MonthMapCard() {
  const { user } = useAuth();
  const { c } = useTheme();
  const [dots, setDots] = useState<MonthDot[]>([]);
  const shotRef = useRef<View>(null);
  const [stats, setStats] = useState<MonthStats | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('analytics_events')
      .select('created_at, properties')
      .eq('user_id', user.id)
      .eq('event_name', 'article_read_complete')
      .gte('created_at', monthStartIso())
      .order('created_at', { ascending: false })
      .limit(1200);
    if (error || !data) return;

    const byArticle = new Map<string, { x: number | null; y: number | null; source: string | null; bias: number | null }>();
    for (const row of data) {
      const p = (row.properties ?? {}) as Record<string, unknown>;
      const id = typeof p.article_id === 'string' ? p.article_id : null;
      if (!id || byArticle.has(id)) continue; // rows are newest-first; keep latest
      byArticle.set(id, {
        x: typeof p.article_x === 'number' ? p.article_x : null,
        y: typeof p.article_y === 'number' ? p.article_y : null,
        source: typeof p.source === 'string' ? p.source : null,
        bias: typeof p.bias_score === 'number' ? p.bias_score : Number(p.bias_score) || null,
      });
    }

    const nextDots: MonthDot[] = [];
    let order = 0;
    const sources = new Set<string>();
    let leftReads = 0;
    let rightReads = 0;
    for (const [id, a] of byArticle) {
      if (a.source) sources.add(a.source.toLowerCase());
      if (typeof a.bias === 'number') {
        if (a.bias <= -15) leftReads += 1;
        if (a.bias >= 15) rightReads += 1;
      }
      if (a.x != null && a.y != null) {
        nextDots.push({ articleId: id, x: a.x, y: a.y, order: order++ });
      }
    }
    setDots(nextDots);
    setStats({ reads: byArticle.size, sources: sources.size, leftReads, rightReads });
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!user || !stats || stats.reads === 0) return null;

  const bothSides = stats.leftReads >= 2 && stats.rightReads >= 2;
  const headline = bothSides ? (
    <Text style={[s.insight, { color: c.text }]}>
      You read <Text style={{ color: GREEN }}>both sides</Text> this month.
    </Text>
  ) : (
    <Text style={[s.insight, { color: c.text }]}>Your month on the map.</Text>
  );

  const denom = Math.max(dots.length - 1, 1);

  // Share the map itself, not a sentence about it (Ayuka, 2026-09-20 msg
  // 1886): the panel (ink window + quadrant labels) is rasterised with
  // react-native-view-shot and handed to the share sheet as an image, with
  // the line as the caption. Falls back to text only if the capture fails.
  const onShare = async () => {
    const message = `My month on Praxis: ${stats.reads} reads from ${stats.sources} sources${bothSides ? ' — both sides' : ''}. praxisnews.co`;
    let url: string | null = null;
    try {
      if (shotRef.current) {
        url = await captureRef(shotRef, { format: 'png', quality: 1, result: 'tmpfile' });
      }
    } catch (error) {
      console.warn('[MonthMapCard] map capture failed, sharing text', error);
    }
    try {
      await Share.share(url ? { url, message } : { message });
    } catch {
      // The sheet was dismissed or unavailable; nothing to do.
    }
  };

  return (
    <View style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={s.head}>
        <Text style={[s.label, { color: c.text }]}>Your month</Text>
        <Text style={[s.lock, { color: c.textMuted }]}>ONLY YOU</Text>
      </View>

      <View ref={shotRef} collapsable={false} style={s.panelWrap}>
        <Svg width={PANEL} height={PANEL}>
          <Rect x={0} y={0} width={PANEL} height={PANEL} rx={14} fill={INK} />
          <Line x1={HALF} y1={40} x2={HALF} y2={PANEL - 40} stroke={INK_LINE} strokeWidth={1} />
          <Line x1={40} y1={HALF} x2={PANEL - 40} y2={HALF} stroke={INK_LINE} strokeWidth={1} />
          <Circle cx={HALF} cy={HALF} r={2} fill="#5A5344" />
          {dots.map((dot) => (
            <Circle
              key={dot.articleId}
              cx={HALF + dot.x * SPAN}
              cy={HALF - dot.y * SPAN}
              r={4.5}
              fill={CREAM}
              opacity={0.95 - 0.6 * (dot.order / denom)}
              onPress={() => router.push({ pathname: '/article/[id]', params: { id: dot.articleId } })}
            />
          ))}
        </Svg>
        <Text style={[s.quad, s.quadTop]}>HARD NEWS</Text>
        <Text style={[s.quad, s.quadBottom]}>OPINION</Text>
        <Text style={[s.quad, s.quadLeft]}>LEFT</Text>
        <Text style={[s.quad, s.quadRight]}>RIGHT</Text>
        {dots.length < 5 ? (
          <View style={s.emptyOverlay} pointerEvents="none">
            <Text style={s.emptyText}>Your map fills in as you read</Text>
          </View>
        ) : null}
      </View>

      {headline}
      <View style={s.foot}>
        <Text style={[s.stats, { color: c.textMuted }]}>
          <Text style={[s.statsStrong, { color: c.text }]}>{stats.reads}</Text> reads ·{' '}
          <Text style={[s.statsStrong, { color: c.text }]}>{stats.sources}</Text> sources
          {bothSides ? ' · both sides' : ''}
        </Text>
        <TouchableOpacity onPress={() => { void onShare(); }} accessibilityLabel="Share your month">
          <Text style={s.share}>Share ↗</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 18, padding: 16, marginTop: 12 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  label: { fontSize: 13, fontWeight: '800', letterSpacing: 0.2 },
  lock: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  panelWrap: { width: PANEL, height: PANEL, alignSelf: 'center', marginTop: 10 },
  quad: {
    position: 'absolute', fontSize: 8, fontWeight: '800', letterSpacing: 1.6, color: '#8E8877',
  },
  quadTop: { top: 8, alignSelf: 'center' },
  quadBottom: { bottom: 8, alignSelf: 'center' },
  quadLeft: { left: 10, top: HALF - 5 },
  quadRight: { right: 10, top: HALF - 5 },
  emptyOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#8E8877', fontSize: 12, fontWeight: '600' },
  insight: { fontSize: 17, fontWeight: '800', letterSpacing: -0.3, marginTop: 12 },
  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  stats: { fontSize: 12 },
  statsStrong: { fontWeight: '800' },
  share: { fontSize: 12.5, fontWeight: '800', color: GREEN },
});
