import { startExchangeServer, type ExchangeServerHandle, type OkxInstrument, type OkxPosMode } from '@pegasus/mock-okx/engine';
import { OkxRestClient, OkxWsClient, defaultEndpoints, type OkxWsData } from '@pegasus/okx';
import { PaperExchange, instrumentsOf, type PaperConfig } from './exchange.js';
import { okxBarSource, okxFundingSource } from './okx-sources.js';
import { loadState } from './state.js';

export interface PaperOptions {
  port?: number;
  host?: string;
  /** Instruments the terminal trades; the ones the saved account still holds are added. */
  instruments: string[];
  stateFile: string;
  initialBalance?: string;
  posMode?: OkxPosMode;
  takerFeeRate?: string;
  makerFeeRate?: string;
  defaultLever?: string;
  /** OKX hosts the market data is read from; the live (not the demo) ones by default. */
  okxRestUrl?: string;
  okxWsPublicUrl?: string;
  log?: (msg: string) => void;
}

export interface PaperHandle extends ExchangeServerHandle {
  paper: PaperExchange;
}

/** How often the account file records how far the prices were watched, and funding is looked at. */
const TICK_MS = 15_000;

/** The fields the engine's instrument rows carry beyond what the terminal's OKX types name. */
const INSTRUMENT_DEFAULTS = { category: '1', optType: '', stk: '', alias: '', maxIcebergSz: '', maxTriggerSz: '', maxStopSz: '', maxTwapSz: '' };

/**
 * Starts the paper exchange: the account and order side of OKX's API on a local port, matched against the real
 * exchange's market data. It listens only once the account is up to date for the time it was not running.
 */
export async function startPaperExchange(opts: PaperOptions): Promise<PaperHandle> {
  const log = opts.log ?? (() => {});
  const live = defaultEndpoints(false);
  const rest = new OkxRestClient({ baseUrl: opts.okxRestUrl ?? live.rest });
  const config: PaperConfig = {
    stateFile: opts.stateFile,
    initialBalance: opts.initialBalance ?? '100000',
    posMode: opts.posMode ?? 'net_mode',
    takerFeeRate: opts.takerFeeRate ?? '0.0005',
    makerFeeRate: opts.makerFeeRate ?? '0.0002',
    defaultLever: opts.defaultLever ?? '3',
  };

  const wanted = [...new Set([...opts.instruments, ...instrumentsOf(loadState(config.stateFile))])];
  const listed = await rest.getInstruments('SWAP');
  const instruments: OkxInstrument[] = [];
  for (const instId of wanted) {
    const raw = listed.find((i) => i.instId === instId);
    if (!raw) throw new Error(`OKX lists no perpetual swap ${instId}`);
    instruments.push({ ...INSTRUMENT_DEFAULTS, ...raw });
  }

  const paper = new PaperExchange(config, { instruments, bars: okxBarSource(rest), funding: okxFundingSource(rest), log });
  log(paper.restored ? `paper account read from ${config.stateFile}` : `new paper account with ${config.initialBalance} USDT, kept in ${config.stateFile}`);
  await paper.catchUp();

  const serverOpts: { port?: number; host?: string; log: (msg: string) => void; onWrite: () => void } = { log, onWrite: () => paper.save() };
  if (opts.port !== undefined) serverOpts.port = opts.port;
  if (opts.host !== undefined) serverOpts.host = opts.host;
  const server = await startExchangeServer(paper.engine, serverOpts);

  const ws = new OkxWsClient({ url: opts.okxWsPublicUrl ?? live.wsPublic, name: 'paper-feed' });
  ws.on('data', (msg: OkxWsData) => {
    const instId = msg.arg.instId;
    const row = msg.data[0] as { bids?: string[][]; asks?: string[][]; markPx?: string; last?: string } | undefined;
    if (!instId || !row) return;
    if (msg.arg.channel === 'books5' && row.bids && row.asks) paper.onBook(instId, row.bids, row.asks);
    else if (msg.arg.channel === 'mark-price' && row.markPx) paper.onMark(instId, row.markPx);
    else if (msg.arg.channel === 'tickers' && row.last) paper.onLast(instId, row.last);
  });
  ws.on('status', (status, detail) => {
    log(`market data feed ${status}${detail ? ` (${detail})` : ''}`);
    if (status !== 'connected') paper.onFeedDown();
  });
  ws.on('error', (err) => log(`market data feed error: ${err.message}`));
  await ws.subscribe(wanted.flatMap((instId) => [{ channel: 'books5', instId }, { channel: 'mark-price', instId }, { channel: 'tickers', instId }]));
  ws.connect();

  const timer = setInterval(() => void paper.tick(), TICK_MS);
  timer.unref();

  return {
    ...server,
    paper,
    async close(): Promise<void> {
      clearInterval(timer);
      await ws.close();
      paper.close();
      await server.close();
    },
  };
}
