import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';
import { fetchBlockedIds } from '../lib/moderation';

interface PersonRow {
  id: string;
  full_name: string | null;
  username: string | null;
  avatar_url: string | null;
}

const PAGE = {
  background: '#F7F3EA',
  card: '#FBF7F0',
  surface: '#FFFDFC',
  text: '#2E2A25',
  textSecondary: '#5D554C',
  textMuted: '#8E857A',
  border: '#E7DEC9',
  tint: '#8EAF72',
  muted: '#F1ECE0',
};

const PERSON_SELECT = 'id, full_name, username, avatar_url';
const RESULT_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 250;

// PostgREST .or() filters are comma/paren separated, and % / * are ilike
// wildcards, so strip them from what the person typed before building one.
const cleanQuery = (raw: string) => raw.replace(/^@/, '').replace(/[,()%*\\]/g, ' ').trim();

export default function FindPeopleModal() {
  const { isGuestMode, loading: authLoading, user } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PersonRow[]>([]);
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const searchSeq = useRef(0);

  useEffect(() => {
    if (authLoading) return;
    if (isGuestMode || !user) {
      router.replace({ pathname: '/login', params: { returnTo: '/profile' } });
    }
  }, [authLoading, isGuestMode, user]);

  useEffect(() => {
    if (!user) return;
    let isActive = true;

    const load = async () => {
      const [blocked, followsResult] = await Promise.all([
        fetchBlockedIds(user.id),
        supabase.from('follows').select('following_id').eq('follower_id', user.id),
      ]);
      if (!isActive) return;

      if (followsResult.error) console.warn('[FindPeople] Failed to load follows', followsResult.error);

      setBlockedIds(blocked);
      setFollowingIds(new Set(
        (followsResult.data ?? []).map((row: any) => row.following_id).filter(Boolean),
      ));
      setLoading(false);
    };

    void load();
    return () => {
      isActive = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const term = cleanQuery(query);
    const seq = ++searchSeq.current;
    if (!term) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select(PERSON_SELECT)
        .neq('id', user.id)
        .or(`username.ilike.%${term}%,full_name.ilike.%${term}%`)
        .limit(RESULT_LIMIT);
      if (seq !== searchSeq.current) return;
      if (error) console.warn('[FindPeople] Search failed', error);
      setResults(((data ?? []) as PersonRow[]).filter((person) => !blockedIds.has(person.id)));
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, user?.id, blockedIds]);

  const toggleFollow = async (personId: string) => {
    if (!user || pendingIds.has(personId)) return;
    const wasFollowing = followingIds.has(personId);
    setPendingIds((prev) => new Set(prev).add(personId));
    setFollowingIds((prev) => {
      const next = new Set(prev);
      if (wasFollowing) next.delete(personId);
      else next.add(personId);
      return next;
    });

    const { error } = wasFollowing
      ? await supabase.from('follows').delete().eq('follower_id', user.id).eq('following_id', personId)
      : await supabase.from('follows').insert({ follower_id: user.id, following_id: personId });

    if (error) {
      console.warn('[FindPeople] Follow toggle failed', error);
      setFollowingIds((prev) => {
        const next = new Set(prev);
        if (wasFollowing) next.add(personId);
        else next.delete(personId);
        return next;
      });
    }
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(personId);
      return next;
    });
  };

  if (authLoading || isGuestMode || !user) return null;

  const isSearch = cleanQuery(query).length > 0;

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity style={s.backButton} onPress={() => router.back()} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={20} color={PAGE.text} />
        </TouchableOpacity>
        <Text style={s.title}>Find people</Text>
        <View style={s.headerSpacer} />
      </View>

      <View style={s.searchBox}>
        <Ionicons name="search" size={17} color={PAGE.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Name or @username"
          placeholderTextColor={PAGE.textMuted}
          style={s.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoFocus
        />
      </View>

      {loading ? (
        <ActivityIndicator color={PAGE.tint} style={s.loader} size="large" />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={Keyboard.dismiss}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            searching ? (
              <ActivityIndicator color={PAGE.tint} style={s.inlineLoader} />
            ) : (
              <Text style={s.emptyText}>
                {isSearch ? 'No readers match that name.' : 'Search by name or @username.'}
              </Text>
            )
          }
          renderItem={({ item }) => {
            const displayName = item.full_name ?? item.username ?? 'Praxis reader';
            const following = followingIds.has(item.id);
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
                  <Text style={s.username} numberOfLines={1}>@{item.username ?? 'reader'}</Text>
                </View>
                <TouchableOpacity
                  style={[s.followButton, following && s.followingButton]}
                  onPress={() => void toggleFollow(item.id)}
                  disabled={pendingIds.has(item.id)}
                  accessibilityLabel={following ? `Unfollow ${displayName}` : `Follow ${displayName}`}
                >
                  <Text style={[s.followText, following && s.followingText]}>
                    {following ? 'Following' : 'Follow'}
                  </Text>
                </TouchableOpacity>
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
  searchBox: {
    marginHorizontal: 20,
    marginBottom: 12,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PAGE.border,
    backgroundColor: PAGE.surface,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: { flex: 1, color: PAGE.text, fontSize: 16 },
  loader: { flex: 1 },
  inlineLoader: { marginTop: 24 },
  list: { paddingHorizontal: 20, paddingBottom: 30, gap: 10 },
  emptyText: { color: PAGE.textMuted, fontSize: 14, textAlign: 'center', marginTop: 24 },
  profileRow: {
    minHeight: 72,
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
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E7E0D4',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: 44, height: 44 },
  avatarInitial: { color: PAGE.tint, fontSize: 18, fontWeight: '800' },
  profileCopy: { flex: 1 },
  name: { color: PAGE.text, fontSize: 15, fontWeight: '700' },
  username: { color: PAGE.textMuted, fontSize: 12, marginTop: 2 },
  followButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: PAGE.tint },
  followingButton: { backgroundColor: PAGE.muted },
  followText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  followingText: { color: PAGE.textSecondary },
});
