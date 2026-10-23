import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Logo } from '../components';

// A short branded logo screen shown once right after signing in.
//
// We deliberately do NOT play the admin's uploaded intro video here. On Android a
// native video surface (SurfaceView) renders on its own window layer that sits
// ABOVE ordinary React Native views, so the player's blank placeholder (the grey
// "grid") can flash through any cover we put over it — which is why the video
// splash never behaved on the phone. A plain logo screen avoids that completely.
export default function Splash({ onDone }) {
  const done = useRef(false);
  useEffect(() => {
    const finish = () => { if (!done.current) { done.current = true; onDone(); } };
    const t = setTimeout(finish, 1200);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <Logo size={120} />
    </View>
  );
}
