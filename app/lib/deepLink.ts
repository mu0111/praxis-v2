import * as Linking from 'expo-linking';

// Remembers the most recent link that opened the app. A screen reached via a
// link (e.g. password reset) mounts after the 'url' event has already fired,
// so its own listener would miss a link that arrives while the app is running.
let lastUrl: string | null = null;
const listeners = new Set<(url: string) => void>();

Linking.getInitialURL()
  .then((url) => {
    if (url && !lastUrl) {
      lastUrl = url;
      listeners.forEach((listener) => listener(url));
    }
  })
  .catch(() => {});

Linking.addEventListener('url', ({ url }) => {
  lastUrl = url;
  listeners.forEach((listener) => listener(url));
});

export const getLastDeepLink = () => lastUrl;

export const subscribeToDeepLinks = (listener: (url: string) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
