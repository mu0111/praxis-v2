import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// One line for everyone, generated once per day from the digest's top stories.
// Returns the source titles too: they go into push_log.meta so later sends
// (blind spot, breaking) can avoid re-pushing a story the digest already led with.
type DigestLine = { line: string; titles: string[] };

async function getOrCreateDigestLine(supabase: ReturnType<typeof createClient>, today: string): Promise<DigestLine> {
  const fallback: DigestLine = { line: '5 stories, 6 minutes.', titles: [] };
  const { data: cached } = await supabase
    .from('push_log')
    .select('meta')
    .eq('push_type', 'digest')
    .gte('sent_at', `${today}T00:00:00Z`)
    .not('meta->>line', 'is', null)
    .limit(1);
  if (cached && cached.length > 0) {
    const meta = cached[0].meta as { line: string; titles?: string[] };
    return { line: meta.line, titles: Array.isArray(meta.titles) ? meta.titles : [] };
  }

  try {
    // Top stories come from the same place the app's Top News feed does —
    // the recommender API. (The original get-or-create-daily-digest edge
    // function was never deployed, so this path silently fell back to the
    // generic line every morning. Found 2026-09-15.)
    const apiBase = (Deno.env.get('RECOMMENDER_API_URL') ?? '').replace(/\/$/, '');
    const apiKey = Deno.env.get('RECOMMENDER_API_KEY');
    if (!apiBase || !apiKey) return fallback;
    const digestRes = await fetch(`${apiBase}/v1/fallback-articles`, {
      headers: { 'X-API-Key': apiKey },
    });
    const digest = await digestRes.json();
    const titles: string[] = (digest?.articles ?? [])
      .map((a: { title?: string; headline?: string }) => a?.title ?? a?.headline)
      .filter(Boolean)
      .slice(0, 5);
    if (titles.length < 3) return fallback;
    const withTitles = (line: string): DigestLine => ({ line, titles });

    // Real headlines beat the generic line even without AI: if OpenAI is
    // unavailable (no key, no credits, outage), send the top 3 titles as a
    // wire brief instead of "5 stories, 6 minutes."
    const trimTitle = (t: string) => {
      const clean = t.replace(/\s+/g, ' ').trim();
      return clean.length <= 48 ? clean : `${clean.slice(0, 45).replace(/[ ,;:–-]+\S*$/, '')}…`;
    };
    const headlineLine = titles.slice(0, 3).map(trimTitle).join('; ');

    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) return withTitles(headlineLine);
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 60,
        temperature: 0.4,
        messages: [
          {
            role: 'user',
            content:
              // Style C — punchy fragments (Ayuka's pick, 2026-09-15): short
              // present-tense sentences, biggest story first, scannable
              // within iOS's ~2-line lock-screen cutoff. The limit needs an
              // example and a per-sentence cap to hold: asking for "max 140
              // characters" alone produced 287 (2026-09-16).
              `You write Praxis's morning push notification. Pick the three biggest stories below and write ONE line of three very short sentences, present tense, biggest first.\nHARD LIMIT: 140 characters for the whole line — it is a phone lock screen, anything longer is cut off. Each sentence must be under 45 characters.\nNo intro phrases, no quotes, no hashtags, no trailing commentary.\n\nExample of the right length: 'Treasury yields hit 5%. Crypto bill stalls in Congress. Voters reject the $5,000 checks.'\n\nHEADLINES:\n${titles.join('\n')}`,
          },
        ],
      }),
    });
    const ai = await aiRes.json();
    const line: string | undefined = ai?.choices?.[0]?.message?.content?.trim();
    if (!line) return withTitles(headlineLine);
    if (line.length <= 150) return withTitles(line);
    // Over budget: keep whole sentences while they fit rather than throwing
    // a good line away and shipping raw headlines instead.
    const kept: string[] = [];
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if ([...kept, sentence].join(' ').length > 140) break;
      kept.push(sentence);
    }
    return withTitles(kept.length > 0 ? kept.join(' ') : headlineLine);
  } catch {
    return fallback;
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

  // Secret-gated test hooks: {"dry_line":true} returns today's alert line
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
      diag.hasOpenai = Boolean(Deno.env.get('OPENAI_API_KEY'));
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
      const digestLine = await getOrCreateDigestLine(supabase, today);
      return new Response(JSON.stringify({ ...digestLine, diag }), {
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
    const guestTokens: string[] = [];
    // A device that registered before sign-in leaves a guest row behind with
    // the same token as its account row; sending to both double-pushes the
    // phone (seen 2026-09-19). The account row wins.
    const ownedTokens = new Set(tokens.filter((t) => t.user_id).map((t) => t.token));
    for (const t of tokens) {
      if (localHour(t.timezone ?? FALLBACK_TIMEZONE) !== targetHour) continue;
      if (!t.user_id) {
        if (!ownedTokens.has(t.token)) guestTokens.push(t.token);
        continue;
      }
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

    const { line, titles } = await getOrCreateDigestLine(supabase, today);

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
              title: 'Praxis',
              body: "Your feed's been busy. 5 stories whenever you're back.",
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
      for (const token of byUser.get(p.id)!) {
        messages.push({
          to: token,
          title: 'Your Daily Digest is ready',
          body: line,
          data: { type: 'digest' },
          sound: 'default',
          badge,
        });
      }
      logRows.push({ user_id: p.id, push_type: 'digest', meta: { line, titles } });
    }

    // Guest devices: one generic line, once a day at their local 8am.
    // No per-user log row (no user), and the hourly window is the dedupe.
    for (const token of guestTokens) {
      messages.push({
        to: token,
        title: 'Your Daily Digest is ready',
        body: line,
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
