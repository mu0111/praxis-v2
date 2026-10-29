import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { STREAK_LINES, streakCopy } from '../_shared/pushFormat.ts';

// Runs hourly via pg_cron (minute 30). Sends the evening streak saver at
// 8:30pm local, only when the streak is real and today's digest isn't done.
// Spec: work/praxis/notifications-spec-final-2026-09-10.md (Ada, approved by Ayuka).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-praxis-cron-secret',
};

const TARGET_LOCAL_HOUR = 20; // fires at :30 past, so 8:30pm local
const FALLBACK_TIMEZONE = 'America/New_York';
const MIN_GAP_HOURS = 6;
const DAILY_CAP = 3;

function nyDateKey(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function localHour(timezone: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date())
    );
  } catch {
    return -1;
  }
}

async function chunkedExpoSend(messages: unknown[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100)),
    });
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const secret = Deno.env.get('PRAXIS_CRON_SECRET');
  if (secret && req.headers.get('x-praxis-cron-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const today = nyDateKey();
    const yesterday = nyDateKey(new Date(Date.now() - 86400000));

    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('user_id, token, timezone');
    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const byUser = new Map<string, string[]>();
    for (const t of tokens) {
      if (!t.user_id) continue; // guests have no streak to save
      if (localHour(t.timezone ?? FALLBACK_TIMEZONE) !== TARGET_LOCAL_HOUR) continue;
      const list = byUser.get(t.user_id) ?? [];
      list.push(t.token);
      byUser.set(t.user_id, list);
    }
    if (byUser.size === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userIds = [...byUser.keys()];

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, notify_streak, current_streak, streak_last_completed_date')
      .in('id', userIds);

    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    const { data: recentPushes } = await supabase
      .from('push_log')
      .select('user_id, push_type, sent_at, meta')
      .in('user_id', userIds)
      .gte('sent_at', since);

    const messages: unknown[] = [];
    const logRows: unknown[] = [];

    for (const p of profiles ?? []) {
      if (p.notify_streak === false) continue;
      const streak = p.current_streak ?? 0;
      if (streak < 2) continue; // nothing worth saving
      // Streak is live only if yesterday was completed; today not yet done.
      if (p.streak_last_completed_date !== yesterday) continue;

      const mine = (recentPushes ?? []).filter((x) => x.user_id === p.id);
      const sentToday = mine.some(
        (x) => x.push_type === 'streak' && nyDateKey(new Date(x.sent_at)) === today
      );
      if (sentToday) continue;

      // Shares the news pushes' cap of 3 a day (send-news-push DAILY_CAP).
      const pushedToday = mine.filter(
        (x) => ['digest', 'streak', 'news', 'breaking', 'split'].includes(x.push_type) &&
          nyDateKey(new Date(x.sent_at)) === today
      ).length;
      if (pushedToday >= DAILY_CAP) continue;

      // At least 6 hours after the morning push.
      const lastDigestPush = mine
        .filter((x) => x.push_type === 'digest')
        .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))[0];
      if (lastDigestPush && Date.now() - Date.parse(lastDigestPush.sent_at) < MIN_GAP_HOURS * 3600000) {
        continue;
      }

      // Rotate copy; never repeat yesterday's line.
      const lastStreakPush = mine
        .filter((x) => x.push_type === 'streak')
        .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))[0];
      const lastIdx = (lastStreakPush?.meta as { lineIdx?: number } | null)?.lineIdx ?? -1;
      let idx = Math.floor(Math.random() * STREAK_LINES.length);
      if (idx === lastIdx) idx = (idx + 1) % STREAK_LINES.length;

      for (const token of byUser.get(p.id)!) {
        messages.push({
          to: token,
          ...streakCopy(streak, idx),
          data: { type: 'streak' },
          sound: 'default',
        });
      }
      logRows.push({ user_id: p.id, push_type: 'streak', meta: { lineIdx: idx } });
    }

    if (messages.length > 0) {
      await chunkedExpoSend(messages);
      await supabase.from('push_log').insert(logRows);
    }

    return new Response(JSON.stringify({ sent: messages.length, users: logRows.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
