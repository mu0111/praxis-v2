import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, Image, Alert, ActivityIndicator, InteractionManager} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../services/supabase';
import { useAuth } from '../context/AuthContext';
import {
  ReadingActivitySummary,
  readReadingActivitySummary,
  subscribeReadingActivity,
} from '../lib/readingActivity';
import {
  readDigestPresets,
  subscribeDigestPresets,
} from '../lib/newsPreferences';
import { readSavedArticles, subscribeSavedArticles } from '../lib/savedArticles';
import { buildHref } from '../lib/buildHref';
import { isAnalyticsAdmin } from '../lib/analyticsAccess';
import { MonthMapCard } from '../components/MonthMapCard';

interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  tier: string;
  requirement_value: number;
}

interface EarnedBadge {
  badge_id: string;
  earned_at: string;
}

const EMPTY_ACTIVITY: ReadingActivitySummary = {
  totalArticlesRead: 0,
  currentStreak: 0,
  readsToday: 0,
  readsThisWeek: 0,
  weekBuckets: [],
  topTopics: [],
};

const CATEGORY_COLORS: Record<string, { background: string; text: string; border: string }> = {
  reading: { background: '#E8EEF9', text: '#3768B5', border: '#C7D6EE' },
  streak: { background: '#FBEADF', text: '#D97849', border: '#F0C7B2' },
  exploration: { background: '#F1E8FA', text: '#9863CB', border: '#DCC7EF' },
  engagement: { background: '#E5F1E3', text: '#668F55', border: '#C8DEC2' },
};

const BADGE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  reading: 'book-outline',
  streak: 'flame-outline',
  exploration: 'compass-outline',
  engagement: 'people-outline',
};

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

export default function ProfileScreen() {
  const { isGuestMode, loading, profile, user } = useAuth();
  const scrollRef = useRef<ScrollView>(null);
  const [allBadges, setAllBadges] = useState<BadgeDefinition[]>([]);
  const [earnedBadges, setEarnedBadges] = useState<EarnedBadge[]>([]);
  const [badgesLoading, setBadgesLoading] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [digestCount, setDigestCount] = useState(0);
  const [activity, setActivity] = useState<ReadingActivitySummary>(EMPTY_ACTIVITY);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [userRank, setUserRank] = useState<number | null>(null);
  const c = {
    background: '#F7F3EA',
    card: '#FBF7F0',
    surface: '#FFFDFC',
    secondary: '#EFE6D6',
    text: '#2E2A25',
    textSecondary: '#5D554C',
    textMuted: '#8E857A',
    tint: '#D9802E',
    border: '#E7DEC9',
    icon: '#736A61',
    destructive: '#B8513A',
  };

  useEffect(() => {
    if (loading) return;
    if (isGuestMode || !user || !profile) {
      router.replace(buildHref('/login', { returnTo: '/profile' }));
    }
  }, [isGuestMode, loading, profile, user]);

  useEffect(() => {
    if (!profile?.id) return;
    let isActive = true;
    setBadgesLoading(true);

    // Let the tab transition finish before the badge/rank queries fire —
    // running them during the animation is what made opening Profile stutter.
    const task = InteractionManager.runAfterInteractions(() => {
    void Promise.all([
      supabase
        .from('badges')
        .select('id, name, description, icon, category, tier, requirement_value')
        .order('requirement_value', { ascending: true }),
      supabase
        .from('user_badges')
        .select('badge_id, earned_at')
        .eq('user_id', profile.id)
        .order('earned_at', { ascending: false }),
      supabase
        .from('profiles')
        .select('id, articles_read')
        .order('articles_read', { ascending: false })
        .limit(100),
    ]).then(([catalogResult, earnedResult, rankingResult]) => {
      if (!isActive) return;
      setAllBadges((catalogResult.data ?? []) as BadgeDefinition[]);
      setEarnedBadges((earnedResult.data ?? []) as EarnedBadge[]);
      const rankIndex = (rankingResult.data ?? []).findIndex((entry: any) => entry.id === profile.id);
      setUserRank(rankIndex >= 0 ? rankIndex + 1 : null);
      setBadgesLoading(false);
    }).catch((error) => {
      console.warn('[ProfileScreen] Failed to load profile achievements', error);
      if (isActive) setBadgesLoading(false);
    });
    });

    return () => {
      task.cancel();
      isActive = false;
    };
  }, [profile?.id]);

  const loadDigestCount = useCallback(() => {
    try {
      setDigestCount(readDigestPresets(user?.id ?? null).length);
    } catch (error) {
      console.warn('[ProfileScreen] Failed to read digest presets', error);
      setDigestCount(0);
    }
  }, [user?.id]);

  useEffect(() => {
    let isActive = true;

    void readSavedArticles(user?.id).then((articles) => {
      if (!isActive) return;
      setSavedCount(articles.length);
    });

    const unsubscribe = subscribeSavedArticles(user?.id, (articles) => {
      setSavedCount(articles.length);
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [user?.id]);

  useEffect(() => {
    let isActive = true;

    void readReadingActivitySummary(user?.id).then((summary) => {
      if (!isActive) return;
      setActivity(summary);
    });

    const unsubscribe = subscribeReadingActivity(user?.id, (summary) => {
      setActivity(summary);
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [user?.id]);

  useEffect(() => {
    loadDigestCount();

    const unsubscribe = subscribeDigestPresets(user?.id ?? null, (digests) => {
      setDigestCount(digests.length);
    });

    return unsubscribe;
  }, [loadDigestCount, user?.id]);

  const handleReadingActivityPress = () => {
    router.push('/modal/reading-activity');
  };

  if (loading || isGuestMode || !user || !profile) return null;

  const displayName = profile.full_name ?? profile.username ?? 'Reader';
  const canAccessAnalytics = isAnalyticsAdmin(user);
  const displayBio = profile.bio ?? 'No bio yet';
  const displayArticlesRead = Math.max(profile.articles_read ?? 0, activity.totalArticlesRead);
  const displayStreak = profile.current_streak ?? 0;
  const badgeCount = earnedBadges.length;
  const followersCount = profile.followers ?? profile.followers_count ?? 0;
  const followingCount = profile.following ?? profile.following_count ?? 0;
  const insightTopics = activity.topTopics.length > 0
    ? activity.topTopics
    : (profile.topics ?? []).slice(0, 7).map((topic) => ({ topic, count: 0 }));

  return (
    <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={[s.headerButton, { borderColor: c.border, backgroundColor: c.surface }]}>
            <Ionicons name="arrow-back" size={20} color={c.text} />
          </TouchableOpacity>
          <View style={s.topBarActions}>
            {canAccessAnalytics ? (
              <TouchableOpacity
                style={[s.analyticsButton, { backgroundColor: c.surface, borderColor: c.border }]}
                onPress={() => router.push('/modal/analytics' as any)}
                accessibilityLabel="Open Praxis KPI dashboard"
              >
                <Ionicons name="bar-chart-outline" size={18} color={c.text} />
                <Text style={[s.analyticsButtonText, { color: c.text }]}>Analytics</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[s.leaderboardButton, { backgroundColor: '#8EAF72' }]}
              onPress={() => router.push('/modal/leaderboard')}
              accessibilityLabel="Open leaderboard"
            >
              <Ionicons name="trophy-outline" size={18} color="#FFFDF8" />
              <Text style={s.leaderboardButtonText}>Leaderboard</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={s.profileSection}>
          <TouchableOpacity onPress={() => router.push('/modal/edit-profile')} activeOpacity={0.85}>
            <View style={[s.avatar, { backgroundColor: c.secondary, borderColor: c.border }]}>
              {profile.avatar_url
                ? <Image source={{ uri: profile.avatar_url }} style={s.avatarImg} />
                : <Text style={[s.avatarInitial, { color: c.text }]}>
                    {displayName[0]?.toUpperCase() ?? '?'}
                  </Text>
              }
            </View>
          </TouchableOpacity>
          <View style={s.profileCopy}>
            <Text style={[s.name, { color: c.text }]}>
              {displayName}
            </Text>
            <View style={s.usernameRow}>
              <Text style={[s.username, { color: c.textMuted }]}>@{profile.username ?? 'reader'}</Text>
              {userRank ? (
                <View style={[s.metaBadge, { backgroundColor: c.secondary, borderColor: c.border }]}>
                  <Ionicons name="trophy-outline" size={13} color={c.textMuted} />
                  <Text style={[s.metaBadgeText, { color: c.text }]}>#{userRank}</Text>
                </View>
              ) : null}
              {displayStreak > 0 ? (
                <View style={[s.metaBadge, { backgroundColor: '#FBEADF', borderColor: '#F0C7B2' }]}>
                  <Ionicons name="flame-outline" size={13} color="#D97849" />
                  <Text style={[s.metaBadgeText, { color: '#C76538' }]}>{displayStreak}</Text>
                </View>
              ) : null}
            </View>
          </View>
          <TouchableOpacity
            style={[s.settingsButton, { borderColor: c.border, backgroundColor: c.surface }]}
            onPress={() => router.push('/modal/account-settings' as any)}
            accessibilityLabel="Open account settings"
          >
            <Ionicons name="settings-outline" size={20} color={c.textMuted} />
          </TouchableOpacity>
        </View>

        <Text style={[s.bio, { color: c.textSecondary }]}>{displayBio}</Text>


        <View style={s.statsGridWrap}>
          {[
            {
              icon: 'people-outline', label: 'Followers', value: followersCount,
              onPress: () => router.push({ pathname: '/modal/follow-list', params: { type: 'followers', userId: user.id } } as any),
            },
            {
              icon: 'people-outline', label: 'Following', value: followingCount,
              onPress: () => router.push({ pathname: '/modal/follow-list', params: { type: 'following', userId: user.id } } as any),
            },
            {
              icon: 'book-outline', label: 'Articles Read', value: displayArticlesRead, accent: true,
              onPress: handleReadingActivityPress,
            },
            {
              icon: 'trophy-outline', label: 'Achievements', value: badgeCount, accent: true,
              onPress: () => router.push('/modal/achievements' as any),
            },
          ].map((item) => (
            <TouchableOpacity
              key={item.label}
              style={[s.metricCard, { backgroundColor: c.card, borderColor: c.border }]}
              onPress={item.onPress}
              activeOpacity={0.82}
              accessibilityLabel={`Open ${item.label.toLowerCase()}`}
            >
              <View style={s.metricHeader}>
                <Ionicons name={item.icon as any} size={20} color="#8EAF72" />
                <Text style={[s.metricLabel, { color: item.accent ? '#8EAF72' : c.textMuted }]}>{item.label}</Text>
              </View>
              <Text style={[s.metricValue, { color: c.text }]}>{formatCompactNumber(item.value)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[s.insightsCard, { backgroundColor: c.card, borderColor: c.border }]}
          onPress={() => setInsightsOpen((value) => !value)}
        >
          <View>
            <Text style={[s.insightsTitle, { color: c.text }]}>Reading Insights</Text>
            <Text style={[s.insightsSubtitle, { color: c.textMuted }]}>
              {insightTopics.length} topics • {activity.readsThisWeek} reads this week
            </Text>
          </View>
          <Ionicons
            name={insightsOpen ? 'chevron-up' : 'chevron-down'}
            size={24}
            color={c.textMuted}
          />
        </TouchableOpacity>

        {insightsOpen ? (
          <View style={[s.insightsDetailCard, { backgroundColor: c.card, borderColor: c.border }]}>
            <View style={s.insightSectionHeader}>
              <Text style={[s.insightSectionTitle, { color: c.text }]}>Most Read Topics</Text>
              <Text style={[s.insightPeriod, { color: c.textMuted }]}>Recent activity</Text>
            </View>
            {insightTopics.length > 0 ? (
              <View style={s.topicPillGrid}>
                {insightTopics.map((topic, index) => (
                  <View
                    key={topic.topic}
                    style={[
                      s.readingTopicPill,
                      {
                        backgroundColor: index === 0 ? '#8EAF72' : c.secondary,
                        borderColor: index === 0 ? '#8EAF72' : c.border,
                      },
                    ]}
                  >
                    <Text style={[s.readingTopicText, { color: index === 0 ? '#FFFDF8' : c.text }]}>
                      {topic.topic}
                    </Text>
                    {topic.count > 0 ? (
                      <Text style={[s.readingTopicCount, { color: index === 0 ? '#F1F7EB' : c.textMuted }]}>
                        {topic.count}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : (
              <Text style={[s.insightBody, { color: c.textSecondary }]}>
                Read a few stories and your most-read topics will appear here.
              </Text>
            )}
            <View style={s.insightMetricGrid}>
              {[
                { label: 'Today', value: activity.readsToday },
                { label: 'This week', value: activity.readsThisWeek },
                { label: 'Saved', value: savedCount },
                { label: 'Digests', value: digestCount },
              ].map((metric) => (
                <View key={metric.label} style={[s.insightMetric, { backgroundColor: c.surface, borderColor: c.border }]}>
                  <Text style={[s.insightMetricValue, { color: c.text }]}>{metric.value}</Text>
                  <Text style={[s.insightMetricLabel, { color: c.textMuted }]}>{metric.label}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}



        <MonthMapCard name={profile.full_name?.trim().split(/\s+/)[0] || profile.username || undefined} />
        {/* The floating tab bar overlays the scroll (66pt capsule + offset); at 32 the
            month card's stats/Share rode under it (Ayuka, msgs 1704, 1979). */}
        <View style={{ height: 116 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBarActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  analyticsButton: {
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  analyticsButtonText: { fontSize: 15, fontWeight: '700' },
  leaderboardButton: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#5B6D43',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 4,
  },
  leaderboardButtonText: { fontSize: 15, fontWeight: '800', color: '#FFFDF8' },
  profileSection: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 18,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 2,
  },
  avatarImg: { width: 88, height: 88 },
  avatarInitial: { fontSize: 34, fontWeight: '700', color: '#8EAF72' },
  profileCopy: { gap: 10, flex: 1, paddingTop: 6 },
  name: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  username: { fontSize: 14, fontWeight: '600' },
  metaBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaBadgeText: { fontSize: 12, fontWeight: '700' },
  bio: { fontSize: 15, lineHeight: 23, marginHorizontal: 20, marginTop: 12, marginBottom: 8 },
  settingsButton: {
    width: 44,
    height: 44,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  statsGridWrap: {
    paddingHorizontal: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 14,
  },
  metricCard: {
    width: '48%',
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    minHeight: 116,
    justifyContent: 'space-between',
    shadowColor: '#B4AA98',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 3,
  },
  metricHeader: { gap: 12 },
  metricLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' },
  metricValue: { fontSize: 30, fontWeight: '800' },
  insightsCard: {
    marginHorizontal: 20,
    marginTop: 18,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  insightsTitle: { fontSize: 17, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  insightsSubtitle: { fontSize: 13, marginTop: 6 },
  insightsDetailCard: {
    marginHorizontal: 20,
    marginTop: 12,
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
  },
  insightBody: { fontSize: 14, lineHeight: 21 },
  insightSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  insightSectionTitle: { fontSize: 13, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  insightPeriod: { fontSize: 11, fontWeight: '600' },
  topicPillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  readingTopicPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  readingTopicText: { fontSize: 13, fontWeight: '700' },
  readingTopicCount: { fontSize: 12, fontWeight: '800' },
  insightMetricGrid: {
    marginTop: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  insightMetric: {
    width: '48%',
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  insightMetricValue: { fontSize: 20, fontWeight: '800' },
  insightMetricLabel: { fontSize: 11, fontWeight: '700', marginTop: 4, textTransform: 'uppercase' },
  achievementHeader: {
    marginTop: 28,
    marginBottom: 14,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  achievementTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  achievementTitle: { fontSize: 26, fontWeight: '800' },
  achievementCount: { fontSize: 14 },
  filterRow: {
    marginHorizontal: 20,
    borderRadius: 18,
    padding: 6,
    gap: 8,
  },
  filterPill: {
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  filterText: { fontSize: 14, fontWeight: '600' },
  badgeCarousel: { paddingHorizontal: 20, gap: 16, paddingTop: 16 },
  badgeLoader: { paddingVertical: 54 },
  badgeShowcaseCard: {
    width: 186,
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 300,
  },
  badgeIconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  badgeShowcaseIcon: { fontSize: 38 },
  badgeShowcaseName: { fontSize: 17, fontWeight: '800', textAlign: 'center', lineHeight: 24 },
  badgeShowcaseDescription: { fontSize: 14, textAlign: 'center', lineHeight: 21, marginTop: 10, marginBottom: 14 },
  badgeTopicPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginBottom: 10,
  },
  badgeTopicText: { fontSize: 12, fontWeight: '700', color: '#A06FE4' },
  badgeTierPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  badgeTierText: { fontSize: 12, fontWeight: '700' },
  earnedDate: { fontSize: 11, fontWeight: '600', marginTop: 14 },
  emptyBadgeText: { paddingHorizontal: 20, paddingVertical: 30, fontSize: 14 },
});
