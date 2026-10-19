import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { getBrand } from '../api';
import { Logo } from '../components';

// The admin-set entry animation, shown once right after signing in. It plays to
// the end (or 6s max) and can be tapped to skip. The video is only shown once it
// is actually ready; while it loads (or if it fails) a clean logo-on-black screen
// is shown instead of the player's blank placeholder, then control hands off.
export default function Splash({ onDone }) {
  const brand = getBrand();
  const done = useRef(false);
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const finish = () => { if (!done.current) { done.current = true; onDone(); } };

  const player = useVideoPlayer(brand.intro ? { uri: brand.intro } : null, (p) => {
    if (!p) return;
    p.muted = true;
    p.play();
  });

  useEffect(() => {
    if (!brand.intro) { finish(); return undefined; }
    const subEnd = player.addListener?.('playToEnd', finish);
    // Reveal the video only when it can actually render; bail out on an error.
    const subStatus = player.addListener?.('statusChange', (e) => {
      const status = e?.status ?? e; // the event shape varies across versions
      if (status === 'readyToPlay') { readyRef.current = true; setReady(true); player.play?.(); }
      else if (status === 'error') finish();
    });
    // Hard caps: never let the splash hang. If it is not ready in ~2.5s, skip.
    const notReady = setTimeout(() => { if (!readyRef.current) finish(); }, 2500);
    const maxPlay = setTimeout(finish, 6000);
    return () => { subEnd?.remove?.(); subStatus?.remove?.(); clearTimeout(notReady); clearTimeout(maxPlay); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!brand.intro) return null;
  return (
    <Pressable onPress={finish} style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <VideoView player={player} style={{ position: 'absolute', width: '100%', height: '100%', opacity: ready ? 1 : 0 }}
        contentFit="contain" nativeControls={false} />
      {!ready && <Logo size={120} />}
    </Pressable>
  );
}
