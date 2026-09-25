import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Quiet hours (10pm-7am local, per stored device timezone) — never ping at night.
const inQuietHours = (timezone: string | null) => {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone ?? 'America/New_York', hour: 'numeric', hourCycle: 'h23',
    }).format(new Date()));
    return hour >= 22 || hour < 7;
  } catch {
    return false;
  }
};

// Called via Supabase Webhook when a row is inserted into the `follows` table.
// Payload shape: { type: 'INSERT', record: { follower_id, following_id } }
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const { follower_id, following_id } = payload.record ?? payload;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Only push for a follow that really exists, so a direct call can't fake one.
    const { data: follow } = await supabase
      .from('follows')
      .select('follower_id')
      .eq('follower_id', follower_id)
      .eq('following_id', following_id)
      .limit(1);
    if (!follow?.length) {
      return new Response(JSON.stringify({ sent: 0, error: 'No matching follow' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Respect the followed user's social switch, and collapse to one social push/hour.
    // (Blocked pairs can't create follows rows at all — DB trigger — so no block check here.)
    const { data: followedProfile } = await supabase
      .from('profiles')
      .select('notify_social')
      .eq('id', following_id)
      .single();
    if (followedProfile?.notify_social === false) {
      return new Response(JSON.stringify({ sent: 0, muted: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const { data: recentSocial } = await supabase
      .from('push_log')
      .select('id')
      .eq('user_id', following_id)
      .eq('push_type', 'social')
      .gte('sent_at', hourAgo)
      .limit(1);
    if (recentSocial && recentSocial.length > 0) {
      return new Response(JSON.stringify({ sent: 0, collapsed: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get follower's display name
    const { data: follower } = await supabase
      .from('profiles')
      .select('full_name, username')
      .eq('id', follower_id)
      .single();

    const followerName = follower?.full_name ?? follower?.username ?? 'Someone';

    // Get push tokens for the person being followed
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token, timezone')
      .eq('user_id', following_id);

    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const awake = tokens.filter((t: { token: string; timezone: string | null }) => !inQuietHours(t.timezone));
    if (awake.length === 0) {
      return new Response(JSON.stringify({ sent: 0, quiet: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Send Expo push notifications
    const messages = awake.map(({ token }: { token: string }) => ({
      to: token,
      title: 'New Follower',
      body: `${followerName} started following you`,
      data: { type: 'follow', followerId: follower_id },
      sound: 'default',
    }));

    const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });

    const result = await expoRes.json();
    await supabase.from('push_log').insert({ user_id: following_id, push_type: 'social', meta: { kind: 'follow' } });
    return new Response(JSON.stringify({ sent: awake.length, result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
