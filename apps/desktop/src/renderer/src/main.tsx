import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Surface otherwise-silent async failures. There is no ErrorBoundary or global
// handler, so an unhandled promise rejection used to vanish with no trace — which
// is exactly what hid the "folder won't attach" failure on a fresh install.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
});
window.addEventListener('error', (e) => {
  console.error('[window error]', e.error ?? e.message);
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
