import { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { getBrand } from '../api';
import { C } from '../ui';

// The admin-set entry animation, shown once right after signing in. It plays to
// the end (or 6s max), can be tapped to skip, and then hands off to the app.
export default function Splash({ onDone }) {
  const brand = getBrand();
  const done = useRef(false);
  const finish = () => { if (!done.current) { done.current = true; onDone(); } };

  const player = useVideoPlayer(brand.intro || null, (p) => {
    if (!p) return;
    p.muted = true;
    p.play();
  });

  useEffect(() => {
    if (!brand.intro) { finish(); return undefined; }
    const sub = player.addListener?.('playToEnd', finish);
    const t = setTimeout(finish, 6000);
    return () => { sub?.remove?.(); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!brand.intro) return null;
  return (
    <Pressable onPress={finish} style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <VideoView player={player} style={{ width: '100%', height: '100%' }} contentFit="contain" nativeControls={false} />
    </Pressable>
  );
}
