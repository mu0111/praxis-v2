import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';
import { fetchBlockedIds } from '../lib/moderation';

interface FollowProfile {
  id: string;
  full_name: string | null;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
}

const PAGE = {
  background: '#F7F3EA',
  card: '#FBF7F0',
  surface: '#FFFDFC',
  text: '#2E2A25',
  textMuted: '#8E857A',
  border: '#E7DEC9',
  tint: '#8EAF72',
};

export default function FollowListModal() {
  const { isGuestMode, loading: authLoading, user } = useAuth();
  const params = useLocalSearchParams<{ type?: string; userId?: string }>();
  const type = params.type === 'following' ? 'following' : 'followers';
  const targetUserId = typeof params.userId === 'string' ? params.userId : user?.id;
  const [profiles, setProfiles] = useState<FollowProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (isGuestMode || !user) {
      router.replace({ pathname: '/login', params: { returnTo: '/profile' } });
    }
  }, [authLoading, isGuestMode, user]);

  // Reload on focus so people followed from Find people show up on return.
  useFocusEffect(useCallback(() => {
    let isActive = true;

    const load = async () => {
      if (!targetUserId) {
        if (isActive) setLoading(false);
        return;
      }

      const relationColumn = type === 'followers' ? 'following_id' : 'follower_id';
      const profileColumn = type === 'followers' ? 'follower_id' : 'following_id';
      const { data: relationships, error: relationshipError } = await supabase
        .from('follows')
        .select(`${profileColumn}, created_at`)
        .eq(relationColumn, targetUserId)
        .order('created_at', { ascending: false });

      if (relationshipError) {
        console.warn('[FollowList] Failed to load relationships', relationshipError);
        if (isActive) setLoading(false);
        return;
      }

      const ids = (relationships ?? [])
        .map((entry: any) => entry[profileColumn])
        .filter((id): id is string => typeof id === 'string');

      if (ids.length === 0) {
        if (isActive) {
          setProfiles([]);
          setLoading(false);
        }
        return;
      }

      const [blockedIds, profileResult] = await Promise.all([
        fetchBlockedIds(user.id),
        supabase
        .from('profiles')
        .select('id, full_name, username, avatar_url, bio')
        .in('id', ids),
      ]);
      const { data, error } = profileResult;

      if (error) console.warn('[FollowList] Failed to load profiles', error);
      if (!isActive) return;

      const byId = new Map((data ?? []).map((profile: any) => [profile.id, profile]));
      setProfiles(ids.filter((id) => !blockedIds.has(id)).map((id) => byId.get(id)).filter(Boolean) as FollowProfile[]);
      setLoading(false);
    };

    void load();
    return () => {
      isActive = false;
    };
  }, [targetUserId, type, user?.id]));

  if (authLoading || isGuestMode || !user) return null;

  const isOwnList = targetUserId === user.id;
  const openFindPeople = () => router.push('/modal/find-people');

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity style={s.backButton} onPress={() => router.back()} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={20} color={PAGE.text} />
        </TouchableOpacity>
        <Text style={s.title}>{type === 'followers' ? 'Followers' : 'Following'}</Text>
        {isOwnList ? (
          <TouchableOpacity style={s.backButton} onPress={openFindPeople} accessibilityLabel="Find people">
            <Ionicons name="add" size={22} color={PAGE.text} />
          </TouchableOpacity>
        ) : (
          <View style={s.headerSpacer} />
        )}
      </View>

      {loading ? (
        <ActivityIndicator color={PAGE.tint} style={s.loader} size="large" />
      ) : (
        <FlatList
          data={profiles}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[s.list, profiles.length === 0 && s.emptyList]}
          ListEmptyComponent={(
            <View style={s.emptyState}>
              <View style={s.emptyIcon}>
                <Ionicons name="people-outline" size={28} color={PAGE.tint} />
              </View>
              <Text style={s.emptyTitle}>No {type} yet</Text>
              <Text style={s.emptyText}>
                {type === 'followers'
                  ? 'People who follow this account will appear here.'
                  : 'Accounts followed from Praxis will appear here.'}
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            const displayName = item.full_name ?? item.username ?? 'Praxis reader';
            return (
              <TouchableOpacity
                style={s.profileRow}
                onPress={() => router.push({ pathname: '/modal/user-profile', params: { userId: item.id } })}
                activeOpacity={0.8}
              >
                <View style={s.avatar}>
                  {item.avatar_url ? (
                    <Image source={{ uri: item.avatar_url }} style={s.avatarImage} />
                  ) : (
                    <Text style={s.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
                  )}
                </View>
                <View style={s.profileCopy}>
                  <Text style={s.name} numberOfLines={1}>{displayName}</Text>
                  <Text style={s.username}>@{item.username ?? 'reader'}</Text>
                  {item.bio ? <Text style={s.bio} numberOfLines={1}>{item.bio}</Text> : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color={PAGE.textMuted} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: PAGE.background },
  header: { height: 68, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  title: { color: PAGE.text, fontSize: 21, fontWeight: '800' },
  headerSpacer: { width: 40 },
  loader: { flex: 1 },
  list: { paddingHorizontal: 20, paddingBottom: 30, gap: 10 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  profileRow: {
    minHeight: 84,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: PAGE.border,
    backgroundColor: PAGE.card,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E7E0D4',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: 48, height: 48 },
  avatarInitial: { color: PAGE.tint, fontSize: 19, fontWeight: '800' },
  profileCopy: { flex: 1 },
  name: { color: PAGE.text, fontSize: 15, fontWeight: '700' },
  username: { color: PAGE.textMuted, fontSize: 12, marginTop: 2 },
  bio: { color: PAGE.textMuted, fontSize: 12, marginTop: 4 },
  emptyState: { alignItems: 'center', paddingHorizontal: 36 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#E8EFDB', alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: PAGE.text, fontSize: 20, fontWeight: '800', marginTop: 18 },
  emptyText: { color: PAGE.textMuted, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 8 },
});
