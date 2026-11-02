import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Switch, Text,
  TouchableOpacity, View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polyline } from 'react-native-svg';

import { ErrorBoundary } from '../components/ErrorBoundary';
import { PeopleOverview } from '../components/analytics/PeopleOverview';
import { useAuth } from '../context/AuthContext';
import { isAnalyticsAdmin } from '../lib/analyticsAccess';
import { supabase } from '../services/supabase';

type Timeframe = '7' | '28' | '90' | 'all';
type Grain = 'daily' | 'weekly' | 'monthly';

type DailyRow = {
  day: string;
  active_users: number | null;
  informed_engaged_users: number | null;
  informed_engagement_rate: number | null;
  ai_adopted_users: number | null;
  ai_adoption_rate: number | null;
  article_opens: number | null;
  articles_per_user: number | null;
  cross_spectrum_users: number | null;
  cross_spectrum_engagement_rate: number | null;
  ai_usage_0_users: number | null;
  ai_usage_1_users: number | null;
  ai_usage_2_3_users: number | null;
  ai_usage_4_plus_users: number | null;
};

type WeeklyRow = Omit<DailyRow, 'day' | 'active_users' | 'informed_engaged_users'> & {
  window_end_day: string;
  wau: number | null;
  informed_users: number | null;
};

type AggregateRow = {
  day: string;
  blended_active_users: number | null;
  new_signups: number | null;
  cumulative_signups: number | null;
  article_impressions: number | null;
  article_opens: number | null;
  article_read_completions: number | null;
  authenticated_active_users: number | null;
  ai_analysis_opens: number | null;
  feed_loads: number | null;
};

type SourceRow = {
  day: string;
  source: string;
  article_opens: number | null;
  article_read_completions: number | null;
  ai_analysis_opens: number | null;
};

type SeriesRow = {
  day: string;
  active: number;
  informed: number;
  informedRate: number;
  aiAdopted: number;
  aiRate: number;
  opens: number;
  opensPerUser: number;
  crossSpectrum: number;
  crossSpectrumRate: number;
};

const COLORS = {
  background: '#F7F3EA', card: '#FFFDF9', text: '#302C27', muted: '#7E766C',
  border: '#E3DACB', green: '#5F7D4D', greenSoft: '#E7F0DF', blue: '#285C8F', amber: '#D59A5B',
};
const TIMEFRAMES: { value: Timeframe; label: string; days: number | null }[] = [
  { value: '7', label: '7D', days: 7 }, { value: '28', label: '28D', days: 28 },
  { value: '90', label: '90D', days: 90 }, { value: 'all', label: 'All time', days: null },
];

const number = (value: number | null | undefined) => Number(value ?? 0);
const count = (value: number | null | undefined) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(number(value));
const rate = (value: number | null | undefined) => `${(number(value) * 100).toFixed(1)}%`;
const perUser = (value: number | null | undefined) => number(value).toFixed(2);
const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const subtractDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return dayKey(date);
};
const shortDate = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function Trend({ values, color = COLORS.green }: { values: number[]; color?: string }) {
  const points = useMemo(() => {
    if (!values.length) return '';
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const spread = Math.max(max - min, 1);
    return values.map((value, index) => {
      const x = values.length === 1 ? 140 : (index / (values.length - 1)) * 280;
      const y = 72 - ((value - min) / spread) * 60;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }, [values]);

  return (
    <View style={s.chartWrap}>
      <View style={[s.gridLine, { top: 16 }]} />
      <View style={[s.gridLine, { top: 42 }]} />
      <View style={[s.gridLine, { top: 68 }]} />
      <Svg width="100%" height={88} viewBox="0 0 280 88" preserveAspectRatio="none">
        <Polyline points={points} fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      </Svg>
    </View>
  );
}

function StatCard({ label, value, detail, prominent, delta }: { label: string; value: string; detail?: string; prominent?: boolean; delta?: number | null }) {
  return (
    <View style={[s.statCard, prominent && s.statCardProminent]}>
      <Text style={[s.statLabel, prominent && { color: COLORS.green }]}>{label}</Text>
      <View style={s.statValueRow}>
        <Text style={[s.statValue, prominent && { color: COLORS.green }]}>{value}</Text>
        {typeof delta === 'number' && delta !== 0 ? (
          <Text style={[s.statDelta, delta < 0 && s.statDeltaDown]}>
            {delta > 0 ? `▲ ${delta}` : `▼ ${Math.abs(delta)}`}
          </Text>
        ) : null}
      </View>
      {detail ? <Text style={s.statDetail}>{detail}</Text> : null}
    </View>
  );
}

// A render error on this admin screen shows a message here instead of taking down the app.
export default function AnalyticsScreen() {
  return (
    <ErrorBoundary
      fallback={(
        <SafeAreaView style={s.screen}><View style={s.restricted}><Ionicons name="alert-circle-outline" size={30} color={COLORS.green} /><Text style={s.restrictedTitle}>Analytics could not load</Text><Text style={s.restrictedCopy}>Something went wrong on this screen. The rest of the app is fine.</Text><TouchableOpacity style={s.backButton} onPress={() => router.back()}><Text style={s.backButtonText}>Back to Profile</Text></TouchableOpacity></View></SafeAreaView>
      )}
    >
      <AnalyticsDashboard />
    </ErrorBoundary>
  );
}

function AnalyticsDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [timeframe, setTimeframe] = useState<Timeframe>('28');
  // On by default: team accounts, test devices and deleted accounts are left out of every number
  // (the *_outside views, same as the website, 2026-10-31).
  const [outsideOnly, setOutsideOnly] = useState(true);
  const [overviewSettled, setOverviewSettled] = useState(false);
  const [grain, setGrain] = useState<Grain>('weekly');
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [weekly, setWeekly] = useState<WeeklyRow[]>([]);
  const [aggregates, setAggregates] = useState<AggregateRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [latestEvent, setLatestEvent] = useState<string | null>(null);
  const [actorDays, setActorDays] = useState<{ day: string; actor_key: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const authorized = isAnalyticsAdmin(user);

  const loadDashboard = async () => {
    if (!authorized) return;
    setLoading(true);
    setError(null);
    const scoped = (name: string) => (outsideOnly ? `${name}_outside` : name);
    // Every view scans the whole events table, so two at a time: more at once hits the 8s timeout.
    const [dailyResult, weeklyResult] = await Promise.all([
      supabase.from(scoped('analytics_behavior_kpis_daily')).select('*').order('day', { ascending: false }).limit(1000),
      supabase.from(scoped('analytics_behavior_kpis_weekly')).select('*').order('window_end_day', { ascending: false }).limit(1000),
    ]);
    const [aggregateResult, sourceResult] = await Promise.all([
      supabase.from(scoped('analytics_kpi_daily')).select('*').order('day', { ascending: false }).limit(1000),
      supabase.from(scoped('analytics_source_engagement')).select('*').order('day', { ascending: false }).limit(5000),
    ]);
    const [latestResult, actorResult] = await Promise.all([
      supabase.from(scoped('analytics_events')).select('created_at').order('created_at', { ascending: false }).limit(1),
      supabase.from(scoped('analytics_user_day_metrics')).select('day,actor_key').order('day', { ascending: false }).limit(20000),
    ]);
    const failed = [dailyResult, weeklyResult, aggregateResult, sourceResult, latestResult, actorResult].find((result) => result.error)?.error;
    if (failed) {
      setError(failed.message);
    } else {
      setDaily((dailyResult.data ?? []) as DailyRow[]);
      setWeekly((weeklyResult.data ?? []) as WeeklyRow[]);
      setAggregates((aggregateResult.data ?? []) as AggregateRow[]);
      setSources((sourceResult.data ?? []) as SourceRow[]);
      setLatestEvent((latestResult.data?.[0] as { created_at?: string } | undefined)?.created_at ?? null);
      setActorDays((actorResult.data ?? []) as { day: string; actor_key: string }[]);
    }
    setLoading(false);
  };

  // The people card loads first so it has the database to itself, then the sections below.
  useEffect(() => { if (overviewSettled) void loadDashboard(); }, [authorized, outsideOnly, overviewSettled]);

  const cutoff = useMemo(() => {
    const days = TIMEFRAMES.find((item) => item.value === timeframe)?.days;
    return days ? subtractDays(days - 1) : null;
  }, [timeframe]);
  const filteredDaily = useMemo(() => daily.filter((row) => !cutoff || row.day >= cutoff).sort((a, b) => a.day.localeCompare(b.day)), [cutoff, daily]);
  const filteredWeekly = useMemo(() => weekly.filter((row) => !cutoff || row.window_end_day >= cutoff).sort((a, b) => a.window_end_day.localeCompare(b.window_end_day)), [cutoff, weekly]);
  const series = useMemo<SeriesRow[]>(() => {
    if (grain === 'daily') return filteredDaily.map((row) => ({
      day: row.day, active: number(row.active_users), informed: number(row.informed_engaged_users), informedRate: number(row.informed_engagement_rate),
      aiAdopted: number(row.ai_adopted_users), aiRate: number(row.ai_adoption_rate), opens: number(row.article_opens), opensPerUser: number(row.articles_per_user),
      crossSpectrum: number(row.cross_spectrum_users), crossSpectrumRate: number(row.cross_spectrum_engagement_rate),
    }));
    if (grain === 'weekly') return filteredWeekly.map((row) => ({
      day: row.window_end_day, active: number(row.wau), informed: number(row.informed_users), informedRate: number(row.informed_engagement_rate),
      aiAdopted: number(row.ai_adopted_users), aiRate: number(row.ai_adoption_rate), opens: number(row.article_opens), opensPerUser: number(row.articles_per_user),
      crossSpectrum: number(row.cross_spectrum_users), crossSpectrumRate: number(row.cross_spectrum_engagement_rate),
    }));
    const byMonth = new Map<string, SeriesRow[]>();
    filteredWeekly.forEach((row) => {
      const item: SeriesRow = { day: row.window_end_day, active: number(row.wau), informed: number(row.informed_users), informedRate: number(row.informed_engagement_rate), aiAdopted: number(row.ai_adopted_users), aiRate: number(row.ai_adoption_rate), opens: number(row.article_opens), opensPerUser: number(row.articles_per_user), crossSpectrum: number(row.cross_spectrum_users), crossSpectrumRate: number(row.cross_spectrum_engagement_rate) };
      const key = row.window_end_day.slice(0, 7);
      byMonth.set(key, [...(byMonth.get(key) ?? []), item]);
    });
    return Array.from(byMonth.values()).map((rows) => rows[rows.length - 1]);
  }, [filteredDaily, filteredWeekly, grain]);
  const current = series.at(-1);
  const filteredAggregates = useMemo(() => aggregates.filter((row) => !cutoff || row.day >= cutoff), [aggregates, cutoff]);
  const overview = useMemo(() => ({
    // Distinct people in the window, same as the website (was the busiest single day's count).
    users: new Set(actorDays.filter((row) => !cutoff || row.day >= cutoff).map((row) => row.actor_key)).size,
    opens: filteredAggregates.reduce((sum, row) => sum + number(row.article_opens), 0),
    ai: filteredAggregates.reduce((sum, row) => sum + number(row.ai_analysis_opens), 0),
    signups: filteredAggregates.reduce((sum, row) => sum + number(row.new_signups), 0),
    totalSignups: number(aggregates[0]?.cumulative_signups),
    impressions: filteredAggregates.reduce((sum, row) => sum + number(row.article_impressions), 0),
    loads: filteredAggregates.reduce((sum, row) => sum + number(row.feed_loads), 0),
  }), [actorDays, aggregates, cutoff, filteredAggregates]);
  // Window-over-window deltas on the tiles (Ayuka, 2026-09-19, msg 1506). The previous window is
  // the equal-length stretch right before the selected one; "All time" has no meaningful
  // predecessor, so deltas hide there.
  const deltas = useMemo(() => {
    const days = TIMEFRAMES.find((item) => item.value === timeframe)?.days;
    if (!days || !cutoff) return null;
    const prevCutoff = subtractDays(2 * days - 1);
    const prev = aggregates.filter((row) => row.day >= prevCutoff && row.day < cutoff);
    if (prev.length === 0) return null;
    return {
      users: overview.users - new Set(actorDays.filter((row) => row.day >= prevCutoff && row.day < cutoff).map((row) => row.actor_key)).size,
      opens: overview.opens - prev.reduce((sum, row) => sum + number(row.article_opens), 0),
      ai: overview.ai - prev.reduce((sum, row) => sum + number(row.ai_analysis_opens), 0),
      signups: overview.signups - prev.reduce((sum, row) => sum + number(row.new_signups), 0),
    };
  }, [actorDays, aggregates, cutoff, overview, timeframe]);
  const topSources = useMemo(() => {
    const grouped = new Map<string, { source: string; opens: number; reads: number; ai: number }>();
    sources.filter((row) => !cutoff || row.day >= cutoff).forEach((row) => {
      const entry = grouped.get(row.source) ?? { source: row.source, opens: 0, reads: 0, ai: 0 };
      entry.opens += number(row.article_opens); entry.reads += number(row.article_read_completions); entry.ai += number(row.ai_analysis_opens);
      grouped.set(row.source, entry);
    });
    return Array.from(grouped.values()).sort((a, b) => b.reads + b.ai - (a.reads + a.ai)).slice(0, 8);
  }, [cutoff, sources]);

  if (!authLoading && !authorized) {
    return (
      <SafeAreaView style={s.screen}><View style={s.restricted}><Ionicons name="lock-closed-outline" size={30} color={COLORS.green} /><Text style={s.restrictedTitle}>Analytics access restricted</Text><Text style={s.restrictedCopy}>This dashboard is available only to configured Praxis analytics admins.</Text><TouchableOpacity style={s.backButton} onPress={() => router.back()}><Text style={s.backButtonText}>Back to Profile</Text></TouchableOpacity></View></SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadDashboard()} tintColor={COLORS.green} />}>
        <View style={s.headerRow}><TouchableOpacity onPress={() => router.back()} style={s.iconButton}><Ionicons name="arrow-back" size={20} color={COLORS.text} /></TouchableOpacity><TouchableOpacity onPress={() => void loadDashboard()} style={s.iconButton} accessibilityLabel="Refresh analytics"><Ionicons name="refresh" size={20} color={COLORS.green} /></TouchableOpacity></View>
        <View style={s.titleRow}><View style={s.titleIcon}><Ionicons name="bar-chart-outline" size={24} color={COLORS.green} /></View><View style={{ flex: 1 }}><Text style={s.title}>Praxis KPI Dashboard</Text><Text style={s.subtitle}>Are users engaging with content, using AI, and exploring multiple perspectives?</Text></View></View>
        <View style={s.controls}><View style={s.switchRow}><Switch value={outsideOnly} onValueChange={(value) => { setOverviewSettled(false); setOutsideOnly(value); }} trackColor={{ true: COLORS.green }} /><View style={{ flex: 1 }}><Text style={s.switchLabel}>Outside people only</Text><Text style={s.freshness}>{outsideOnly ? 'No team, cofounders or test phones' : 'Team and test phones included'}</Text></View></View><Text style={s.freshness}>Freshness: {latestEvent ? new Date(latestEvent).toLocaleString() : 'Collecting data'}</Text></View>
        {authorized ? <PeopleOverview outsideOnly={outsideOnly} onSettled={() => setOverviewSettled(true)} onTeamChanged={() => void loadDashboard()} /> : null}
        {error ? <View style={s.error}><Text style={s.errorText}>Dashboard failed to load: {error}</Text></View> : null}
        {loading && !daily.length ? <ActivityIndicator size="large" color={COLORS.green} style={{ marginVertical: 56 }} /> : <>
          <View style={s.controls}><Text style={s.controlLabel}>Window</Text><View style={s.pills}>{TIMEFRAMES.map((item) => <TouchableOpacity key={item.value} onPress={() => setTimeframe(item.value)} style={[s.pill, timeframe === item.value && s.pillActive]}><Text style={[s.pillText, timeframe === item.value && s.pillTextActive]}>{item.label}</Text></TouchableOpacity>)}</View></View>
          <View style={s.sectionShell}><Text style={s.sectionTitle}>Aggregate Overview</Text><Text style={s.sectionDescription}>How much total activity happened in this selected window.</Text><View style={s.statGrid}><StatCard label="All Visitors" value={count(overview.users)} detail="Quick visits included" delta={deltas?.users} /><StatCard label="Total Article Opens" value={count(overview.opens)} delta={deltas?.opens} /><StatCard label="Total AI Insights" value={count(overview.ai)} delta={deltas?.ai} /><StatCard label="New Signups" value={count(overview.signups)} delta={deltas?.signups} /><StatCard label="Total Signups" value={count(overview.totalSignups)} /><StatCard label="Impressions" value={count(overview.impressions)} /><StatCard label="Feed Loads" value={count(overview.loads)} /><StatCard label="Loads per User" value={perUser(overview.users ? overview.loads / overview.users : 0)} /></View></View>
          <View style={[s.sectionShell, s.behaviorShell]}><Text style={s.sectionTitle}>User Behavior</Text><Text style={s.sectionDescription}>Core per-user KPIs for people who are active in Praxis.</Text><View style={s.pills}>{(['monthly', 'weekly', 'daily'] as Grain[]).map((item) => <TouchableOpacity key={item} onPress={() => setGrain(item)} style={[s.pill, grain === item && s.pillActive]}><Text style={[s.pillText, grain === item && s.pillTextActive]}>{item[0].toUpperCase() + item.slice(1)}</Text></TouchableOpacity>)}</View><View style={s.statGrid}><StatCard prominent label="North Star: Informed Engagement" value={rate(current?.informedRate)} detail={`${count(current?.informed)} / ${count(current?.active)} users`} /><StatCard label={`${grain === 'monthly' ? 'Monthly' : grain === 'weekly' ? 'Weekly' : 'Daily'} Active Users`} value={count(current?.active)} /><StatCard label="AI Adoption" value={rate(current?.aiRate)} detail={`${count(current?.aiAdopted)} users`} /><StatCard label="Articles per User" value={perUser(current?.opensPerUser)} /><StatCard label="Cross-Spectrum" value={rate(current?.crossSpectrumRate)} detail={`${count(current?.crossSpectrum)} users`} /></View></View>
          <Text style={s.sectionTitle}>Scale</Text><Text style={s.sectionDescription}>Trusted active-user timelines over the selected timeframe.</Text><View style={s.panel}><Text style={s.panelTitle}>{grain === 'monthly' ? 'MAU' : grain === 'weekly' ? 'WAU' : 'DAU'} Trend</Text><Text style={s.panelDescription}>Active users by the selected reporting grain.</Text><Trend values={series.map((row) => row.active)} /><Text style={s.chartCaption}>{series.length ? `${shortDate(series[0].day)} to ${shortDate(series.at(-1)!.day)}` : 'No data yet'}</Text></View>
          <Text style={s.sectionTitle}>Behavior</Text><Text style={s.sectionDescription}>The KPI layer that measures content, AI understanding, and perspective broadening.</Text><View style={s.chartGrid}>{[{ label: 'Informed Engagement Rate', values: series.map((row) => row.informedRate * 100) }, { label: 'AI Adoption Rate', values: series.map((row) => row.aiRate * 100) }, { label: 'Articles per User', values: series.map((row) => row.opensPerUser) }, { label: 'Cross-Spectrum Rate', values: series.map((row) => row.crossSpectrumRate * 100) }].map((chart) => <View key={chart.label} style={s.panel}><Text style={s.panelTitle}>{chart.label}</Text><Trend values={chart.values} /><Text style={s.chartCaption}>Current: {chart.values.length ? chart.values.at(-1)?.toFixed(1) : '0.0'}</Text></View>)}</View>
          <Text style={s.sectionTitle}>Top Sources by Read + AI Engagement</Text><View style={s.panel}>{topSources.length ? topSources.map((source, index) => <View style={[s.sourceRow, index > 0 && s.sourceBorder]} key={source.source}><Text style={s.sourceName} numberOfLines={1}>{source.source}</Text><Text style={s.sourceMetric}>{count(source.opens)} opens</Text><Text style={s.sourceMetric}>{count(source.reads)} reads</Text><Text style={s.sourceMetric}>{count(source.ai)} AI</Text></View>) : <Text style={s.panelDescription}>No source engagement data in this timeframe.</Text>}</View>
        </>}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background }, content: { padding: 16, paddingBottom: 48, gap: 14 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }, iconButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border },
  titleRow: { flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 6 }, titleIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.greenSoft }, title: { color: COLORS.text, fontSize: 25, fontWeight: '800', letterSpacing: -0.6 }, subtitle: { color: COLORS.muted, marginTop: 4, fontSize: 13, lineHeight: 19 },
  controls: { backgroundColor: COLORS.card, borderColor: COLORS.border, borderWidth: 1, borderRadius: 20, padding: 14, gap: 10 }, controlLabel: { color: COLORS.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase' }, freshness: { color: COLORS.muted, fontSize: 12 }, switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, switchLabel: { color: COLORS.text, fontSize: 14, fontWeight: '800' }, pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, pill: { borderWidth: 1, borderColor: COLORS.border, backgroundColor: '#FAF7F0', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 }, pillActive: { backgroundColor: COLORS.green, borderColor: COLORS.green }, pillText: { color: COLORS.muted, fontSize: 12, fontWeight: '700' }, pillTextActive: { color: '#FFFDF9' },
  sectionShell: { backgroundColor: '#FCF8F0', borderColor: COLORS.border, borderWidth: 1, borderRadius: 24, padding: 16, gap: 10, marginTop: 6 }, behaviorShell: { backgroundColor: '#EEF5E8', borderColor: '#CFE0C3' }, sectionTitle: { color: COLORS.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.2, marginTop: 8 }, sectionDescription: { color: COLORS.muted, fontSize: 13, lineHeight: 19, marginBottom: 3 }, statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  // flexBasis + flexGrow, not a % width: 48.7% + the 9px gap overflowed the
  // row by a hair on device and every tile wrapped to its own line — the
  // half-width single-column mess in his screenshot (Ayuka, 2026-09-19).
  statCard: { flexBasis: '44%', flexGrow: 1, minHeight: 84, borderRadius: 18, padding: 13, justifyContent: 'space-between', backgroundColor: COLORS.card, borderColor: '#EDE5D8', borderWidth: 1 }, statCardProminent: { backgroundColor: '#F6FBF1', borderColor: '#B8CEA5' }, statLabel: { color: COLORS.muted, fontSize: 10, lineHeight: 14, fontWeight: '800', letterSpacing: .6, textTransform: 'uppercase' }, statValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 7 }, statValue: { color: COLORS.text, fontSize: 27, fontWeight: '800', letterSpacing: -1 }, statDelta: { color: COLORS.green, fontSize: 12, fontWeight: '800' }, statDeltaDown: { color: '#B0684F' }, statDetail: { color: COLORS.muted, fontSize: 11, lineHeight: 15 },
  panel: { borderWidth: 1, borderColor: '#E7DED1', backgroundColor: COLORS.card, borderRadius: 20, padding: 15, gap: 7 }, panelTitle: { color: COLORS.text, fontSize: 16, fontWeight: '800' }, panelDescription: { color: COLORS.muted, fontSize: 12, lineHeight: 18 }, chartWrap: { height: 88, position: 'relative', marginTop: 7 }, gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#ECE5DA' }, chartCaption: { color: COLORS.muted, fontSize: 11 }, chartGrid: { gap: 11 }, sourceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 7 }, sourceBorder: { borderTopWidth: 1, borderTopColor: '#EEE7DB' }, sourceName: { flex: 1.25, color: COLORS.text, fontSize: 12, fontWeight: '700' }, sourceMetric: { flex: .72, color: COLORS.muted, fontSize: 10, textAlign: 'right' }, error: { backgroundColor: '#FBE9E5', borderColor: '#E9B8AC', borderWidth: 1, borderRadius: 15, padding: 13 }, errorText: { color: '#A94734', fontSize: 13, lineHeight: 18 },
  restricted: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 }, restrictedTitle: { color: COLORS.text, fontSize: 22, fontWeight: '800', textAlign: 'center' }, restrictedCopy: { color: COLORS.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' }, backButton: { marginTop: 4, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 14, backgroundColor: COLORS.green }, backButtonText: { color: '#FFFDF9', fontWeight: '800' },
});
