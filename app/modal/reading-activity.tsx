import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';
import {
  readReadingActivitySummary,
  subscribeReadingActivity,
  toLocalDateKey,
  type ReadingActivitySummary,
} from '../lib/readingActivity';

const EMPTY_SUMMARY: ReadingActivitySummary = {
  totalArticlesRead: 0,
  currentStreak: 0,
  readsToday: 0,
  readsThisWeek: 0,
  weekBuckets: [],
  topTopics: [],
};

export default function ReadingActivityModal() {
  const { isGuestMode, user, profile } = useAuth();
  const { c } = useTheme();
  const [summary, setSummary] = useState<ReadingActivitySummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isActive = true;

    void readReadingActivitySummary(user?.id).then((nextSummary) => {
      if (!isActive) return;
      setSummary(nextSummary);
      setLoading(false);
    });

    const unsubscribe = subscribeReadingActivity(user?.id, (nextSummary) => {
      setSummary(nextSummary);
      setLoading(false);
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [user?.id]);

  const weekData = summary.weekBuckets;
  const topTopics = summary.topTopics;
  const maxCount = Math.max(...weekData.map((day) => day.count), 1);
  const displayTotalRead = Math.max(profile?.articles_read ?? 0, summary.totalArticlesRead);
  const displayStreak = profile ? (profile.current_streak ?? 0) : summary.currentStreak;
  const dailyGoal = profile?.daily_goal ?? 5;
  const goalProgress = Math.min((summary.readsToday / Math.max(dailyGoal, 1)) * 100, 100);
  const hasActivity = displayTotalRead > 0;

  const helperCopy = useMemo(() => {
    if (profile) {
      return 'Progress reflects this device first and stays aligned with your account when profile data is available.';
    }

    if (isGuestMode || !user) {
      return 'Reading activity is being tracked locally in safe mode on this device.';
    }

    return 'Reading activity is being tracked locally on this device.';
  }, [isGuestMode, profile, user]);

  return (
    <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
      <View style={s.header}>
        <Text style={[s.title, { color: c.text }]}>Reading Activity</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={[s.done, { color: c.tint }]}>Done</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={c.tint} style={{ flex: 1 }} />
      ) : (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={[s.helperText, { color: c.textMuted }]}>{helperCopy}</Text>

          <View style={[s.statsRow, { backgroundColor: c.card, borderColor: c.border }]}>
            {[
              { label: 'This Week', value: summary.readsThisWeek },
              { label: 'Total Read', value: displayTotalRead },
              { label: 'Day Streak', value: displayStreak },
            ].map((stat, i, arr) => (
              <View
                key={stat.label}
                style={[s.stat, i < arr.length - 1 && { borderRightWidth: 1, borderRightColor: c.border }]}
              >
                <Text style={[s.statNum, { color: c.tint }]}>{stat.value}</Text>
                <Text style={[s.statLabel, { color: c.textMuted }]}>{stat.label}</Text>
              </View>
            ))}
          </View>

          <View style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[s.cardTitle, { color: c.text }]}>Last 7 Days</Text>
            {weekData.length > 0 ? (
              <View style={s.chart}>
                {weekData.map((day) => {
                  const heightPct = (day.count / maxCount) * 100;
                  const isToday = day.date === toLocalDateKey(new Date());
                  return (
                    <View key={day.date} style={s.barCol}>
                      <Text style={[s.barCount, { color: day.count > 0 ? c.tint : c.textMuted }]}>
                        {day.count > 0 ? day.count : ''}
                      </Text>
                      <View style={[s.barTrack, { backgroundColor: c.secondary }]}>
                        <View
                          style={[
                            s.barFill,
                            {
                              backgroundColor: isToday ? c.tint : c.tint + '80',
                              height: `${heightPct}%` as any,
                            },
                          ]}
                        />
                      </View>
                      <Text style={[s.barLabel, { color: isToday ? c.tint : c.textMuted, fontWeight: isToday ? '700' : '400' }]}>
                        {day.day}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={[s.emptyText, { color: c.textMuted }]}>
                Read a few cards and your weekly activity will show up here.
              </Text>
            )}
          </View>

          <View style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[s.cardTitle, { color: c.text }]}>Daily Goal</Text>
            <Text style={[s.goalSub, { color: c.textMuted }]}>
              {summary.readsToday} / {dailyGoal} articles today
            </Text>
            <View style={[s.goalTrack, { backgroundColor: c.secondary }]}>
              <View
                style={[
                  s.goalFill,
                  {
                    backgroundColor: c.tint,
                    width: `${goalProgress}%` as any,
                  },
                ]}
              />
            </View>
          </View>

          <View style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[s.cardTitle, { color: c.text }]}>Top Topics This Week</Text>
            {topTopics.length > 0 ? topTopics.map((topic, index) => (
              <View key={topic.topic} style={s.topicRow}>
                <Text style={[s.topicRank, { color: c.textMuted }]}>{index + 1}</Text>
                <Text style={[s.topicName, { color: c.text }]}>{topic.topic}</Text>
                <View style={[s.topicBarWrap, { backgroundColor: c.secondary }]}>
                  <View
                    style={[
                      s.topicBar,
                      { backgroundColor: c.tint, width: `${(topic.count / topTopics[0].count) * 100}%` as any },
                    ]}
                  />
                </View>
                <Text style={[s.topicCount, { color: c.textMuted }]}>{topic.count}</Text>
              </View>
            )) : (
              <Text style={[s.emptyText, { color: c.textMuted }]}>
                Topic trends will appear after you read across a few stories.
              </Text>
            )}
          </View>

          {!hasActivity ? (
            <View style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
              <Text style={[s.cardTitle, { color: c.text }]}>Getting Started</Text>
              <Text style={[s.emptyText, { color: c.textMuted }]}>
                Swipe through cards or open an article to start building your reading history, streak, and weekly topic mix.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
  },
  title: { fontSize: 22, fontWeight: '700' },
  done: { fontSize: 16 },
  content: { paddingHorizontal: 16, gap: 16, paddingBottom: 32 },
  helperText: { fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  statsRow: { flexDirection: 'row', borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 20 },
  statNum: { fontSize: 28, fontWeight: '800' },
  statLabel: { fontSize: 12, marginTop: 2 },
  card: { borderRadius: 16, borderWidth: 1, padding: 18, gap: 14 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 120 },
  barCol: { flex: 1, alignItems: 'center', gap: 4 },
  barCount: { fontSize: 10, fontWeight: '600' },
  barTrack: { flex: 1, width: '70%', borderRadius: 4, overflow: 'hidden', minHeight: 4, justifyContent: 'flex-end' },
  barFill: { width: '100%', borderRadius: 4, minHeight: 4 },
  barLabel: { fontSize: 11 },
  topicRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  topicRank: { width: 16, fontSize: 12, textAlign: 'center' },
  topicName: { width: 96, fontSize: 13, fontWeight: '500' },
  topicBarWrap: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  topicBar: { height: 8, borderRadius: 4 },
  topicCount: { fontSize: 12, width: 24, textAlign: 'right' },
  emptyText: { fontSize: 13, lineHeight: 20 },
  goalSub: { fontSize: 13 },
  goalTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  goalFill: { height: 8, borderRadius: 4 },
});
