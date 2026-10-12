import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { supabase } from '../services/supabase';
import { isStreakLive } from '../lib/digestStreak';
import { useAuth } from '../context/AuthContext';

type LeaderboardTab = 'streaks' | 'readers' | 'friends';

interface LeaderboardProfile {
  id: string;
  full_name: string | null;
  username: string | null;
  avatar_url: string | null;
  articles_read: number | null;
  current_streak: number | null;
  longest_streak?: number | null;
  streak_last_completed_date?: string | null;
}

const LEADERBOARD_LIMIT = 10;
// Fetch more than a page so dead streaks can be zeroed before ranking.
const LEADERBOARD_CANDIDATE_LIMIT = 50;
const PROFILE_SELECT =
  'id, full_name, username, avatar_url, articles_read, current_streak, longest_streak, streak_last_completed_date';

// Same sanitising as the web leaderboard: a streak whose last digest
// completion is older than yesterday (New York) is dead and shows as 0.
const sanitizeProfiles = (profiles: LeaderboardProfile[] | null) => {
  const rows = (profiles ?? []).filter((profile) => Boolean(profile.id));
  try {
    return rows.map((profile) => ({
      ...profile,
      current_streak: isStreakLive(profile.streak_last_completed_date)
        ? profile.current_streak ?? 0
        : 0,
      articles_read: profile.articles_read ?? 0,
    }));
  } catch (error) {
    // Never let the live-streak rule empty the board; show stored values.
    console.warn('[Leaderboard] Live-streak rule failed; showing stored streaks', error);
    return rows;
  }
};

const sortProfiles = (
  profiles: LeaderboardProfile[],
  primaryKey: 'articles_read' | 'current_streak',
) => {
  const secondaryKey = primaryKey === 'articles_read' ? 'current_streak' : 'articles_read';
  return [...profiles].sort((a, b) => {
    const primaryDiff = (b[primaryKey] ?? 0) - (a[primaryKey] ?? 0);
    if (primaryDiff !== 0) return primaryDiff;
    const secondaryDiff = (b[secondaryKey] ?? 0) - (a[secondaryKey] ?? 0);
    if (secondaryDiff !== 0) return secondaryDiff;
    return (a.full_name || a.username || '').localeCompare(b.full_name || b.username || '');
  });
};

const PAGE = {
  background: '#F7F3EA',
  card: '#FBF7F0',
  surface: '#FFFDFC',
  secondary: '#EFE6D6',
  text: '#2E2A25',
  textMuted: '#8E857A',
  border: '#E7DEC9',
  tint: '#8EAF72',
};

const TAB_COPY: Record<LeaderboardTab, { label: string; icon: keyof typeof Ionicons.glyphMap; helper: string }> = {
  streaks: { label: 'Streaks', icon: 'flame-outline', helper: 'Top current streaks across Praxis' },
  readers: { label: 'Readers', icon: 'book-outline', helper: 'Top readers by total articles read' },
  friends: { label: 'Friends', icon: 'people-outline', helper: 'Reading streaks for people you follow' },
};

export default function LeaderboardModal() {
  const { isGuestMode, loading: authLoading, profile, updateProfile, user } = useAuth();
  const [activeTab, setActiveTab] = useState<LeaderboardTab>('streaks');
  const [profiles, setProfiles] = useState<LeaderboardProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // App Store 5.1.2: ask once before anyone's stats go on a leaderboard.
  // null/undefined = never asked; "Not now" stores false so we don't re-ask.
  const [consentDismissed, setConsentDismissed] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const showConsent = Boolean(profile) && profile?.show_on_leaderboard == null && !consentDismissed;

  useEffect(() => {
    if (authLoading) return;
    if (isGuestMode || !user) {
      router.replace({ pathname: '/login', params: { returnTo: '/profile' } });
    }
  }, [authLoading, isGuestMode, user]);

  const loadLeaderboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setLoadError(null);

    try {
      if (isGuestMode || !user) {
        setProfiles([]);
        return;
      }

      if (activeTab === 'friends') {
        const { data: follows, error: followsError } = await supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', user.id);
        if (followsError) throw followsError;

        const friendIds = (follows ?? []).map((entry: any) => entry.following_id).filter(Boolean);
        if (friendIds.length === 0) {
          setProfiles([]);
          return;
        }

        const { data, error } = await supabase
          .from('profiles')
          .select(PROFILE_SELECT)
          .in('id', friendIds)
          .eq('show_on_leaderboard', true)
          .order('current_streak', { ascending: false })
          .limit(LEADERBOARD_CANDIDATE_LIMIT);
        if (error) throw error;
        setProfiles(
          sortProfiles(sanitizeProfiles(data as LeaderboardProfile[]), 'current_streak')
            .slice(0, LEADERBOARD_LIMIT),
        );
        return;
      }

      const orderColumn = activeTab === 'readers' ? 'articles_read' : 'current_streak';
      const { data, error } = await supabase
        .from('profiles')
        .select(PROFILE_SELECT)
        .eq('show_on_leaderboard', true)
        .order(orderColumn, { ascending: false })
        .limit(activeTab === 'readers' ? LEADERBOARD_LIMIT : LEADERBOARD_CANDIDATE_LIMIT);
      if (error) throw error;
      setProfiles(
        sortProfiles(sanitizeProfiles(data as LeaderboardProfile[]), orderColumn)
          .slice(0, LEADERBOARD_LIMIT),
      );
    } catch (error) {
      console.warn('[Leaderboard] Failed to load leaderboard', error);
      const message = error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown })?.message === 'string'
          ? String((error as { message: string }).message)
          : 'Unknown error';
      setLoadError(message);
      setProfiles([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeTab, isGuestMode, user]);

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  const statValue = (profile: LeaderboardProfile) => (
    activeTab === 'readers'
      ? profile.articles_read ?? 0
      : profile.current_streak ?? 0
  );

  const answerConsent = async (join: boolean) => {
    setConsentSaving(true);
    try {
      await updateProfile({ show_on_leaderboard: join });
      if (join) void loadLeaderboard(true);
    } catch (error) {
      console.warn('[Leaderboard] Could not save leaderboard choice', error);
    } finally {
      setConsentSaving(false);
      setConsentDismissed(true);
    }
  };

  if (authLoading || isGuestMode || !user) return null;

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity style={s.backButton} onPress={() => router.back()} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={20} color={PAGE.text} />
        </TouchableOpacity>
        <View style={s.headerTitleRow}>
          <Ionicons name="trophy-outline" size={28} color={PAGE.tint} />
          <View>
            <Text style={s.title}>Leaderboard</Text>
            <Text style={s.subtitle}>Global streaks, top readers, and friends</Text>
          </View>
        </View>
        <TouchableOpacity
          style={s.refreshButton}
          onPress={() => void loadLeaderboard(true)}
          disabled={refreshing}
          accessibilityLabel="Refresh leaderboard"
        >
          {refreshing
            ? <ActivityIndicator color={PAGE.text} size="small" />
            : <Ionicons name="refresh-outline" size={18} color={PAGE.text} />}
        </TouchableOpacity>
      </View>

      <View style={s.tabList}>
        {(Object.keys(TAB_COPY) as LeaderboardTab[]).map((tab) => {
          const selected = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              style={[s.tab, selected && s.selectedTab]}
              onPress={() => setActiveTab(tab)}
            >
              <Ionicons name={TAB_COPY[tab].icon} size={15} color={selected ? PAGE.text : PAGE.textMuted} />
              <Text style={[s.tabText, selected && s.selectedTabText]}>{TAB_COPY[tab].label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={s.helper}>{TAB_COPY[activeTab].helper}</Text>

      {loading ? (
        <ActivityIndicator size="large" color={PAGE.tint} style={s.loader} />
      ) : (
        <FlatList
          data={profiles}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[s.list, profiles.length === 0 && s.emptyList]}
          ListEmptyComponent={(
            <View style={s.emptyState}>
              <Ionicons
                name={activeTab === 'friends' ? 'people-outline' : 'trophy-outline'}
                size={34}
                color={PAGE.tint}
              />
              <Text style={s.emptyTitle}>
                {loadError
                  ? 'Could not load the leaderboard'
                  : activeTab === 'friends' ? 'Follow a few readers' : 'No rankings yet'}
              </Text>
              <Text style={s.emptyText}>
                {loadError
                  ? `Tap refresh to try again. (${loadError})`
                  : activeTab === 'friends'
                    ? 'People you follow will appear in this leaderboard.'
                    : 'Reading activity will populate this leaderboard.'}
              </Text>
            </View>
          )}
          renderItem={({ item, index }) => {
            const isMe = item.id === user?.id;
            const displayName = item.full_name ?? item.username ?? 'Praxis reader';
            const value = statValue(item);
            return (
              <TouchableOpacity
                style={[s.row, isMe && s.meRow]}
                onPress={() => router.push({ pathname: '/modal/user-profile', params: { userId: item.id } })}
                activeOpacity={0.8}
              >
                <View style={[s.rankCircle, index < 3 && s.topRankCircle]}>
                  <Text style={[s.rank, index < 3 && s.topRank]}>{index + 1}</Text>
                </View>
                <View style={s.avatar}>
                  {item.avatar_url ? (
                    <Image source={{ uri: item.avatar_url }} style={s.avatarImage} />
                  ) : (
                    <Text style={s.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
                  )}
                </View>
                <View style={s.profileCopy}>
                  <Text style={s.name} numberOfLines={1}>{displayName}{isMe ? ' (you)' : ''}</Text>
                  <Text style={s.username}>@{item.username ?? 'reader'}</Text>
                </View>
                <View style={s.statWrap}>
                  <Ionicons
                    name={activeTab === 'readers' ? 'book-outline' : 'flame-outline'}
                    size={15}
                    color={PAGE.tint}
                  />
                  <Text style={s.stat}>{value}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
      <Modal visible={showConsent} transparent animationType="slide" onRequestClose={() => void answerConsent(false)}>
        <View style={s.consentBackdrop}>
          <View style={s.consentSheet}>
            <Text style={s.consentTitle}>Join the leaderboard?</Text>
            <Text style={s.consentText}>
              Your name, @username, photo, reading streak and number of articles read will be visible to other Praxis readers. Which articles you read stays private.
              You can change this anytime in Settings.
            </Text>
            <TouchableOpacity
              style={s.consentJoin}
              onPress={() => void answerConsent(true)}
              disabled={consentSaving}
              accessibilityLabel="Join leaderboard"
            >
              {consentSaving
                ? <ActivityIndicator color="#FFFDF8" size="small" />
                : <Text style={s.consentJoinText}>Join leaderboard</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              style={s.consentSkip}
              onPress={() => void answerConsent(false)}
              disabled={consentSaving}
              accessibilityLabel="Not now"
            >
              <Text style={s.consentSkipText}>Not now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: PAGE.background },
  header: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', gap: 12 },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: PAGE.border,
    backgroundColor: PAGE.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: PAGE.text, fontSize: 23, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: PAGE.textMuted, fontSize: 10, marginTop: 3 },
  refreshButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PAGE.border,
    backgroundColor: PAGE.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabList: { marginHorizontal: 18, padding: 5, borderRadius: 16, backgroundColor: '#DDD5C7', flexDirection: 'row', gap: 4 },
  tab: { flex: 1, borderRadius: 12, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  selectedTab: { backgroundColor: PAGE.surface, borderWidth: 1, borderColor: PAGE.border },
  tabText: { color: PAGE.textMuted, fontSize: 12, fontWeight: '700' },
  selectedTabText: { color: PAGE.text },
  helper: { color: PAGE.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginHorizontal: 20, marginTop: 18, marginBottom: 10 },
  loader: { flex: 1 },
  list: { paddingHorizontal: 18, paddingBottom: 30, gap: 10 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  row: {
    minHeight: 78,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: PAGE.border,
    backgroundColor: PAGE.card,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  meRow: { borderColor: '#B9CDA8', backgroundColor: '#F1F5E9' },
  rankCircle: { width: 30, height: 30, borderRadius: 15, backgroundColor: PAGE.secondary, alignItems: 'center', justifyContent: 'center' },
  topRankCircle: { backgroundColor: '#E4ECD8' },
  rank: { color: PAGE.textMuted, fontSize: 12, fontWeight: '800' },
  topRank: { color: '#688650' },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#E7E0D4', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: 44, height: 44 },
  avatarInitial: { color: PAGE.tint, fontSize: 17, fontWeight: '800' },
  profileCopy: { flex: 1 },
  name: { color: PAGE.text, fontSize: 14, fontWeight: '700' },
  username: { color: PAGE.textMuted, fontSize: 11, marginTop: 3 },
  statWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stat: { color: PAGE.tint, fontSize: 18, fontWeight: '800' },
  emptyState: { alignItems: 'center', paddingHorizontal: 42 },
  emptyTitle: { color: PAGE.text, fontSize: 20, fontWeight: '800', marginTop: 16 },
  emptyText: { color: PAGE.textMuted, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 7 },
  consentBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(46,42,37,0.38)' },
  consentSheet: { backgroundColor: PAGE.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 36 },
  consentTitle: { color: PAGE.text, fontSize: 20, fontWeight: '800', marginBottom: 8 },
  consentText: { color: '#5D554C', fontSize: 14, lineHeight: 21, marginBottom: 18 },
  consentJoin: { minHeight: 50, borderRadius: 16, backgroundColor: PAGE.tint, alignItems: 'center', justifyContent: 'center' },
  consentJoinText: { color: '#FFFDF8', fontSize: 16, fontWeight: '800' },
  consentSkip: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  consentSkipText: { color: PAGE.textMuted, fontSize: 15, fontWeight: '700' },
});
