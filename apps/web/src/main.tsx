import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { useLangStore } from './i18n';
import './styles.css';

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
