import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { useLangStore } from './i18n';
import './styles.css';

// Defence in depth behind the frame-ancestors header: a framed terminal renders nothing and takes no clicks.
if (window.top !== window.self) {
  document.body.textContent = 'Pegasus must not be opened inside another page.';
  throw new Error('Pegasus must not be framed');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// The document says which language it is in: the browser picks the fonts and the spell checker from it.
const syncDocumentLang = (): void => {
  document.documentElement.lang = useLangStore.getState().lang === 'zh' ? 'zh-CN' : 'en';
};
syncDocumentLang();
useLangStore.subscribe(syncDocumentLang);

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('#root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
