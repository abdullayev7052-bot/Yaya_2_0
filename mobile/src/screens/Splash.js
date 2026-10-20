import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { getBrand, getCachedIntro, getIntroSrc, refreshBrand } from '../api';
import { Logo } from '../components';

// The admin-set entry animation, shown once right after signing in.
//
// The video is played from a CACHED data URI (downloaded like the logo), not by
// streaming the remote URL — remote streaming never played reliably on the phone.
// While the source is being resolved a plain logo screen is shown, and the video
// itself sits behind an opaque logo cover that only lifts once a real frame is
// ready, so the player's blank placeholder can never appear.
const NATIVE = Platform.OS !== 'web';
const LogoScreen = () => (
  <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}><Logo size={120} /></View>
);

export default function Splash({ onDone }) {
  const [src, setSrc] = useState(() => getCachedIntro());
  const done = useRef(false);
  const finish = () => { if (!done.current) { done.current = true; onDone(); } };

  useEffect(() => {
    if (src) return undefined; // cached data URI already in hand
    let alive = true;
    const cap = setTimeout(finish, 8000); // never hang on the logo
    (async () => {
      await refreshBrand().catch(() => {});
      if (!alive) return;
      if (!getBrand().intro) { finish(); return; } // no video configured
      for (let i = 0; i < 12 && alive; i++) { // wait up to ~3s for the download
        const c = getCachedIntro();
        if (c) { setSrc(c); return; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!alive) return;
      const remote = getIntroSrc();
      if (remote) setSrc(remote); else finish();
    })();
    return () => { alive = false; clearTimeout(cap); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!src) return <LogoScreen />;
  return <SplashVideo src={src} onDone={finish} />;
}

function SplashVideo({ src, onDone }) {
  const done = useRef(false);
  const readyRef = useRef(false);
  const cover = useRef(new Animated.Value(1)).current;
  const [coverGone, setCoverGone] = useState(false);
  const finish = () => { if (!done.current) { done.current = true; onDone(); } };

  const player = useVideoPlayer({ uri: src }, (p) => { if (p) { p.muted = true; p.play(); } });

  useEffect(() => {
    const reveal = () => {
      if (readyRef.current) return;
      readyRef.current = true;
      player.play?.();
      Animated.timing(cover, { toValue: 0, duration: 250, useNativeDriver: NATIVE }).start(() => setCoverGone(true));
    };
    const subStatus = player.addListener?.('statusChange', (e) => {
      const st = e?.status ?? e;
      if (st === 'readyToPlay') reveal();
      else if (st === 'error') finish();
    });
    const subEnd = player.addListener?.('playToEnd', finish);
    const notReady = setTimeout(() => { if (!readyRef.current) finish(); }, 3500);
    const maxPlay = setTimeout(finish, 8000);
    return () => { subStatus?.remove?.(); subEnd?.remove?.(); clearTimeout(notReady); clearTimeout(maxPlay); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Pressable onPress={finish} style={{ flex: 1, backgroundColor: '#000' }}>
      <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls={false} />
      {!coverGone && (
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', opacity: cover }}>
          <Logo size={120} />
        </Animated.View>
      )}
    </Pressable>
  );
}
