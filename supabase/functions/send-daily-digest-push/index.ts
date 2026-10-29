import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { digestCopy, type FeedArticle, pickDigestLead, winbackCopy } from '../_shared/pushFormat.ts';

// Runs hourly via pg_cron (minute 0). Sends the morning digest push to users
// whose local time is 8am, whose digest isn't done, and who haven't opted out.
// Spec: work/praxis/notifications-spec-final-2026-09-10.md (Ada, approved by Ayuka).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-praxis-cron-secret',
};

const TARGET_LOCAL_HOUR = 8;
const FALLBACK_TIMEZONE = 'America/New_York';

// The digest day is keyed to New York everywhere in the app.
function nyDateKey(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function localHour(timezone: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date())
    );
  } catch {
    return -1; // bad timezone string — skip rather than spam at a wrong hour
  }
}

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86400000);
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

// One lead story for everyone, picked once per day the way the app picks
// the digest's first card. Logged with the digest's other titles in
// push_log.meta so later sends (evening, breaking, blind spot) skip stories
// the digest already covers, and so tomorrow's lead isn't today's again.
type DigestLead = { lead: FeedArticle | null; titles: string[] };

async function getOrPickDigestLead(supabase: ReturnType<typeof createClient>, today: string): Promise<DigestLead> {
  const { data: cached } = await supabase
    .from('push_log')
    .select('meta')
    .eq('push_type', 'digest')
    .gte('sent_at', `${today}T00:00:00Z`)
    .eq('meta->>v', '2')
    .limit(1);
  if (cached && cached.length > 0) {
    const meta = cached[0].meta as { lead?: FeedArticle; titles?: string[] };
    return { lead: meta.lead ?? null, titles: Array.isArray(meta.titles) ? meta.titles : [] };
  }

  try {
    // Top stories come from the same place the app's Top News feed does —
    // the recommender API.
    const apiBase = (Deno.env.get('RECOMMENDER_API_URL') ?? '').replace(/\/$/, '');
    const apiKey = Deno.env.get('RECOMMENDER_API_KEY');
    if (!apiBase || !apiKey) return { lead: null, titles: [] };
    const feedRes = await fetch(`${apiBase}/v1/fallback-articles`, {
      headers: { 'X-API-Key': apiKey },
    });
    const articles: FeedArticle[] = (await feedRes.json())?.articles ?? [];

    // The last two mornings' leads and digest titles count as repeats.
    const since = new Date(Date.now() - 2 * 86400000).toISOString();
    const { data: recent } = await supabase
      .from('push_log')
      .select('meta')
      .eq('push_type', 'digest')
      .gte('sent_at', since)
      .limit(500);
    const recentTitles = [...new Set(
      (recent ?? []).flatMap((row) => {
        const titles = (row.meta as { titles?: unknown })?.titles;
        return Array.isArray(titles) ? titles.filter((t): t is string => typeof t === 'string') : [];
      })
    )];

    const lead = pickDigestLead(articles, recentTitles);
    const titles = [
      ...(lead ? [lead.title] : []),
      ...articles.map((a) => a.title).filter((t) => t && t !== lead?.title).slice(0, 4),
    ];
    return { lead, titles };
  } catch {
    return { lead: null, titles: [] };
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

  // Secret-gated test hooks: {"dry_line":true} returns today's push copy
  // without sending anything; {"force_hour":N} targets local hour N instead
  // of 8 so the full pipeline can be exercised outside the morning window.
  let targetHour = TARGET_LOCAL_HOUR;
  let dryLine = false;
  try {
    const body = await req.json();
    if (secret && req.headers.get('x-praxis-cron-secret') === secret) {
      if (typeof body?.force_hour === 'number') targetHour = body.force_hour;
      if (body?.dry_line === true) dryLine = true;
    }
  } catch {
    // no/invalid body — the normal cron case
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const today = nyDateKey();

    if (dryLine) {
      const diag: Record<string, unknown> = {};
      const apiBase = (Deno.env.get('RECOMMENDER_API_URL') ?? '').replace(/\/$/, '');
      diag.hasBase = Boolean(apiBase);
      diag.hasKey = Boolean(Deno.env.get('RECOMMENDER_API_KEY'));
      try {
        const r = await fetch(`${apiBase}/v1/fallback-articles`, {
          headers: { 'X-API-Key': Deno.env.get('RECOMMENDER_API_KEY') ?? '' },
        });
        diag.fetchStatus = r.status;
        const j = await r.json();
        diag.titleCount = (j?.articles ?? []).length;
      } catch (e) {
        diag.fetchError = String(e);
      }
      const { lead, titles } = await getOrPickDigestLead(supabase, today);
      return new Response(JSON.stringify({ ...digestCopy(lead, FALLBACK_TIMEZONE), titles, diag }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('user_id, token, timezone');
    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Users with at least one device currently at the target local hour.
    // Guest devices (no account yet) get the same morning push, sent blind —
    // their reading lives on-device, so there is no completion state to check.
    const byUser = new Map<string, string[]>();
    const guestTokens: Array<{ token: string; timezone: string }> = [];
    const timezoneByUser = new Map<string, string>();
    // A device that registered before sign-in leaves a guest row behind with
    // the same token as its account row; sending to both double-pushes the
    // phone (seen 2026-09-19). The account row wins.
    const ownedTokens = new Set(tokens.filter((t) => t.user_id).map((t) => t.token));
    for (const t of tokens) {
      if (localHour(t.timezone ?? FALLBACK_TIMEZONE) !== targetHour) continue;
      if (!t.user_id) {
        if (!ownedTokens.has(t.token)) {
          guestTokens.push({ token: t.token, timezone: t.timezone ?? FALLBACK_TIMEZONE });
        }
        continue;
      }
      timezoneByUser.set(t.user_id, t.timezone ?? FALLBACK_TIMEZONE);
      const list = byUser.get(t.user_id) ?? [];
      list.push(t.token);
      byUser.set(t.user_id, list);
    }
    if (byUser.size === 0 && guestTokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userIds = [...byUser.keys()];

    const { data: profiles } = userIds.length > 0
      ? await supabase
          .from('profiles')
          .select('id, notify_digest, streak_last_completed_date, current_streak')
          .in('id', userIds)
      : { data: [] };

    // Recent push history for lapse rules + dedupe (14 days is enough for every rule).
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recentPushes } = userIds.length > 0
      ? await supabase
          .from('push_log')
          .select('user_id, push_type, sent_at')
          .in('user_id', userIds)
          .gte('sent_at', since)
      : { data: [] };

    const pushesFor = (uid: string, type: string) =>
      (recentPushes ?? []).filter((p) => p.user_id === uid && p.push_type === type);

    const { lead, titles } = await getOrPickDigestLead(supabase, today);
    // Only what later sends need: the full feed row would bloat every log row.
    const leadMeta = lead
      ? { article_id: lead.article_id, cluster_id: lead.cluster_id, title: lead.title, reasons: lead.reasons ?? [] }
      : null;

    const messages: unknown[] = [];
    const logRows: unknown[] = [];

    for (const p of profiles ?? []) {
      if (p.notify_digest === false) continue;
      if (p.streak_last_completed_date === today) continue; // today's digest already done

      const digestPushes = pushesFor(p.id, 'digest');
      const sentToday = digestPushes.some((x) => nyDateKey(new Date(x.sent_at)) === today);
      if (sentToday) continue;

      const lastDone = p.streak_last_completed_date as string | null;
      const daysSilent = lastDone ? daysBetween(lastDone, today) : null;

      // 7 days without a completed digest: daily pushes stop. One win-back on day 8.
      if (daysSilent !== null && daysSilent > 7) {
        const winbacks = pushesFor(p.id, 'winback');
        const winbackSinceLapse = winbacks.some(
          (x) => lastDone && nyDateKey(new Date(x.sent_at)) > lastDone
        );
        if (daysSilent === 8 && !winbackSinceLapse) {
          for (const token of byUser.get(p.id)!) {
            messages.push({
              to: token,
              ...winbackCopy(),
              data: { type: 'digest' },
              sound: 'default',
            });
          }
          logRows.push({ user_id: p.id, push_type: 'winback', meta: {} });
        }
        continue;
      }

      // Morning push pauses after 3 consecutive ignored days (pushed, never completed).
      const lastThreeDays = [1, 2, 3].map((n) => nyDateKey(new Date(Date.now() - n * 86400000)));
      const ignoredThree = lastThreeDays.every((day) =>
        digestPushes.some((x) => nyDateKey(new Date(x.sent_at)) === day)
      ) && (!lastDone || lastDone < lastThreeDays[2]);
      if (ignoredThree) continue;

      // The app-icon badge is the reading streak (app/utils/notifications.ts
      // syncStreakBadge). Carrying it here keeps the number right on days the
      // app was not opened; a lapsed streak arrives as 0 and clears the badge.
      const badge = Math.max(0, Number(p.current_streak) || 0);
      const copy = digestCopy(lead, timezoneByUser.get(p.id) ?? FALLBACK_TIMEZONE);
      for (const token of byUser.get(p.id)!) {
        messages.push({
          to: token,
          ...copy,
          data: { type: 'digest' },
          sound: 'default',
          badge,
        });
      }
      // v:2 marks the one-story format; `line` stays for the evening dedupe.
      logRows.push({ user_id: p.id, push_type: 'digest', meta: { v: 2, line: copy.body, titles, lead: leadMeta } });
    }

    // Guest devices: the same lead story, once a day at their local 8am.
    // No per-user log row (no user), and the hourly window is the dedupe.
    for (const { token, timezone } of guestTokens) {
      messages.push({
        to: token,
        ...digestCopy(lead, timezone),
        data: { type: 'digest' },
        sound: 'default',
      });
    }

    if (messages.length > 0) {
      await chunkedExpoSend(messages);
      if (logRows.length > 0) {
        await supabase.from('push_log').insert(logRows);
      }
    }

    return new Response(JSON.stringify({ sent: messages.length, users: logRows.length, guests: guestTokens.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
