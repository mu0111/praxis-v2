import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { getLastDeepLink, subscribeToDeepLinks } from '../lib/deepLink';
import { supabase } from '../services/supabase';
import { useTheme } from '../hooks/useTheme';

export default function ResetPasswordScreen() {
  const { c } = useTheme();
  const { access_token, refresh_token } = useLocalSearchParams<{
    access_token?: string;
    refresh_token?: string;
  }>();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  // Supabase's recovery redirect carries the tokens in the URL fragment
  // (praxis://reset-password#access_token=…&refresh_token=…), which the router
  // params never see, so read them from the link that opened the app.
  const [url, setUrl] = useState<string | null>(() => getLastDeepLink());
  useEffect(() => {
    // Cold start: the initial URL may resolve just after mount.
    if (!url) setUrl(getLastDeepLink());
    return subscribeToDeepLinks(setUrl);
  }, []);
  useEffect(() => {
    const fragment = new URLSearchParams(url?.split('#')[1] ?? '');
    const accessToken = fragment.get('access_token') ?? access_token;
    const refreshToken = fragment.get('refresh_token') ?? refresh_token;
    if (fragment.get('error_description')) {
      setError(`${fragment.get('error_description')}. Request a new reset link.`);
      return;
    }
    if (accessToken && refreshToken) {
      setError('');
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(({ error: err }) => { if (err) setError(err.message); });
    }
  }, [url, access_token, refresh_token]);

  const requirements = [
    { label: '8+ characters', met: password.length >= 8 },
    { label: 'Uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', met: /[a-z]/.test(password) },
    { label: 'Number', met: /[0-9]/.test(password) },
    { label: 'Special character', met: /[^A-Za-z0-9]/.test(password) },
  ];

  const allMet = requirements.every(r => r.met) && password === confirm;

  const handleReset = async () => {
    if (!allMet || loading) return;
    setError('');
    setLoading(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (err) { setError(err.message); return; }
    setDone(true);
    // The recovery link signed them in, so continue straight to the app.
    setTimeout(() => router.replace('/'), 2000);
  };

  if (done) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
        <View style={s.inner}>
          <Text style={{ fontSize: 52 }}>✅</Text>
          <Text style={[s.title, { color: c.text }]}>Password updated!</Text>
          <Text style={[s.sub, { color: c.textSecondary }]}>Taking you to Praxis…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
      <View style={s.inner}>
        <Text style={{ fontSize: 42, marginBottom: 4 }}>🔐</Text>
        <Text style={[s.title, { color: c.text }]}>Set new password</Text>
        <Text style={[s.sub, { color: c.textSecondary }]}>Choose a strong password for your account.</Text>

        <TextInput
          style={[s.input, { backgroundColor: c.card, borderColor: c.border, color: c.text }]}
          placeholder="New password"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <TextInput
          style={[s.input, { backgroundColor: c.card, borderColor: c.border, color: c.text }]}
          placeholder="Confirm password"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          value={confirm}
          onChangeText={setConfirm}
        />

        {/* Requirements */}
        <View style={s.requirements}>
          {requirements.map(r => (
            <View key={r.label} style={s.reqRow}>
              <View style={[s.dot, { backgroundColor: r.met ? '#22C55E' : '#EF4444' }]} />
              <Text style={[s.reqText, { color: r.met ? '#22C55E' : c.textMuted }]}>{r.label}</Text>
            </View>
          ))}
          <View style={s.reqRow}>
            <View style={[s.dot, { backgroundColor: password === confirm && confirm ? '#22C55E' : '#EF4444' }]} />
            <Text style={[s.reqText, { color: password === confirm && confirm ? '#22C55E' : c.textMuted }]}>
              Passwords match
            </Text>
          </View>
        </View>

        {error ? <Text style={[s.error, { color: '#EF4444' }]}>{error}</Text> : null}

        <TouchableOpacity
          style={[s.button, { backgroundColor: allMet ? c.tint : c.secondary }]}
          onPress={handleReset}
          disabled={!allMet || loading}
        >
          {loading
            ? <ActivityIndicator color={c.tintForeground} />
            : <Text style={[s.buttonText, { color: allMet ? c.tintForeground : c.textMuted }]}>
                Update Password
              </Text>
          }
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 12 },
  title: { fontSize: 24, fontWeight: '800' },
  sub: { fontSize: 14, lineHeight: 20, marginBottom: 4 },
  input: {
    height: 52, borderWidth: 1, borderRadius: 14,
    paddingHorizontal: 16, fontSize: 15,
  },
  requirements: { gap: 6, marginTop: 4 },
  reqRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  reqText: { fontSize: 13 },
  error: { fontSize: 13, marginTop: 4 },
  button: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  buttonText: { fontSize: 16, fontWeight: '700' },
});
