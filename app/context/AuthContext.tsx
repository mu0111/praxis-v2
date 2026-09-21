import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { registerPushToken, syncStreakBadge, unregisterPushToken } from '../utils/notifications';
import { readGuestMode, writeGuestMode } from '../lib/guestMode';
import { trackAuth } from '../lib/analytics';
import { transferGuestStreakToProfile } from '../lib/digestStreak';

export interface Profile {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  topics: string[];
  articles_read: number;
  reading_streak: number;
  current_streak?: number | null;
  daily_goal: number;
  followers_count: number;
  following_count: number;
  onboarding_complete: boolean;
  created_at?: string | null;
  followers?: number | null;
  following?: number | null;
  longest_streak?: number | null;
  notify_digest?: boolean | null;
  notify_streak?: boolean | null;
  notify_social?: boolean | null;
  notify_news?: boolean | null;
  notify_quiet_hours?: boolean | null;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  isGuestMode: boolean;
  continueAsGuest: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (updates: Partial<Profile>) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isGuestMode, setIsGuestMode] = useState(() => readGuestMode());
  const [loading, setLoading] = useState(true);
  // Read inside the auth listener (which closes over the first render).
  const sessionUserIdRef = useRef<string | null>(null);
  const profileLoadedRef = useRef(false);
  useEffect(() => { sessionUserIdRef.current = session?.user?.id ?? null; }, [session]);
  useEffect(() => { profileLoadedRef.current = profile !== null; }, [profile]);

  // Guests who granted permission (via the card, or iOS Settings) keep their
  // device token registered; it carries no user until a sign-in claims it.
  useEffect(() => {
    if (isGuestMode) void registerPushToken(null);
  }, [isGuestMode]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) fetchProfile(session.user.id);
      else {
        setProfile(null);
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // INITIAL_SESSION duplicates the getSession() above: same session, a
      // second profile fetch, two full re-renders at launch. Skip it.
      if (event === 'INITIAL_SESSION') return;
      // TOKEN_REFRESHED fires on foreground once the JWT nears expiry. Nothing
      // a consumer reads (user id, signed-in-ness, profile) changes and the
      // client already holds the new token, but re-publishing the session
      // re-rendered every useAuth() consumer (23 screens/hooks, the graph SVG
      // among them) and refetched the profile: the few seconds the app feels
      // dead after coming back (Ayuka, 2026-09-18, msg 1408). Same user, same
      // profile: leave state alone.
      const sameUser = Boolean(nextSession?.user?.id) && nextSession?.user?.id === sessionUserIdRef.current;
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && sameUser && profileLoadedRef.current) return;
      // Leave the auth callback before touching supabase again (the client
      // holds its auth lock while notifying; querying inside can deadlock).
      setTimeout(() => {
        if (nextSession?.user) {
          writeGuestMode(false);
          setIsGuestMode(false);
        }
        setSession(nextSession);
        if (nextSession?.user) fetchProfile(nextSession.user.id);
        else { setProfile(null); setLoading(false); }
      }, 0);
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    setProfile(data);
    setLoading(false);
    // Register push token whenever we load a profile (no-op if already registered)
    registerPushToken(userId);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    writeGuestMode(false);
    setIsGuestMode(false);
    void trackAuth('sign_in', 'password');
  }, []);

  const signUp = useCallback(async (email: string, password: string, fullName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, email_confirmed: true } },
    });
    if (error) throw error;

    writeGuestMode(false);
    setIsGuestMode(false);

    if (!data.session) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) throw signInError;
    }
    void trackAuth('signup', 'password');

    // "Save my streak" promise: carry the guest device streak into the fresh
    // profile, then refetch so the pill never paints a reset number.
    const newUserId = data.session?.user?.id
      ?? (await supabase.auth.getUser()).data.user?.id;
    if (newUserId) {
      await transferGuestStreakToProfile(newUserId);
      await fetchProfile(newUserId);
    }
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    const userId = session?.user?.id;

    // Push cleanup must never prevent someone from leaving their account.
    if (userId) {
      await unregisterPushToken(userId).catch(() => {});
    }
    // The icon badge is this account's streak; it must not outlive the session.
    await syncStreakBadge(0).catch(() => {});

    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;

    // Auth events normally perform this update. Setting it here as well keeps
    // the UI reliable when the browser/native event arrives late.
    writeGuestMode(false);
    setIsGuestMode(false);
    setProfile(null);
    setSession(null);
    setLoading(false);
  }, [session]);

  const continueAsGuest = useCallback(() => {
    writeGuestMode(true);
    setIsGuestMode(true);
    setProfile(null);
    setLoading(false);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (session?.user) await fetchProfile(session.user.id);
  }, [fetchProfile, session]);

  const updateProfile = useCallback(async (updates: Partial<Profile>) => {
    if (!session?.user) return;
    const { error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', session.user.id);
    if (error) throw error;
    await refreshProfile();
  }, [refreshProfile, session]);

  const value = useMemo(() => ({
    session,
    user: session?.user ?? null,
    profile,
    loading,
    isGuestMode,
    continueAsGuest,
    signIn,
    signUp,
    signOut,
    refreshProfile,
    updateProfile,
  }), [session, profile, loading, isGuestMode, continueAsGuest, signIn, signUp, signOut, refreshProfile, updateProfile]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
