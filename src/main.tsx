import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import { App } from './App';
import { CaptureWindow, TearOffWindow } from './components/CaptureWindow';
import { SettingsWindow } from './components/Settings';
import { applyPrefs, loadPrefs } from './hooks';

// La app tiene tres ventanas que comparten este mismo código: el cuaderno, los ajustes
// y la captura rápida. Cada una se identifica con un parámetro en su dirección.
const which = new URLSearchParams(location.search).get('window');
document.documentElement.dataset.window = which ?? 'notebook';

// Antes del primer dibujo, para que la ventana no parpadee con el tema equivocado.
applyPrefs(loadPrefs());

// Bloqueo global de atajos de navegador y WebView2 para proteger todas las ventanas
window.addEventListener(
  'keydown',
  (event) => {
    const key = event.key.toLowerCase();
    const isCtrlOrMeta = event.ctrlKey || event.metaKey;

    // F12 (DevTools), F5 (Reload), F1 (Ayuda de Edge), F3 (Buscar), F7 (Cursor)
    if (
      event.key === 'F12' ||
      event.key === 'F5' ||
      event.key === 'F1' ||
      event.key === 'F3' ||
      event.key === 'F7'
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Ctrl+R o Ctrl+Shift+R (recarga de página)
    if (isCtrlOrMeta && key === 'r') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Ctrl+Shift+I (DevTools), Ctrl+Shift+J (Consola), Ctrl+Shift+C (Inspeccionar)
    if (isCtrlOrMeta && event.shiftKey && (key === 'i' || key === 'j' || key === 'c')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Ctrl+H (Historial), Ctrl+J (Descargas), Ctrl+P (Imprimir), Ctrl+G (Buscar), Ctrl+U (Código fuente)
    if (isCtrlOrMeta && (key === 'h' || key === 'j' || key === 'p' || key === 'g' || key === 'u')) {
      event.preventDefault();
      return;
    }
  },
  { capture: true },
);

// Evitar menú contextual nativo del navegador (Inspeccionar elemento, Recargar, etc.)
// permitiéndolo en campos de texto (input, textarea) para Cortar/Copiar/Pegar.
window.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement | null;
  const isTextInput = target?.matches('input, textarea, [contenteditable="true"]') || target?.closest('input, textarea, [contenteditable="true"]');
  if (!isTextInput) {
    event.preventDefault();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {which === 'settings' ? (
      <SettingsWindow />
    ) : which === 'capture' ? (
      <CaptureWindow />
    ) : which === 'tearoff' ? (
      <TearOffWindow />
    ) : (
      <App />
    )}
  </StrictMode>,
);
