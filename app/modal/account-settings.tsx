import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { GlassSurface } from '../components/GlassSurface';
import { supabase } from '../services/supabase';

import Constants from 'expo-constants';
import { hasLiquidGlass } from '../components/GlassSurface';

const appVersion = `${Constants.expoConfig?.version ?? '2.0.0'} (${
  (Constants.expoConfig as { ios?: { buildNumber?: string } } | null)?.ios?.buildNumber ?? '—'
})`;
const TERMS_URL = 'https://praxisnews.co/terms.html';
const PRIVACY_URL = 'https://praxisnews.co/privacy.html';

const PAGE = {
  background: '#F7F3EA',
  card: '#FBF7F0',
  surface: '#FFFDFC',
  text: '#2E2A25',
  textSecondary: '#5D554C',
  textMuted: '#8E857A',
  border: '#E7DEC9',
  destructive: '#B8513A',
};

type SettingsRow = {
  id: string;
  label: string;
  hint?: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
  external?: boolean;
  // Renders a switch in place of the chevron; onPress flips it.
  toggle?: boolean;
};

export default function AccountSettingsModal() {
  const { isGuestMode, loading, profile, signOut, updateProfile, user } = useAuth();
  const [busyAction, setBusyAction] = useState<'signout' | 'delete' | null>(null);
  // Set while this screen itself is ending the session. Sign-out used to fire
  // three root-stack replaces at once (this effect, performSignOut, and
  // RootRedirect in _layout), and the sheet went blank mid-flight, which
  // showed as a second page flashing under the login screen. During a
  // deliberate sign-out this screen stays painted and does not navigate;
  // RootRedirect performs the single replace once the session is gone.
  const leavingRef = useRef(false);

  useEffect(() => {
    if (loading || leavingRef.current) return;
    if (isGuestMode || !user) {
      router.replace({ pathname: '/login', params: { returnTo: '/profile' } });
    }
  }, [isGuestMode, loading, user]);

  if (loading || ((isGuestMode || !user) && !leavingRef.current)) return null;

  const performSignOut = async () => {
    setBusyAction('signout');
    leavingRef.current = true;
    try {
      await signOut();
    } catch (error: any) {
      leavingRef.current = false;
      Alert.alert('Sign out failed', error?.message ?? 'Could not sign out.');
    } finally {
      setBusyAction(null);
    }
  };

  const confirmSignOut = () => {
    // React Native's native alert confirmation is not reliably interactive in
    // the Expo web preview, so let the browser run the same sign-out action.
    if (Platform.OS === 'web') {
      void performSignOut();
      return;
    }

    Alert.alert(
      'Sign out?',
      'You will be signed out of Praxis on this device and returned to the sign-in screen.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          onPress: () => void performSignOut(),
        },
      ],
    );
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete account?',
      'This permanently deletes your Praxis account and associated profile data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: async () => {
            setBusyAction('delete');
            leavingRef.current = true;
            try {
              const { error } = await supabase.functions.invoke('delete-account', { body: {} });
              if (error) throw error;
              await signOut();
            } catch (error: any) {
              leavingRef.current = false;
              Alert.alert('Delete failed', error?.message ?? 'Could not delete your account.');
            } finally {
              setBusyAction(null);
            }
          },
        },
      ],
    );
  };

  const notifSummary = [
    profile?.notify_digest !== false && 'digest',
    profile?.notify_news !== false && 'news',
    profile?.notify_streak !== false && 'streak',
    profile?.notify_social !== false && 'social',
  ].filter(Boolean);

  // Moved off the Profile page, where it sat as a bare button under the
  // bio (Ayuka, 2026-09-19): a reset is a settings action, not something
  // to brush against while reading your own profile.
  const confirmResetOnboarding = () => {
    Alert.alert(
      'Reset onboarding?',
      'You will choose your interests again before returning to the feed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          onPress: async () => {
            try {
              await updateProfile({ onboarding_complete: false });
              router.replace({ pathname: '/onboarding', params: { returnTo: '/' } } as any);
            } catch (error: any) {
              Alert.alert('Reset failed', error?.message ?? 'Could not reset onboarding.');
            }
          },
        },
      ],
    );
  };

  const sections: { title: string | null; rows: SettingsRow[] }[] = [
    {
      title: 'ACCOUNT',
      rows: [
        {
          id: 'edit',
          label: 'Edit Profile',
          icon: 'pencil-outline',
          onPress: () => router.push('/modal/edit-profile'),
        },
        {
          id: 'password',
          label: 'Change Password',
          icon: 'key-outline',
          onPress: () => router.push('/modal/change-password'),
        },
        {
          id: 'signout',
          label: 'Sign Out',
          icon: 'log-out-outline',
          onPress: confirmSignOut,
        },
      ],
    },
    {
      title: 'PREFERENCES',
      rows: [
        {
          id: 'notifications',
          label: 'Notifications',
          hint: notifSummary.length === 4
            ? 'Digest, news, streak, social — all on.'
            : notifSummary.length === 0
              ? 'All off.'
              : `On: ${notifSummary.join(', ')}.`,
          icon: 'notifications-outline',
          onPress: () => router.push('/modal/notification-settings'),
        },
        {
          id: 'leaderboard',
          label: 'Show Me on the Leaderboard',
          hint: 'Your name, @username, photo, streak and articles read.',
          icon: 'trophy-outline',
          toggle: profile?.show_on_leaderboard === true,
          onPress: () => {
            void updateProfile({ show_on_leaderboard: profile?.show_on_leaderboard !== true })
              .catch((error: any) => Alert.alert('Could not update', error?.message ?? 'Try again.'));
          },
        },
        {
          id: 'reset-onboarding',
          label: 'Reset Onboarding',
          hint: 'Choose your interests again.',
          icon: 'refresh-outline',
          onPress: confirmResetOnboarding,
        },
      ],
    },
    {
      title: 'ABOUT',
      rows: [
        {
          id: 'terms',
          label: 'Terms of Service',
          icon: 'document-text-outline',
          external: true,
          onPress: () => void Linking.openURL(TERMS_URL),
        },
        {
          id: 'privacy',
          label: 'Privacy Policy',
          icon: 'shield-checkmark-outline',
          external: true,
          onPress: () => void Linking.openURL(PRIVACY_URL),
        },
        {
          id: 'build',
          // Says out loud whether iOS granted this build the Liquid Glass
          // material — otherwise "the glass looks flat" is unfalsifiable
          // from a screenshot.
          label: `Version ${appVersion} · Glass ${hasLiquidGlass ? 'on' : 'off'}`,
          icon: 'information-circle-outline',
          onPress: () => {},
        },
      ],
    },
    {
      title: null,
      rows: [
        {
          id: 'delete',
          label: 'Delete Account',
          icon: 'trash-outline',
          destructive: true,
          onPress: confirmDelete,
        },
      ],
    },
  ];

  return (
    <SafeAreaView style={s.overlay}>
      <GlassSurface style={s.sheet} tintColor="rgba(247,243,234,0.55)" fallbackStyle={s.sheetFallback}>
        <View style={s.handle} />
        <View style={s.header}>
          <View style={s.headerCopy}>
            <Text style={s.title}>Settings</Text>
            <Text style={s.subtitle}>
              {user?.email ? `Signed in as ${user.email}.` : 'Manage your account.'}
            </Text>
          </View>
          <TouchableOpacity style={s.closeButton} onPress={() => router.back()} accessibilityLabel="Close settings">
            <Ionicons name="close" size={22} color={PAGE.text} />
          </TouchableOpacity>
        </View>

        {/* The sheet grew with every added row until it pressed the title
            against the status bar with nothing scrollable (Ayuka,
            2026-09-19, msg 1503). The handle and header stay pinned; the
            rows scroll inside a capped sheet. */}
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scrollContent}>
        {sections.map((section, sectionIndex) => (
          <View key={section.title ?? `section-${sectionIndex}`}>
            {section.title ? (
              <Text style={s.sectionLabel}>{section.title}</Text>
            ) : (
              <View style={s.sectionSpacer} />
            )}
            <View style={s.list}>
              {section.rows.map((item, index) => {
                const destructive = Boolean(item.destructive);
                const busy = busyAction === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[s.row, index > 0 && s.rowBorder]}
                    onPress={item.onPress}
                    disabled={Boolean(busyAction)}
                    activeOpacity={0.78}
                  >
                    <View style={[s.iconWrap, destructive && s.destructiveIconWrap]}>
                      {busy ? (
                        <ActivityIndicator color={destructive ? PAGE.destructive : PAGE.text} size="small" />
                      ) : (
                        <Ionicons name={item.icon} size={18} color={destructive ? PAGE.destructive : PAGE.text} />
                      )}
                    </View>
                    <View style={s.rowCopy}>
                      <Text style={[s.rowLabel, destructive && s.destructiveText]}>{item.label}</Text>
                      {item.hint ? <Text style={s.rowHint}>{item.hint}</Text> : null}
                    </View>
                    {item.toggle !== undefined ? (
                      <Switch
                        value={item.toggle}
                        onValueChange={item.onPress}
                        disabled={Boolean(busyAction)}
                        trackColor={{ true: '#8EAF72' }}
                      />
                    ) : destructive ? null : (
                      <Ionicons
                        name={item.external ? 'open-outline' : 'chevron-forward'}
                        size={item.external ? 17 : 20}
                        color={PAGE.textMuted}
                      />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}
        </ScrollView>
      </GlassSurface>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(46,42,37,0.22)', justifyContent: 'flex-end' },
  sheet: {
    overflow: 'hidden',
    width: '100%',
    // A sheet, not a takeover: the top ~12% of the page stays visible
    // behind it however many rows settings grows.
    maxHeight: '88%',
    maxWidth: 520,
    alignSelf: 'center',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 30,
    borderWidth: 1,
    borderColor: PAGE.border,
  },
  sheetFallback: { backgroundColor: PAGE.background },
  scrollContent: { paddingBottom: 8 },
  handle: { width: 42, height: 5, borderRadius: 3, backgroundColor: '#D6CDBE', alignSelf: 'center', marginBottom: 22 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginBottom: 6 },
  headerCopy: { flex: 1 },
  title: { color: PAGE.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: PAGE.textMuted, fontSize: 13, lineHeight: 20, marginTop: 7 },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: PAGE.border,
    backgroundColor: PAGE.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: {
    color: PAGE.textMuted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
    marginTop: 16,
    marginBottom: 8,
    marginHorizontal: 4,
  },
  sectionSpacer: { height: 20 },
  list: { borderRadius: 20, borderWidth: 1, borderColor: PAGE.border, backgroundColor: PAGE.card, overflow: 'hidden' },
  row: { minHeight: 60, paddingHorizontal: 16, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 13 },
  rowBorder: { borderTopWidth: 1, borderTopColor: PAGE.border },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: PAGE.border,
    backgroundColor: PAGE.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  destructiveIconWrap: { backgroundColor: '#F7E5E0', borderColor: '#E3B9AE' },
  rowCopy: { flex: 1, minWidth: 0 },
  rowLabel: { color: PAGE.text, fontSize: 16, fontWeight: '600' },
  rowHint: { color: PAGE.textMuted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  destructiveText: { color: PAGE.destructive },
});
