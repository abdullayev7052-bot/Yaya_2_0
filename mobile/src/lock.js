import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import * as store from './db';
import { getSession } from './api';

// App lock: each person can protect the app on their phone with a 4-digit PIN
// and, on top of it, a fingerprint / Face ID. The person stays logged in until
// they log out; the lock only hides the app from whoever picks the phone up.
//   settings: { pin: { salt, hash } | null, bio: boolean, minutes: 0 | 1 | 5 | 15 | 30 | 60 }
// minutes = 0 means "no auto-lock": the app locks only when it is started again.
export const TIMEOUTS = [1, 5, 15, 30, 60, 0];
export const MAX_TRIES = 5;

const key = () => `lock:${getSession()?.user?.id ?? 'none'}`;
export const getLock = () => store.getKv(key(), { pin: null, bio: false, minutes: 5 });
const saveLock = (patch) => store.setKv(key(), { ...getLock(), ...patch });
export const lockEnabled = () => !!getLock().pin;
// Milliseconds since the last touch (the monoblock's idle sign-out uses it).
export const idleFor = () => Date.now() - lastActive;

const hash = (salt, pin) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `yaya:${salt}:${pin}`);

export async function setPin(pin) {
  const salt = Crypto.randomUUID();
  saveLock({ pin: { salt, hash: await hash(salt, pin) }, tries: 0 });
}
export function clearPin() {
  saveLock({ pin: null, bio: false, tries: 0 });
}
// Returns true on success. Too many wrong PINs log the person out: then only
// the full login and password open the app again.
export async function verifyPin(pin) {
  const l = getLock();
  if (!l.pin) return true;
  if ((await hash(l.pin.salt, pin)) === l.pin.hash) {
    saveLock({ tries: 0 });
    return true;
  }
  saveLock({ tries: (l.tries ?? 0) + 1 });
  return false;
}
export const triesLeft = () => MAX_TRIES - (getLock().tries ?? 0);
export const setBio = (bio) => saveLock({ bio });
export const setMinutes = (minutes) => saveLock({ minutes });

export async function bioAvailable() {
  if (Platform.OS === 'web') return false;
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}
export async function bioAuth() {
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Yaya ilovasini ochish', cancelLabel: 'PIN kiritish', disableDeviceFallback: true,
    });
    return r.success;
  } catch {
    return false;
  }
}

// Activity clock: the app locks once it has been idle (or in the background)
// longer than the chosen timeout.
let lastActive = Date.now();
export const touch = () => { lastActive = Date.now(); };
export function shouldLock() {
  const l = getLock();
  if (!l.pin || !l.minutes) return false;
  return Date.now() - lastActive >= l.minutes * 60000;
}
