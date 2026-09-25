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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { senderId, recipientId, message } = await req.json();
    if (!senderId || !recipientId || !message) {
      return new Response(JSON.stringify({ error: 'senderId, recipientId, message required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // The caller must be the signed-in sender, and the push must match a message they
    // actually sent, so nobody can push arbitrary text to a user by calling this directly.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const { data: { user: caller } } = await supabase.auth.getUser(token);
    if (!caller || caller.id !== senderId) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data: sent } = await supabase
      .from('messages')
      .select('id')
      .eq('sender_id', senderId)
      .eq('recipient_id', recipientId)
      .eq('body', message)
      .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .limit(1);
    if (!sent?.length) {
      return new Response(JSON.stringify({ error: 'No matching message' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // No pushes between blocked pairs, and respect the recipient's social switch
    const { data: blocked } = await supabase.rpc('is_blocked_pair', { a: senderId, b: recipientId });
    if (blocked) {
      return new Response(JSON.stringify({ sent: 0, blocked: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data: recipientProfile } = await supabase
      .from('profiles')
      .select('notify_social')
      .eq('id', recipientId)
      .single();
    if (recipientProfile?.notify_social === false) {
      return new Response(JSON.stringify({ sent: 0, muted: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Collapse: at most one social push per recipient per hour
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const { data: recentSocial } = await supabase
      .from('push_log')
      .select('id')
      .eq('user_id', recipientId)
      .eq('push_type', 'social')
      .gte('sent_at', hourAgo)
      .limit(1);
    if (recentSocial && recentSocial.length > 0) {
      return new Response(JSON.stringify({ sent: 0, collapsed: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get sender's display name
    const { data: sender } = await supabase
      .from('profiles')
      .select('full_name, username')
      .eq('id', senderId)
      .single();

    const senderName = sender?.full_name ?? sender?.username ?? 'Someone';

    // Get recipient's push tokens
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token, timezone')
      .eq('user_id', recipientId);

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

    const messages = awake.map(({ token }: { token: string }) => ({
      to: token,
      title: senderName,
      body: message.length > 80 ? message.slice(0, 77) + '...' : message,
      data: { type: 'message', senderId },
      sound: 'default',
    }));

    const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });

    const result = await expoRes.json();
    await supabase.from('push_log').insert({ user_id: recipientId, push_type: 'social', meta: { kind: 'message' } });
    return new Response(JSON.stringify({ sent: awake.length, result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
