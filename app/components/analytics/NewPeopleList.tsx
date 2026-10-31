import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { supabase } from '../../services/supabase';

type NewPersonRow = {
  actor: string;
  user_id: string | null;
  device_id: string | null;
  name: string | null;
  email: string | null;
  platforms: string | null;
  joined_at: string;
  last_seen_at: string;
  reads: number;
  is_team: boolean;
};

type Filter = 'all' | 'new' | 'team' | 'accounts' | 'iphone' | 'web';

const COLORS = {
  card: '#FFFDF9', text: '#302C27', muted: '#7E766C', border: '#E3DACB', green: '#5F7D4D', greenSoft: '#E7F0DF',
};

// Same Intl path as the rest of the app: never new Date(localeString) on Hermes.
const shortDay = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Everyone who showed up for the first time in the window, tagged New or Team (same data as the
// website's New people card). Tapping a tag moves that account or device in or out of the team
// list that every outside-only number reads.
export function NewPeopleList({ days, onTeamChanged }: { days: number | null; onTeamChanged: () => void }) {
  const [rows, setRows] = useState<NewPersonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('analytics_new_people', { p_days: days });
    if (rpcError) setError(rpcError.message);
    else setRows(Array.isArray(data) ? (data as NewPersonRow[]) : []);
  }, [days]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const toggleTeam = async (row: NewPersonRow) => {
    setSaving(row.actor);
    const { error: rpcError } = await supabase.rpc('analytics_set_team', {
      p_user_id: row.user_id,
      p_device_id: row.user_id ? null : row.device_id,
      p_team: !row.is_team,
    });
    setSaving(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    await load();
    onTeamChanged();
  };

  const all = rows ?? [];
  const counts: Record<Filter, number> = {
    all: all.length,
    new: all.filter((r) => !r.is_team).length,
    team: all.filter((r) => r.is_team).length,
    accounts: all.filter((r) => r.user_id).length,
    iphone: all.filter((r) => (r.platforms ?? '').includes('iPhone')).length,
    web: all.filter((r) => (r.platforms ?? '').includes('Web')).length,
  };

  // Web guests with no reads look identical, so they collapse into one line per tag.
  const visible = useMemo(() => {
    const picked = all.filter((r) =>
      filter === 'all' ? true
      : filter === 'new' ? !r.is_team
      : filter === 'team' ? r.is_team
      : filter === 'accounts' ? Boolean(r.user_id)
      : filter === 'iphone' ? (r.platforms ?? '').includes('iPhone')
      : (r.platforms ?? '').includes('Web'));
    const isWebGuest = (r: NewPersonRow) => !r.user_id && Number(r.reads) === 0 && r.platforms === 'Web';
    const singles = picked.filter((r) => !isWebGuest(r))
      .sort((a, b) => Number(a.is_team) - Number(b.is_team) || Number(b.reads) - Number(a.reads));
    const groups = [false, true]
      .map((team) => picked.filter((r) => isWebGuest(r) && r.is_team === team))
      .filter((g) => g.length > 0);
    return { singles, groups };
  }, [all, filter]);

  const chips: [Filter, string][] = [
    ['all', `All ${counts.all}`], ['new', `New ${counts.new}`], ['team', `Team ${counts.team}`],
    ['accounts', `Accounts ${counts.accounts}`], ['iphone', `iPhone ${counts.iphone}`], ['web', `Web ${counts.web}`],
  ];

  return (
    <View style={s.shell}>
      <Text style={s.title}>New people {days ? `(last ${days} days)` : '(all time)'}</Text>
      <Text style={s.description}>Everyone who showed up for the first time. Tap a tag to switch it between New and Team; every outside-only number updates.</Text>
      <View style={s.chips}>
        {chips.map(([value, label]) => (
          <TouchableOpacity key={value} onPress={() => setFilter(value)} style={[s.chip, filter === value && s.chipActive]}>
            <Text style={[s.chipText, filter === value && s.chipTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {error ? <Text style={s.error}>Could not load new people: {error}</Text> : null}
      {rows == null && !error ? <ActivityIndicator color={COLORS.green} style={{ marginVertical: 18 }} /> : null}
      {rows != null ? (
        <View style={s.list}>
          {visible.singles.map((row, index) => (
            <View key={row.actor} style={[s.row, index > 0 && s.rowBorder]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.who, row.is_team && s.dim]} numberOfLines={1}>
                  {row.user_id ? (row.name || row.email?.split('@')[0] || 'Deleted account') : 'Guest (no account)'}
                </Text>
                <Text style={s.meta} numberOfLines={1}>
                  {shortDay(row.joined_at)} · {row.platforms ?? '–'}{row.email ? ` · ${row.email}` : ''}
                </Text>
              </View>
              <Text style={[s.reads, row.is_team && s.dim]}>
                {row.platforms === 'Web' && Number(row.reads) === 0 ? '–' : `${row.reads} reads`}
              </Text>
              <TouchableOpacity
                onPress={() => void toggleTeam(row)}
                disabled={saving === row.actor || (!row.user_id && !row.device_id)}
                style={[s.tag, row.is_team ? s.tagTeam : s.tagNew]}
              >
                <Text style={[s.tagText, row.is_team ? s.tagTextTeam : s.tagTextNew]}>
                  {saving === row.actor ? '…' : row.is_team ? 'Team' : 'New'}
                </Text>
              </TouchableOpacity>
            </View>
          ))}
          {visible.groups.map((group) => (
            <View key={`web-${group[0].is_team}`} style={[s.row, s.rowBorder]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.who, group[0].is_team && s.dim]}>Web guest ×{group.length}</Text>
                <Text style={s.meta}>
                  {shortDay(group[group.length - 1].joined_at)}{group.length > 1 ? ` to ${shortDay(group[0].joined_at)}` : ''} · Web
                </Text>
              </View>
              <Text style={s.reads}>–</Text>
              <View style={[s.tag, group[0].is_team ? s.tagTeam : s.tagNew]}>
                <Text style={[s.tagText, group[0].is_team ? s.tagTextTeam : s.tagTextNew]}>{group[0].is_team ? 'Team' : 'New'}</Text>
              </View>
            </View>
          ))}
          {visible.singles.length === 0 && visible.groups.length === 0 ? <Text style={s.meta}>Nobody in this view.</Text> : null}
        </View>
      ) : null}
      <Text style={s.footnote}>"–" = the website doesn't report reads yet (iPhone only). Guests are counted per device or browser.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { backgroundColor: '#FCF8F0', borderColor: COLORS.border, borderWidth: 1, borderRadius: 24, padding: 16, gap: 10, marginTop: 6 },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.2 },
  description: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { borderWidth: 1, borderColor: COLORS.border, backgroundColor: '#FAF7F0', borderRadius: 14, paddingHorizontal: 11, paddingVertical: 7 },
  chipActive: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  chipText: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  chipTextActive: { color: '#FFFDF9' },
  list: { backgroundColor: COLORS.card, borderColor: '#E7DED1', borderWidth: 1, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 10 },
  rowBorder: { borderTopWidth: 1, borderTopColor: '#EEE7DB' },
  who: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  meta: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  reads: { color: COLORS.text, fontSize: 12, fontWeight: '700', minWidth: 52, textAlign: 'right' },
  dim: { color: COLORS.muted },
  tag: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, minWidth: 50, alignItems: 'center' },
  tagNew: { backgroundColor: '#DCEBD7' },
  tagTeam: { backgroundColor: '#ECE6DA' },
  tagText: { fontSize: 11, fontWeight: '800' },
  tagTextNew: { color: '#275E37' },
  tagTextTeam: { color: COLORS.muted },
  error: { color: '#A94734', fontSize: 13, lineHeight: 18 },
  footnote: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
});
