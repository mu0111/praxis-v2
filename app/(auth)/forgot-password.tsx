import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../services/supabase';
import { buildHref } from '../lib/buildHref';
import { AuthColors } from '../../constants/AuthTheme';

export default function ForgotPasswordScreen() {
  const c = AuthColors;
  const params = useLocalSearchParams<{ returnTo?: string }>();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const returnTo = typeof params.returnTo === 'string' ? params.returnTo : undefined;

  const handleReset = async () => {
    if (!email) return;
    setLoading(true);
    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: 'praxis://reset-password',
    });
    // Always show success for security — don't reveal if email exists
    setLoading(false);
    setSent(true);
  };

  return (
    <SafeAreaView style={[s.container, { backgroundColor: c.background }]}>
      <LinearGradient colors={[c.background, c.secondary]} style={s.gradient}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.inner}>
          <View style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <TouchableOpacity onPress={() => router.back()} style={s.back}>
              <Ionicons name="arrow-back" size={18} color={c.primary} />
              <Text style={[s.backText, { color: c.primary }]}>Back</Text>
            </TouchableOpacity>

        {sent ? (
          <View style={s.sentWrap}>
            <View style={[s.iconWrap, { backgroundColor: c.primary }]}>
              <Ionicons name="mail-outline" size={25} color={c.primaryForeground} />
            </View>
            <Text style={[s.title, { color: c.text }]}>Check your email</Text>
            <Text style={[s.body, { color: c.textSecondary }]}>
              We sent a password reset link to {email}. Check your inbox and follow the link.
            </Text>
            <TouchableOpacity
              style={[s.button, { backgroundColor: c.primary }]}
              onPress={() => router.replace(buildHref('/login', returnTo ? { returnTo } : undefined))}
            >
              <Text style={[s.buttonText, { color: c.primaryForeground }]}>Back to Sign In</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.form}>
            <Text style={[s.title, { color: c.text }]}>Reset password</Text>
            <Text style={[s.body, { color: c.textSecondary }]}>
              Enter your email and we'll send you a reset link.
            </Text>
            <TextInput
              style={[s.input, { borderColor: c.border, color: c.text, backgroundColor: c.input }]}
              placeholder="you@example.com"
              placeholderTextColor={c.textMuted}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoFocus
            />
            <TouchableOpacity
              style={[s.button, { backgroundColor: c.primary }]}
              onPress={handleReset}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color={c.primaryForeground} />
                : <Text style={[s.buttonText, { color: c.primaryForeground }]}>Send Reset Link</Text>
              }
            </TouchableOpacity>
          </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </LinearGradient>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  gradient: { flex: 1 },
  inner: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: {
    width: '100%', maxWidth: 440, borderWidth: 1, borderRadius: 24,
    paddingHorizontal: 24, paddingTop: 24, paddingBottom: 28,
    shadowColor: '#786C54', shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.16, shadowRadius: 30, elevation: 8,
  },
  back: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 24, alignSelf: 'flex-start' },
  backText: { fontSize: 15, fontWeight: '600' },
  sentWrap: { alignItems: 'center', gap: 16 },
  iconWrap: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  form: { gap: 16 },
  title: { fontSize: 26, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  input: { height: 52, borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, fontSize: 15 },
  button: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
