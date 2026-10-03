import type { CandleBar, ClientMessage } from '@pegasus/shared';
import { WsClient } from '../lib/ws';
import { useStore } from './store';

/**
 * Owns the single WebSocket client for the signed-in session and keeps the
 * server subscription in sync with the selected instrument / bar in the store.
 */
let client: WsClient | null = null;

export function wsSend(msg: ClientMessage): boolean {
  return client?.send(msg) ?? false;
}

export function startSession(token: string): () => void {
  stopSession();
  const ws = new WsClient({
    token,
    onMessage: (msg) => useStore.getState().applyMessage(msg),
    onStatus: (status) => useStore.getState().setWsStatus(status),
  });
  client = ws;

  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.selectedInstId !== prev.selectedInstId) {
      if (prev.selectedInstId !== null) ws.send({ type: 'unsubscribe', instId: prev.selectedInstId });
      if (state.selectedInstId !== null) ws.send({ type: 'subscribe', instId: state.selectedInstId, bar: state.bar });
      return;
    }
    if (state.bar !== prev.bar && state.selectedInstId !== null) {
      ws.send({ type: 'setBar', instId: state.selectedInstId, bar: state.bar });
    }
  });

  // an instrument may already be selected (e.g. reconnect after sign-in within the same page)
  const { selectedInstId, bar } = useStore.getState();
  if (selectedInstId !== null) ws.send({ type: 'subscribe', instId: selectedInstId, bar });

  ws.connect();

  return () => {
    unsubscribe();
    if (client === ws) stopSession();
    else ws.close();
  };
}

export function stopSession(): void {
  client?.close();
  client = null;
}

export function changeBar(bar: CandleBar): void {
  useStore.getState().setBar(bar);
}

export function signOut(): void {
  stopSession();
  const store = useStore.getState();
  store.setToken(null);
  store.reset();
}
