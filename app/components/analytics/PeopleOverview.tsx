import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { supabase } from '../../services/supabase';

type WindowKey = 'today' | 'yesterday' | 'days7' | 'days30';

type WindowRow = {
  key: WindowKey;
  label: string;
  day_from: string;
  users: number;
  new: number;
  returning: number;
  reads: number;
  quick: number;
  bots?: number;
};

type DayRow = {
  day: string;
  users: number;
  new: number;
  returning: number;
  reads: number;
  quick: number;
  bots: number;
  people: { person: string; reads: number; new: boolean }[];
};

type PersonRow = {
  person: string;
  user_id: string | null;
  device_id: string | null;
  name: string | null;
  email: string | null;
  platforms: string;
  last_seen_at: string;
  last_sign_in_at: string | null;
  active_days: number;
  is_team: boolean;
  windows: Partial<Record<WindowKey, { reads: number; returning: boolean }>>;
};

type Overview = { time_zone: string; windows: WindowRow[]; days?: DayRow[]; people: PersonRow[] };

const COLORS = {
  card: '#FFFDF9', text: '#302C27', muted: '#7E766C', border: '#E3DACB', green: '#5F7D4D', greenSoft: '#E7F0DF',
  blue: '#285C8F', blueSoft: '#E3EDF6',
};
const PREVIEW_COUNT = 5;

// Same Intl path as the rest of the app: never new Date(localeString) on Hermes.
const seenTime = (value: string, timeZone: string) => new Date(value)
  .toLocaleString('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  .replace(/\s(AM|PM)/, (_, part: string) => part.toLowerCase());
const signInDay = (value: string, timeZone: string) => new Date(value).toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' });
const rowDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const personName = (row: PersonRow) => {
  if (row.user_id) return row.name || row.email?.split('@')[0] || 'Deleted account';
  return row.platforms === 'Web' ? 'Website guest' : 'Guest iPhone';
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Who is using Praxis: real users, new vs returning and reads for each period, plus the people
// behind them. Tapping a period filters the list; tapping a day opens that day's people (Ayuka's pick A,
// 2026-11-03). Same analytics_people_overview numbers as the website.
export function PeopleOverview({ outsideOnly, onSettled, onTeamChanged }: { outsideOnly: boolean; onSettled: () => void; onTeamChanged: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WindowKey>('days7');
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const call = () => supabase.rpc('analytics_people_overview', { p_include_team: !outsideOnly });
    let { data: result, error: rpcError } = await call();
    // A cold database can push the first call past the 8s limit; the second runs warm (~0.4s).
    if (rpcError?.message.includes('statement timeout')) ({ data: result, error: rpcError } = await call());
    if (rpcError) setError(rpcError.message);
    else setData(result as Overview);
  }, [outsideOnly]);

  useEffect(() => {
    setData(null);
    void load().finally(onSettled);
  }, [load]);

  const toggleTeam = async (row: PersonRow) => {
    setSaving(row.person);
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

  const period = data?.windows.find((row) => row.key === selected);
  const people = (data?.people ?? []).filter((row) => row.windows[selected]);
  const visible = showAll ? people : people.slice(0, PREVIEW_COUNT);
  const singleDay = selected === 'today' || selected === 'yesterday';
  const byPerson = new Map((data?.people ?? []).map((row) => [row.person, row]));

  return (
    <View style={s.shell}>
      <Text style={s.title}>Who's using Praxis</Text>
      <Text style={s.description}>Eastern time · {outsideOnly ? 'Team and test phones left out' : 'Team and test phones included'}</Text>
      {error ? <Text style={s.error}>Could not load people: {error}</Text> : null}
      {data == null && !error ? <ActivityIndicator color={COLORS.green} style={{ marginVertical: 18 }} /> : null}
      {data != null ? <>
        <View style={s.box}>
          <View style={s.headRow}>
            <Text style={[s.head, s.nameCell]} />
            <Text style={[s.head, s.usersCell]}>Users</Text>
            <Text style={[s.head, s.newCell]}>New</Text>
            <Text style={[s.head, s.returningCell]}>Returning</Text>
            <Text style={[s.head, s.readsCell]}>Reads</Text>
          </View>
          {data.windows.map((row) => (
            <TouchableOpacity
              key={row.key}
              onPress={() => { setSelected(row.key); setShowAll(false); }}
              style={[s.periodRow, selected === row.key && s.periodRowActive]}
            >
              <View style={s.nameCell}>
                <Text style={s.periodName}>{row.label}</Text>
                {row.key === 'today' || row.key === 'yesterday' ? <Text style={s.periodDay}>{rowDay(row.day_from)}</Text> : null}
              </View>
              <Text style={[s.value, s.usersValue, s.usersCell]}>{row.users}</Text>
              <Text style={[s.value, s.newCell]}>{row.new}</Text>
              <Text style={[s.value, s.returningCell]}>{row.returning}</Text>
              <Text style={[s.value, s.readsCell]}>{row.reads}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.note}>Plus {plural(period?.quick ?? 0, 'quick visit')} {singleDay ? selected : `in the last ${period?.label ?? ''}`} (no account, no read, under 10 seconds).{period?.bots ? ` ${plural(period.bots, 'likely bot')} left out.` : ''} Neither counts as users.</Text>
        {data.days?.length ? <>
          <Text style={s.peopleTitle}>Day by day</Text>
          <View style={s.box}>
            <View style={s.headRow}>
              <Text style={[s.head, s.nameCell]} />
              <Text style={[s.head, s.usersCell]}>Users</Text>
              <Text style={[s.head, s.newCell]}>New</Text>
              <Text style={[s.head, s.returningCell]}>Returning</Text>
              <Text style={[s.head, s.readsCell]}>Reads</Text>
            </View>
            {data.days.map((day) => {
              const open = openDay === day.day;
              return (
                <View key={day.day} style={[s.dayWrap, open && s.dayWrapOpen]}>
                  <TouchableOpacity onPress={() => setOpenDay(open ? null : day.day)} style={s.dayRow}>
                    <Text style={[s.dayName, s.nameCell]} numberOfLines={1}>
                      <Text style={s.chevron}>{open ? '▾ ' : '▸ '}</Text>{rowDay(day.day)}
                    </Text>
                    <Text style={[s.dayValue, s.usersValue, s.dayUsers, s.usersCell]}>{day.users}</Text>
                    <Text style={[s.dayValue, s.newCell]}>{day.new}</Text>
                    <Text style={[s.dayValue, s.returningCell]}>{day.returning}</Text>
                    <Text style={[s.dayValue, s.readsCell]}>{day.reads}</Text>
                  </TouchableOpacity>
                  {open ? (
                    <View style={s.dayPeople}>
                      {day.people.map((entry, index) => {
                        const row = byPerson.get(entry.person);
                        return (
                          <View key={entry.person} style={[s.dayPerson, index > 0 && s.personBorder]}>
                            <View style={{ flex: 1 }}>
                              <Text style={s.who} numberOfLines={1}>{row ? personName(row) : 'Guest'}</Text>
                              <Text style={s.meta}>{plural(entry.reads, 'read')}</Text>
                            </View>
                            <View style={[s.tag, entry.new ? s.tagNew : s.tagReturning]}>
                              <Text style={[s.tagText, { color: entry.new ? COLORS.blue : COLORS.green }]}>{entry.new ? 'New' : 'Returning'}</Text>
                            </View>
                          </View>
                        );
                      })}
                      {day.people.length === 0 ? <Text style={s.meta}>No users this day.</Text> : null}
                      <Text style={[s.meta, { marginTop: 4 }]}>Also {plural(day.quick, 'quick visit')}, {plural(day.bots, 'likely bot')}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </> : null}
        <Text style={s.peopleTitle}>People, {singleDay ? selected : `last ${period?.label ?? ''}`} ({people.length})</Text>
        <View style={s.box}>
          {visible.map((row, index) => {
            const stats = row.windows[selected];
            const signIn = row.user_id
              ? (row.last_sign_in_at ? `Signed in ${signInDay(row.last_sign_in_at, data.time_zone)}` : 'Never signed in')
              : 'No account';
            return (
              <View key={row.person} style={[s.person, index > 0 && s.personBorder]}>
                <View style={s.personTop}>
                  <Text style={[s.who, row.is_team && s.dim]} numberOfLines={1}>{personName(row)}</Text>
                  <View style={[s.tag, stats?.returning ? s.tagReturning : s.tagNew]}>
                    <Text style={[s.tagText, { color: stats?.returning ? COLORS.green : COLORS.blue }]}>{stats?.returning ? 'Returning' : 'New'}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => void toggleTeam(row)}
                    disabled={saving === row.person || (!row.user_id && !row.device_id)}
                    style={[s.teamButton, row.is_team && s.teamButtonOn]}
                    accessibilityLabel={row.is_team ? 'Count as outside' : 'Mark as team'}
                  >
                    <Text style={s.teamText}>{saving === row.person ? '…' : row.is_team ? 'Team' : 'Team?'}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={s.meta}>
                  Seen {seenTime(row.last_seen_at, data.time_zone)} · {signIn} · {plural(row.active_days, 'day')}
                  {` · ${plural(stats?.reads ?? 0, 'read')}`}
                </Text>
              </View>
            );
          })}
          {people.length === 0 ? <Text style={s.empty}>Nobody in this period yet.</Text> : null}
          {people.length > PREVIEW_COUNT ? (
            <TouchableOpacity onPress={() => setShowAll(!showAll)} style={s.more}>
              <Text style={s.moreText}>{showAll ? 'Show fewer' : `${people.length - PREVIEW_COUNT} more`}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <Text style={s.note}>Users = accounts, plus guests who read something or stayed 10+ seconds. Returning = came back on a different day from their first visit. Likely bots = website guests whose browser reports automation, or with no read and no real tap or scroll at a full-screen size with no browser toolbar. Any swipe counts as a read. Website guest reads count from Nov 3.</Text>
      </> : null}
    </View>
  );
}

const s = StyleSheet.create({
  shell: { backgroundColor: '#FCF8F0', borderColor: COLORS.border, borderWidth: 1, borderRadius: 24, padding: 16, gap: 10, marginTop: 6 },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.2 },
  description: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  box: { backgroundColor: COLORS.card, borderColor: '#E7DED1', borderWidth: 1, borderRadius: 18, paddingHorizontal: 11, paddingVertical: 4 },
  headRow: { flexDirection: 'row', paddingVertical: 8 },
  head: { color: COLORS.muted, fontSize: 10, fontWeight: '800', letterSpacing: 0.3, textTransform: 'uppercase', textAlign: 'right' },
  nameCell: { flex: 1.5 },
  usersCell: { flex: 0.8, textAlign: 'right' },
  newCell: { flex: 0.6, textAlign: 'right' },
  returningCell: { flex: 1.15, textAlign: 'right' },
  readsCell: { flex: 0.85, textAlign: 'right' },
  periodRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#EEE7DB', paddingVertical: 9, paddingHorizontal: 4, marginHorizontal: -4 },
  periodRowActive: { backgroundColor: COLORS.greenSoft, borderRadius: 9 },
  periodName: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  periodDay: { color: COLORS.muted, fontSize: 11, marginTop: 1 },
  value: { color: COLORS.text, fontSize: 17, fontWeight: '700' },
  usersValue: { color: COLORS.green, fontSize: 20, fontWeight: '800' },
  note: { color: COLORS.muted, fontSize: 12, lineHeight: 17 },
  peopleTitle: { color: COLORS.text, fontSize: 14, fontWeight: '800', marginTop: 2 },
  person: { paddingVertical: 9 },
  personBorder: { borderTopWidth: 1, borderTopColor: '#EEE7DB' },
  personTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  who: { flex: 1, color: COLORS.text, fontSize: 14, fontWeight: '700' },
  dim: { color: COLORS.muted },
  tag: { borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 },
  tagReturning: { backgroundColor: COLORS.greenSoft },
  tagNew: { backgroundColor: COLORS.blueSoft },
  tagText: { fontSize: 11, fontWeight: '800' },
  teamButton: { borderRadius: 9, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 7, paddingVertical: 2 },
  teamButtonOn: { backgroundColor: '#ECE6DA' },
  teamText: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  meta: { color: COLORS.muted, fontSize: 11.5, lineHeight: 16, marginTop: 3 },
  empty: { color: COLORS.muted, fontSize: 13, textAlign: 'center', paddingVertical: 14 },
  more: { borderTopWidth: 1, borderTopColor: '#EEE7DB', paddingVertical: 10, alignItems: 'center' },
  moreText: { color: COLORS.muted, fontSize: 13, fontWeight: '700' },
  error: { color: '#A94734', fontSize: 13, lineHeight: 18 },
  dayWrap: { borderTopWidth: 1, borderTopColor: '#EEE7DB', marginHorizontal: -4, paddingHorizontal: 4 },
  dayWrapOpen: { backgroundColor: '#F4F1E9', borderRadius: 9 },
  dayRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  dayName: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  chevron: { color: COLORS.green, fontSize: 10 },
  dayValue: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  dayUsers: { fontSize: 17 },
  dayPeople: { paddingBottom: 8 },
  dayPerson: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
});
