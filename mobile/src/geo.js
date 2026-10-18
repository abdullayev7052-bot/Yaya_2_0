import { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as api from './api';

// Location is only for people who collect milk: it orders their supplier list by
// distance and lets them mark where a supplier is. Office staff are never asked.

let current = null; // { lat, lng } or null
let watching = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(current));

export function useMyLocation() {
  const [loc, setLoc] = useState(current);
  useEffect(() => { listeners.add(setLoc); return () => listeners.delete(setLoc); }, []);
  return loc;
}

// Ask once, then keep a light watch while the app is open. Called only when a
// shift is open and the user collects. Safe to call repeatedly.
export async function startLocation() {
  if (watching || Platform.OS === 'web') { if (Platform.OS === 'web') await webOnce(); return; }
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    watching = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 60000, distanceInterval: 50 },
      (p) => { current = { lat: p.coords.latitude, lng: p.coords.longitude }; emit(); },
    );
  } catch { /* GPS off or denied: the app simply shows no distances */ }
}
export function stopLocation() {
  if (watching && watching.remove) watching.remove();
  watching = null;
}

// Browser tester: use the Geolocation API once.
function webOnce() {
  return new Promise((resolve) => {
    if (!navigator?.geolocation) return resolve();
    navigator.geolocation.getCurrentPosition(
      (p) => { current = { lat: p.coords.latitude, lng: p.coords.longitude }; emit(); resolve(); },
      () => resolve(), { enableHighAccuracy: true, timeout: 8000 },
    );
  });
}

// One fresh reading (for "save my current location").
export async function getOnce() {
  if (Platform.OS === 'web') { await webOnce(); return current; }
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    current = { lat: p.coords.latitude, lng: p.coords.longitude };
    emit();
    return current;
  } catch { return null; }
}

// Metres between two lat/lng points (haversine).
export function distanceM(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export function fmtDistance(m) {
  if (m == null) return '';
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`;
}

// Open turn-by-turn directions from here to the supplier in the maps app.
export function openRoute(supplier) {
  const dest = `${supplier.lat},${supplier.lng}`;
  const url = Platform.select({
    ios: `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`,
    android: `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`,
    default: `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
  });
  Linking.openURL(url).catch(() => {});
}

// Full URL of the shared map picker page served by our own server.
export function mapPickerUrl({ lat, lng, name, address }) {
  const q = new URLSearchParams();
  if (lat != null) q.set('lat', lat);
  if (lng != null) q.set('lng', lng);
  if (name) q.set('name', name);
  if (address) q.set('address', address);
  return `${api.getServerUrl()}/admin/map.html?${q.toString()}`;
}
