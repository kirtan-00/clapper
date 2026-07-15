import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Keyboard-aware layout for phones. The on-screen keyboard shrinks the *visual*
// viewport but not the layout viewport, so bottom sheets end up hidden behind it.
// Track the visual viewport and expose two CSS vars the sheet uses:
//   --vvh : the height actually visible (so a sheet never exceeds it)
//   --kb  : how far the keyboard overlaps the bottom (so we lift the sheet above it)
function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) {
    root.style.setProperty('--vvh', window.innerHeight + 'px');
    return;
  }
  const apply = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--vvh', vv.height + 'px');
    root.style.setProperty('--kb', kb + 'px');
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
trackViewport();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
