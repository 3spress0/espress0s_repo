import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Hand over from the static boot screen (index.html) once React has committed
// its first frame. Doing it after the render call, on the next animation
// frame, means there is a painted app to reveal rather than a blank page.
requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (boot) boot.remove();
  // The boot was healthy, so the one-shot auto-reload marker in index.html
  // (set when a pre-deploy tab holds a stale index.html) resets: the next
  // genuinely stuck load gets its single retry again.
  try { sessionStorage.removeItem('espress0_boot_retry'); } catch { /* private mode */ }
});
