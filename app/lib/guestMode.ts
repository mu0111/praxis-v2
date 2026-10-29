import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const GUEST_MODE_STORAGE_KEY = 'praxis.guestMode.v1';

const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;

  try {
    if (window.localStorage) return window.localStorage;
  } catch (error) {
    console.warn('[guestMode] localStorage unavailable', error);
  }

  try {
    if (window.sessionStorage) return window.sessionStorage;
  } catch (error) {
    console.warn('[guestMode] sessionStorage unavailable', error);
  }

  return null;
};

export const readGuestMode = (): boolean => {
  const storage = getStorage();
  if (!storage) return false;

  try {
    return storage.getItem(GUEST_MODE_STORAGE_KEY) === 'true';
  } catch (error) {
    console.warn('[guestMode] Failed to read guest mode', error);
    return false;
  }
};

// On native, window.localStorage is the in-memory shim from
// webRuntimePolyfills, so guest mode died with the process and every reopen
// landed a guest on Login (QA 2026-10-28). AsyncStorage survives restarts.
export const loadGuestMode = async (): Promise<boolean> => {
  if (Platform.OS === 'web') return readGuestMode();

  try {
    return (await AsyncStorage.getItem(GUEST_MODE_STORAGE_KEY)) === 'true';
  } catch (error) {
    console.warn('[guestMode] Failed to load guest mode', error);
    return false;
  }
};

export const writeGuestMode = (enabled: boolean) => {
  if (Platform.OS !== 'web') {
    const persist = enabled
      ? AsyncStorage.setItem(GUEST_MODE_STORAGE_KEY, 'true')
      : AsyncStorage.removeItem(GUEST_MODE_STORAGE_KEY);
    persist.catch((error) => console.warn('[guestMode] Failed to persist guest mode', error));
  }

  const storage = getStorage();
  if (!storage) return;

  try {
    if (enabled) {
      storage.setItem(GUEST_MODE_STORAGE_KEY, 'true');
      return;
    }

    storage.removeItem(GUEST_MODE_STORAGE_KEY);
  } catch (error) {
    console.warn('[guestMode] Failed to persist guest mode', error);
  }
};
