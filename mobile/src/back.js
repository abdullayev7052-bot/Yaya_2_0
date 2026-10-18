import { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';

// A tiny stack of "go back" handlers so the phone's own back button (and gesture)
// navigates inside the app instead of closing it. Each screen that shows a back
// arrow registers its handler while it is on top; the hardware back runs the
// topmost one. When the stack is empty we let the system do the default (exit).
const stack = [];
let wired = false;

function wire() {
  if (wired || Platform.OS === 'web') return;
  wired = true;
  BackHandler.addEventListener('hardwareBackPress', () => {
    const fn = stack[stack.length - 1];
    if (fn) { fn(); return true; }
    return false;
  });
}

export function pushBack(fn) {
  wire();
  stack.push(fn);
  return () => {
    const i = stack.lastIndexOf(fn);
    if (i >= 0) stack.splice(i, 1);
  };
}

// Register a back handler while `active` (default true) and the component is mounted.
export function useBack(fn, active = true) {
  useEffect(() => {
    if (!active || typeof fn !== 'function') return undefined;
    return pushBack(fn);
  }, [fn, active]);
}
