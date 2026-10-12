import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, ActivityIndicator, Image, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../services/supabase';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { buildHref } from '../lib/buildHref';
import {
  blockUser,
  fetchIsBlocked,
  unblockUser,
} from '../lib/moderation';
import { ReportSheet } from '../components/ReportSheet';

export default function UserProfileModal() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const { isGuestMode, user, loading: authLoading } = useAuth();
  const { c } = useTheme();
  const [profile, setProfile] = useState<any>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Wait for the session to restore; redirecting on the first render (cold
    // start from a link or notification) navigated before the root mounted.
    if (authLoading) return;
    if (isGuestMode || !user) {
      router.replace(buildHref('/login', { returnTo: '/social' }));
      return;
    }

    Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      user ? supabase.from('follows').select('id').eq('follower_id', user.id).eq('following_id', userId).maybeSingle() : Promise.resolve({ data: null }),
      user && userId ? fetchIsBlocked(user.id, userId) : Promise.resolve(false),
    ]).then(([{ data: p }, { data: f }, blocked]) => {
      setProfile(p);
      setIsFollowing(!!f);
      setIsBlocked(Boolean(blocked));
      setLoading(false);
    });
  }, [authLoading, isGuestMode, userId, user]);

  const displayName = profile?.full_name ?? profile?.username ?? 'this user';

  const confirmBlock = () => {
    Alert.alert(
      `Block ${displayName}?`,
      'They will no longer be able to message you or follow you, and you will not see each other in social.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            if (!user || !userId) return;
            try {
              await blockUser(user.id, userId);
              setIsBlocked(true);
              setIsFollowing(false);
              router.back();
            } catch {
              Alert.alert('Could not block', 'Something went wrong. Try again.');
            }
          },
        },
      ],
    );
  };

  const doUnblock = async () => {
    if (!user || !userId) return;
    try {
      await unblockUser(user.id, userId);
      setIsBlocked(false);
    } catch {
      Alert.alert('Could not unblock', 'Something went wrong. Try again.');
    }
  };

  const openModerationMenu = () => {
    Alert.alert(
      displayName,
      undefined,
      [
        { text: 'Report user', onPress: () => setReporting(true) },
        isBlocked
          ? { text: 'Unblock user', onPress: () => void doUnblock() }
          : { text: 'Block user', style: 'destructive' as const, onPress: confirmBlock },
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  };

  const toggleFollow = async () => {
    if (!user) return;
    if (isFollowing) {
      await supabase.from('follows').delete().eq('follower_id', user.id).eq('following_id', userId);
      setIsFollowing(false);
    } else {
      await supabase.from('follows').insert({ follower_id: user.id, following_id: userId });
      setIsFollowing(true);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color={c.tint} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }
  if (!profile) return null;
  const statsPublic = profile.show_on_leaderboard === true || profile.id === user?.id;

  return (
    <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={[s.backText, { color: c.tint }]}>‹ Back</Text>
        </TouchableOpacity>
        {user?.id !== userId ? (
          <TouchableOpacity
            onPress={openModerationMenu}
            accessibilityLabel="More options"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="ellipsis-horizontal" size={22} color={c.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={s.content}>
        <View style={[s.avatar, { backgroundColor: c.secondary }]}>
          {profile.avatar_url
            ? <Image source={{ uri: profile.avatar_url }} style={s.avatarImg} />
            : <Text style={[s.avatarInitial, { color: c.text }]}>
                {(profile.full_name ?? profile.username ?? '?')[0]?.toUpperCase()}
              </Text>
          }
        </View>
        <Text style={[s.name, { color: c.text }]}>
          {profile.full_name ?? profile.username ?? 'Anonymous'}
        </Text>
        {profile.bio && (
          <Text style={[s.bio, { color: c.textSecondary }]}>{profile.bio}</Text>
        )}

        {user?.id !== userId && isBlocked && (
          <TouchableOpacity
            style={[s.followBtn, { backgroundColor: c.secondary, borderColor: c.border }]}
            onPress={() => void doUnblock()}
          >
            <Text style={[s.followBtnText, { color: c.textSecondary }]}>Blocked — tap to unblock</Text>
          </TouchableOpacity>
        )}
        {user?.id !== userId && !isBlocked && (
          <TouchableOpacity
            style={[s.followBtn, {
              backgroundColor: isFollowing ? c.secondary : c.tint,
              borderColor: c.border,
            }]}
            onPress={toggleFollow}
          >
            <Text style={[s.followBtnText, { color: isFollowing ? c.textSecondary : c.tintForeground }]}>
              {isFollowing ? '✓ Following' : 'Follow'}
            </Text>
          </TouchableOpacity>
        )}

        <View style={[s.statsCard, { backgroundColor: c.card, borderColor: c.border }]}>
          {[
            // Reading stats are only public for people who joined the
            // leaderboard (Guideline 5.1.2 consent); others show a lock.
            { label: 'Articles Read', value: profile.articles_read ?? 0, isPrivate: !statsPublic },
            { label: 'Day Streak', value: profile.current_streak ?? 0, isPrivate: !statsPublic },
            { label: 'Followers', value: profile.followers_count ?? 0, isPrivate: false },
          ].map((stat, i, arr) => (
            <View key={stat.label} style={[s.stat, i < arr.length - 1 && { borderRightWidth: 1, borderRightColor: c.border }]}>
              {stat.isPrivate
                ? <View style={s.statLock}><Ionicons name="lock-closed" size={20} color={c.textMuted} /></View>
                : <Text style={[s.statNum, { color: c.text }]}>{stat.value}</Text>}
              <Text style={[s.statLabel, { color: c.textMuted }]}>{stat.label}</Text>
            </View>
          ))}
        </View>
        {!statsPublic && (
          <Text style={[s.statsPrivateNote, { color: c.textMuted }]}>Reading stats are private</Text>
        )}
      </ScrollView>
      {user && userId ? <ReportSheet
        visible={reporting}
        reporterId={user.id}
        target={{ targetUserId: userId, targetType: 'profile' }}
        onClose={() => setReporting(false)}
      /> : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backText: { fontSize: 17 },
  content: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 12, gap: 12 },
  avatar: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImg: { width: 96, height: 96 },
  avatarInitial: { fontSize: 36, fontWeight: '700' },
  name: { fontSize: 22, fontWeight: '700' },
  bio: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  followBtn: { paddingHorizontal: 28, paddingVertical: 10, borderRadius: 999, borderWidth: 1, marginTop: 4 },
  followBtnText: { fontSize: 15, fontWeight: '600' },
  statsCard: {
    flexDirection: 'row', borderRadius: 16, borderWidth: 1,
    overflow: 'hidden', width: '100%', marginTop: 16,
  },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 20 },
  statNum: { fontSize: 24, fontWeight: '800' },
  statLabel: { fontSize: 12, marginTop: 3 },
  statLock: { height: 29, justifyContent: 'center' },
  statsPrivateNote: { fontSize: 12, textAlign: 'center', marginTop: 8 },
});
