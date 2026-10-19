import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { getBrand, refreshBrand } from '../api';
import { Logo } from '../components';

// The admin-set entry animation, shown once right after signing in.
//
// Two phases, so the player's own blank placeholder can NEVER be seen:
//  1. Resolve whether there is an intro at all (from cache, else ask the server),
//     showing a plain logo screen meanwhile.
//  2. Play it behind an OPAQUE logo cover that only lifts once a real frame is
//     ready; on error/slowness we just hand off with the logo still covering.
const NATIVE = Platform.OS !== 'web';
const LogoScreen = () => (
  <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}><Logo size={120} /></View>
);

export default function Splash({ onDone }) {
  const [state, setState] = useState(() => {
    const i = getBrand().intro;
    return i ? { phase: 'play', intro: i } : { phase: 'resolving' };
  });
  useEffect(() => {
    if (state.phase !== 'resolving') return undefined;
    let alive = true;
    const t = setTimeout(() => { if (alive) onDone(); }, 2500); // never hang resolving
    refreshBrand()
      .then((b) => { if (!alive) return; clearTimeout(t); if (b?.intro) setState({ phase: 'play', intro: b.intro }); else onDone(); })
      .catch(() => { if (alive) { clearTimeout(t); onDone(); } });
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  if (state.phase === 'resolving') return <LogoScreen />;
  return <SplashVideo intro={state.intro} onDone={onDone} />;
}

function SplashVideo({ intro, onDone }) {
  const done = useRef(false);
  const readyRef = useRef(false);
  const cover = useRef(new Animated.Value(1)).current; // opaque cover over the video
  const [coverGone, setCoverGone] = useState(false);
  const finish = () => { if (!done.current) { done.current = true; onDone(); } };

  const player = useVideoPlayer({ uri: intro }, (p) => { if (p) { p.muted = true; p.play(); } });

  useEffect(() => {
    const reveal = () => {
      if (readyRef.current) return;
      readyRef.current = true;
      player.play?.();
      Animated.timing(cover, { toValue: 0, duration: 250, useNativeDriver: NATIVE }).start(() => setCoverGone(true));
    };
    const subStatus = player.addListener?.('statusChange', (e) => {
      const st = e?.status ?? e; // event shape varies across versions
      if (st === 'readyToPlay') reveal();
      else if (st === 'error') finish();
    });
    const subEnd = player.addListener?.('playToEnd', finish);
    const notReady = setTimeout(() => { if (!readyRef.current) finish(); }, 3000);
    const maxPlay = setTimeout(finish, 7000);
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
