import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from '../services/supabase';

// Configure how notifications appear when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

async function storeToken(userId: string | null): Promise<void> {
  const { data: token } = await Notifications.getExpoPushTokenAsync();
  if (!token) return;

  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const row = {
    token,
    platform,
    timezone: deviceTimezone(),
    updated_at: new Date().toISOString(),
  };

  if (userId) {
    // Signing in claims this device's guest token, if one exists.
    const { data: claimed } = await supabase
      .from('push_tokens')
      .update({ user_id: userId, ...row })
      .eq('token', token)
      .is('user_id', null)
      .select('id');
    if (claimed && claimed.length > 0) return;
    await supabase.from('push_tokens').upsert(
      { user_id: userId, ...row },
      { onConflict: 'user_id,token' }
    );
  } else {
    // Guest: the token belongs to the device until an account claims it.
    const { data: existing } = await supabase
      .from('push_tokens')
      .select('id')
      .eq('token', token)
      .is('user_id', null)
      .maybeSingle();
    if (existing) return;
    await supabase.from('push_tokens').insert({ user_id: null, ...row });
  }
}

// Silent: stores a token (with the device timezone) only when permission is
// already granted. Never shows the system dialog — that is askPushPermission's
// job, and it only runs from the in-app card after the first completed digest.
// Pass null for guests; a later sign-in claims the device token.
export async function registerPushToken(userId: string | null): Promise<void> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    await storeToken(userId);
  } catch {
    // Non-fatal — push is a best-effort feature
  }
}

// Explicit: triggers the system permission dialog. Call only after the user
// tapped "Yes, remind me" on the in-app card. Returns whether we got it.
export async function askPushPermission(userId: string | null): Promise<boolean> {
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return false;
    await storeToken(userId);
    return true;
  } catch {
    return false;
  }
}

// The app-icon badge shows the reading streak (Ayuka, 9/20: "like a regular
// notification icon for the streak"). iOS only honours it once notifications
// were allowed; without that this is a silent no-op. 0 clears the badge.
// The morning digest push carries the same number so it stays right between
// launches (send-daily-digest-push sets `badge`).
export async function syncStreakBadge(streak: number | null | undefined): Promise<void> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    const value = Math.max(0, Math.floor(Number(streak) || 0));
    await Notifications.setBadgeCountAsync(value);
  } catch {
    // Non-fatal — the badge is decoration
  }
}

export async function unregisterPushToken(userId: string): Promise<void> {
  try {
    const { data } = await Notifications.getExpoPushTokenAsync();
    if (!data) return;
    await supabase.from('push_tokens').delete()
      .eq('user_id', userId)
      .eq('token', data);
  } catch {
    // Non-fatal
  }
}
