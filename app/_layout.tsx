import './lib/webRuntimePolyfills';
import { useEffect, useRef } from 'react';
import { Stack, router, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NewsPreferencesProvider } from './context/NewsPreferencesContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineBanner } from './components/OfflineBanner';
import { BadgeCelebrationProvider } from './components/BadgeCelebration';
import { supabase } from './services/supabase';
import { endSession, startSession, trackPageView, trackPushOpen } from './lib/analytics';
import { writeDailyDigestOpenRequest } from './lib/dailyDigest';
import { startUiStallMonitor } from './lib/uiStallMonitor';

function AnalyticsTracker() {
  const pathname = usePathname();

  useEffect(() => {
    void startSession();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void startSession();
      } else if (state === 'background') {
        void endSession();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    return startUiStallMonitor();
  }, []);

  useEffect(() => {
    if (!pathname) return;
    void trackPageView(pathname);
  }, [pathname]);

  return null;
}

function AppLifecycleManager() {
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const syncServices = (state: string) => {
      if (state === 'active') {
        supabase.auth.startAutoRefresh();
        if (!supabase.realtime.isConnected()) {
          supabase.realtime.connect();
        }
        return;
      }

      supabase.auth.stopAutoRefresh();
    };

    syncServices(AppState.currentState);
    const subscription = AppState.addEventListener('change', syncServices);
    return () => subscription.remove();
  }, []);

  return null;
}

// Keep the native launch screen up until the session is restored and the
// first route is decided, so the user never sees a half-drawn screen or a
// slide into Sign In while the app is still figuring out who they are.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: 250, fade: true });

function RootRedirect() {
  const { session, profile, loading, isGuestMode } = useAuth();
  const segments = useSegments();
  const params = useGlobalSearchParams<{ returnTo?: string }>();

  useEffect(() => {
    if (loading) return;

    const inAuth = segments[0] === '(auth)';
    const inTabs = segments[0] === '(tabs)';
    const inModal = segments[0] === 'modal';
    const inArticle = segments[0] === 'article';
    const inChat = segments[0] === 'chat';
    const inStory = segments[0] === 'story';
    const tabAliasSegments = new Set(['saved', 'graph', 'profile', 'search', 'social', 'topics']);
    const inTabAlias = tabAliasSegments.has(segments[0] ?? '');
    const inAppShell = inTabs || inTabAlias || inModal || inArticle || inChat || inStory;

    if (!session && !isGuestMode) {
      if (!inAuth) router.replace('/login');
    } else if (!session && isGuestMode) {
      if (!inAppShell && !inAuth) router.replace('/');
    } else if (session && !inAppShell) {
      const returnTo = typeof params.returnTo === 'string' ? params.returnTo : null;
      router.replace((returnTo || '/') as any);
    }

    // The route is settled for this auth state; reveal the app.
    void SplashScreen.hideAsync().catch(() => undefined);
  }, [session, profile, loading, segments, isGuestMode, params.returnTo]);

  return null;
}

const HANDLED_PUSH_RESPONSE_KEY = 'praxis.lastHandledPushResponse.v1';

function PushNotificationHandler() {
  const notifResponseRef = useRef<Notifications.Subscription | null>(null);

  useEffect(() => {
    const handle = (data: Record<string, any> | undefined) => {
      if (typeof data?.type === 'string') {
        // The only place a push tap is visible to analytics; without this
        // row "do pushes bring people back" is unanswerable (audit 9/19).
        void trackPushOpen(data.type, data.articleId ?? null);
      }
      if (data?.type === 'follow' && data?.followerId) {
        router.push({ pathname: '/modal/user-profile', params: { userId: data.followerId } });
      } else if (data?.type === 'message' && data?.senderId) {
        router.push({ pathname: '/chat/[id]', params: { id: data.senderId } });
      } else if (data?.type === 'badge') {
        router.push('/profile');
      } else if (data?.type === 'digest' || data?.type === 'streak') {
        // Both pushes promise today's digest; the feed consumes the open request.
        void writeDailyDigestOpenRequest(true);
        router.push('/');
      } else if (data?.type === 'breaking' || data?.type === 'split' || data?.type === 'news') {
        // Content pushes (send-news-push) carry the lead article; open it
        // directly so the tap never lands on a dead end. No id → the feed.
        // The feed's article_id is a number; the route wants a string.
        const articleId = data.articleId == null ? '' : String(data.articleId);
        if (articleId) {
          router.push({ pathname: '/article/[id]', params: { id: articleId } });
        } else {
          router.push('/');
        }
      }
    };

    // getLastNotificationResponseAsync replays the most recent tap on EVERY
    // launch, including taps from previous sessions that were already acted
    // on — which reopened old digests out of nowhere. Remember the last
    // handled response id (persisted) and never handle the same tap twice.
    const markHandled = (id: string) => {
      AsyncStorage.setItem(HANDLED_PUSH_RESPONSE_KEY, id).catch(() => {});
    };

    notifResponseRef.current = Notifications.addNotificationResponseReceivedListener(response => {
      markHandled(response.notification.request.identifier);
      handle(response.notification.request.content.data as Record<string, any>);
    });

    // A tap that cold-started the app from a killed state is not delivered to
    // the listener above — fetch it explicitly, but only if it is new.
    Notifications.getLastNotificationResponseAsync().then(async response => {
      if (!response) return;
      const id = response.notification.request.identifier;
      const lastHandled = await AsyncStorage.getItem(HANDLED_PUSH_RESPONSE_KEY).catch(() => null);
      if (lastHandled === id) return;
      markHandled(id);
      handle(response.notification.request.content.data as Record<string, any>);
    }).catch(() => {});

    return () => notifResponseRef.current?.remove();
  }, []);

  return null;
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <BadgeCelebrationProvider>
        <NewsPreferencesProvider>
          <RootRedirect />
          <AnalyticsTracker />
          <AppLifecycleManager />
          <PushNotificationHandler />
          <OfflineBanner />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" options={{ animation: 'none' }} />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="article/[id]" options={{ presentation: 'card', animation: 'slide_from_right' }} />
            <Stack.Screen name="story/[id]" options={{ animation: 'none' }} />
            <Stack.Screen name="article/ai-analysis" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/profile" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/user-profile" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/saved-articles" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/search" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/leaderboard" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/edit-profile" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/account-settings" options={{ presentation: 'transparentModal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="modal/notification-settings" options={{ presentation: 'transparentModal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="modal/follow-list" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/change-password" options={{ presentation: 'modal' }} />
            <Stack.Screen name="chat/[id]" options={{ presentation: 'card' }} />
            <Stack.Screen name="modal/reading-activity" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/analytics" options={{ presentation: 'modal' }} />
            <Stack.Screen name="modal/achievements" options={{ presentation: 'modal' }} />
          </Stack>
          <StatusBar style="dark" />
        </NewsPreferencesProvider>
        </BadgeCelebrationProvider>
      </AuthProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
