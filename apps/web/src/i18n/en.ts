import type {
  CampaignPlanWarningCode,
  CampaignSignalReasonCode,
  CampaignSignalState,
  CancelSweepState,
  JournalEventKind,
  JournalStatus,
  Order,
  PlaceOrderRequest,
  PosSide,
  Side,
  TradeExitReason,
  TradeFillRole,
  TradeSource,
  TradeStatus,
} from '@pegasus/shared';
import type { Intent } from '../components/ticket/form';
import { pad2, splitDuration } from '../lib/campaign';
import type { ExitFormError, TpBasis, TpMode, TrailingMode } from '../lib/exits';
import { fmtAgeCoarse, fmtNum, safeDecimal } from '../lib/format';
import type { CapBound, CodeText, FollowBlock } from '../lib/signals';

/** The rule of the campaign in one line, its figures formatted. */
export interface CampaignRuleText {
  instruments: number;
  potStart: string;
  minStake: string;
  /** The structure's name in the page's language */
  structure: string;
  /** The structure adds to a campaign that works (pyramid) */
  adds: boolean;
  leverage: string;
  entryChannel: number;
  exitChannel: number;
  addStep: string;
  stakeFraction: string;
  bankFraction: string;
  rungFactor: string;
}

/** Diagnostic values of a risk rejection (RiskCheckResult.details). */
export type RiskDetails = Record<string, unknown>;

/** What the sentences of a coin's signal know besides the figures of its codes. */
export interface SignalContext {
  /** The base coin, "BTC" */
  coin: string;
  entryChannel: number;
  exitChannel: number;
  /** The add step as a percentage, "50.00%" */
  addStep: string;
}

/** A take-profit leg in words: its price, the share of the size it closes, and the R multiple and gain it stands for ('' when unknown). */
export interface TpLegText {
  px: string;
  pct: string;
  /** "2.00R" or '' */
  r: string;
  /** "+26.22%" or '' */
  gain: string;
  /** What is missing or wrong with the leg while it cannot be said ("not filled in, suggested 0.3437 (2R)"); '' when it can */
  problem: string;
}

/** The size the risk limits allowed, for the note under the contracts field; the figures are formatted. */
export interface CappedSizeText {
  riskPct: string;
  riskContracts: string;
  /** The limit in the page's language (follow.bound) */
  bound: string;
  limit: string;
  contracts: string;
  /** The loss at the stop with that size, '' without a stop */
  riskAmount: string;
  riskShare: string;
  /** What each contract is counted at against the limit, in USDT: the entry, plus `slippagePct` of slippage for a market order ('' for a limit order) */
  perContract: string;
  slippagePct: string;
}

/** The estimated liquidation of the confirmation sheet's order against its stop, for follow.liqAboveStop; the figures are formatted. */
export interface LiquidationText {
  liqPx: string;
  stopPx: string;
  /** The line the liquidation must stay at or below: the stop less the buffer */
  limitPx: string;
  leverage: string;
  /** The highest leverage at which it does, '' when none was found */
  safeLeverage: string;
  /** Where the liquidation stands: 'above' at or above the stop, 'near' below it but above the line */
  relation: 'above' | 'near' | '';
  /** An add: the liquidation is the position's after it */
  add: boolean;
}

/** The confirmation sheet's order in one sentence; the figures are formatted, '' where there is none. */
export interface FollowSummaryText {
  /** The size in words (follow.sizeText), or what is missing (follow.sizeMissing) */
  size: string;
  instId: string;
  ordType: 'market' | 'limit';
  /** The limit price; '' while none is filled in (or at market) */
  limitPx: string;
  /** The margin mode in the page's language */
  mgnMode: string;
  /** '' while not filled in */
  leverage: string;
  /** The stop and the loss at it in words (follow.stopLine, stopByChannel, stopNotBelow, noStopLine) */
  stop: string;
  /** The exit plan in words */
  exits: string;
}

/** The stop of the confirmation sheet's order and the loss at it, for follow.stopLine; '' where unknown. */
export interface StopLineText {
  stop: string;
  /** "13.11%" below the entry, or '' */
  stopPct: string;
  /** The loss at the stop in USDT, or '' */
  risk: string;
  /** The loss as a share of the equity, "0.65%", or '' */
  riskPct: string;
}

/** A journal event's fields, formatted and in the page's language; '' for one the event does not carry. */
export interface EventText {
  side: string;
  contracts: string;
  px: string;
  fromPx: string;
  fee: string;
  pnl: string;
  role: string;
  reason: string;
  leg: string;
  source: string;
  code: string;
  /** The exit plan of an order Pegasus placed, in words */
  plan: string;
}

/** A value of the details of an error as text; '' when the server did not send it. */
const val = (d: RiskDetails, key: string): string => {
  const v = d[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : Array.isArray(v) ? v.join(', ') : '';
};

/** A USDT amount of the details of a risk rejection, with separators and the unit; the raw value when it is not a number. */
const usdtOf = (d: RiskDetails, key: string): string => {
  const v = safeDecimal(val(d, key));
  return v === null ? val(d, key) : `${fmtNum(v, 2)} USDT`;
};

/** How a LIMITED_BY_* warning counts each contract against the limit: at the mark plus the slippage headroom ('' when the API did not say) */
const countedAt = (p: CodeText): string => (p.perContract === '' ? '' : ` (each contract counted at ${p.perContract} USDT${p.slippagePct === '' ? '' : `: the mark plus ${p.slippagePct} of slippage`})`);
/** The same for the sheet's size note: at the entry, plus the slippage headroom of a market order */
const countedAtCap = (s: CappedSizeText): string => (s.perContract === '' ? '' : ` (each contract counted at ${s.perContract} USDT${s.slippagePct === '' ? '' : `: the entry plus ${s.slippagePct} of slippage`})`);

/**
 * Every text of the terminal in English. The shape of this object is the contract of a dictionary:
 * zh.ts must provide each key, so a text that is missing in Chinese does not compile.
 */
export const en = {
  common: {
    waitingServer: 'Waiting for server…',
    accountNotLoaded: 'Account not loaded',
    untracked: 'untracked',
    untrackedTitle: 'Not one of the tracked instruments: prices and sizes are shown as OKX reports them, and the coin amount is unknown.',
    stale: 'STALE',
    asOf: (time: string) => `as of ${time}`,
    couldNotLoad: (what: string) => `Could not load ${what}:`,
    retry: 'Retry',
    retrying: 'Retrying…',
    refresh: 'Refresh',
    cancel: 'Cancel',
    market: 'market',
    coin: 'coin',
    contracts: 'contracts',
    quote: 'quote',
    time: 'Time',
    instrument: 'Instrument',
    side: 'Side',
    price: 'Price',
    size: 'Size',
    fee: 'Fee',
    stop: 'Stop',
    priceStopped: 'Price stopped updating',
    na: 'n/a',
    /** A time in UTC with the browser's local time beside it */
    utcLocal: (utc: string, local: string) => `${utc} · ${local} local`,
    ageCoarse: (ms: number) => fmtAgeCoarse(ms),
    /** A holding time: "3 d 4 h", "5 h 12 min", "12 min" */
    duration: (ms: number) => {
      const min = Math.max(0, Math.floor(ms / 60_000));
      const d = Math.floor(min / 1440);
      const h = Math.floor((min % 1440) / 60);
      const m = min % 60;
      return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
    },
    ct: (v: string) => `${v} ct`,
    close: 'Close',
  },

  /** Values the exchange and the server name in English, as the tables show them. */
  enums: {
    side: { buy: 'buy', sell: 'sell' },
    posSide: { long: 'long', short: 'short', flat: 'flat', net: 'net' },
    mgnMode: { cross: 'cross', isolated: 'isolated' },
    ordType: { market: 'market', limit: 'limit', post_only: 'post_only', fok: 'fok', ioc: 'ioc' },
    orderState: { live: 'live', partially_filled: 'partially_filled', filled: 'filled', canceled: 'canceled' },
    posMode: { net_mode: 'net_mode', long_short_mode: 'long_short_mode' },
    instState: { live: 'live', suspend: 'suspend', preopen: 'preopen', test: 'test' },
    conn: { connected: 'connected', connecting: 'connecting', disconnected: 'disconnected', open: 'open', closed: 'closed', unknown: 'unknown' },
    regime: { trend: 'trend', neutral: 'neutral', range: 'range', crisis: 'crisis' },
    intent: { 'Open long': 'Open long', 'Open short': 'Open short', 'Close long': 'Close long', 'Close short': 'Close short' },
    triggerPx: { last: 'last', index: 'index', mark: 'mark' },
    exec: { T: 'taker', M: 'maker' },
  },

  header: {
    equity: 'Equity',
    dailyPnl: 'Daily PnL',
    killSwitch: 'Kill switch',
    killSwitchOn: 'KILL SWITCH ON',
    haltAll: 'Halt all trading',
    signOut: 'Sign out',
    badge: { paper: 'PAPER', demo: 'DEMO', live: 'LIVE' },
    paperTitle: 'Paper trading: orders, positions and balance are simulated by Pegasus on the live OKX prices. Nothing is sent to an OKX account.',
    dots: { ws: 'ws', public: 'public', private: 'private', business: 'business' },
    dotTitle: (label: string, state: string) => `${label}: ${state}`,
    released: 'Kill switch released',
    releasedRebased: 'Kill switch released: daily PnL now counts from the current equity',
    engaged: 'Kill switch engaged: trading halted',
    confirmEngage: (sweepNotice: string) => `Engage the kill switch?\n\n${sweepNotice}\n\nNew opening orders through Pegasus will be rejected until it is released.`,
    confirmRelease: 'Release the kill switch and allow trading again?',
    /** The second question of a release that the server refused with DAILY_LOSS_ACTIVE; the values are formatted. */
    rebaseQuestion: (v: { dailyPnl: string; limit: string; equity: string }) =>
      [
        `The daily loss limit is still in force: today's PnL is ${v.dailyPnl} USD and the limit is -${v.limit} USD.`,
        `Release anyway? Today's loss so far is then no longer counted: daily PnL restarts at 0 from the current equity (${v.equity} USD) and the limit applies again from there.`,
        'Do this only when the drop is not a trading loss, for example after moving money out of the account.',
      ].join('\n\n'),
  },

  gate: {
    prompt: 'Enter the API token (API_TOKEN of the pegasus server).',
    tokenLabel: 'API token',
    checking: 'Checking…',
    signIn: 'Sign in',
    tokenRejected: 'Token rejected by the server',
  },

  toasts: { dismiss: 'Click to dismiss', openJournal: 'Open in the journal' },

  instruments: { title: 'Instruments' },

  book: {
    title: 'Order book',
    staleTitle: 'The order book stopped updating; these levels are not current',
    empty: 'No book data',
    sizeIn: (ccy: string) => `Size (${ccy})`,
    total: 'Total',
    spread: 'Spread',
    pickTitle: 'Use this price in the ticket',
  },

  trades: {
    title: 'Trades',
    staleTitle: 'Trades stopped updating; this list is not current',
    empty: 'No trades yet',
  },

  chart: {
    title: 'Chart',
    last: 'Last',
    mark: 'Mark',
    funding: 'Funding',
    vol24h: '24h vol',
    markStopped: 'Mark price stopped updating',
    historyFailed: 'history failed',
    loading: 'loading…',
  },

  layout: {
    resizeBottom: 'Drag to resize the panel; double-click to restore its height',
  },

  tabs: {
    campaign: 'Campaign',
    signals: 'Signals',
    signalsTitle: 'The campaign rule read coin by coin: follow a signal, or open by hand',
    journal: 'Journal',
    journalTitle: 'Every position opened: its plan, fills, exits and timeline',
    positions: 'Positions',
    orders: 'Open orders',
    stops: 'Stops',
    history: 'History',
    fills: 'Fills',
  },

  account: {
    title: 'Account',
    loading: 'Loading account…',
    failed: 'Account not loaded (see the warning above)',
    noKey: 'No API key configured: only market data is shown',
    totalEquity: 'Total equity',
    posMode: 'Position mode',
    level: 'Account level',
    ccy: 'Ccy',
    equity: 'Equity',
    avail: 'Avail',
    cash: 'Cash',
    upl: 'UPL',
    noBalance: 'No balance yet',
  },

  risk: {
    title: 'Risk',
    noConfig: 'No risk config yet',
    killSwitchOn: (reason: string) => `KILL SWITCH ON${reason !== '' ? ` — ${reason}` : ''}`,
    /** A line under the kill-switch notice for a reason the server states in English; null when the reason says it all. */
    reasonHint: (_reason: string): string | null => null,
    sweep: (state: CancelSweepState, message: string) =>
      `Cancel all open orders: ${message}${state === 'failed' || state === 'skipped' ? '. Open orders are NOT cancelled; cancel them on OKX.' : ''}`,
    dailyPnl: (since: string | null) => `Daily PnL${since !== null ? ` since ${since}` : ''}`,
    positionNotional: 'Position notional',
    openOrders: 'Open orders',
    maxOrderNotional: 'Max order notional',
    maxPerInstrument: 'Max per instrument',
    maxLeverage: 'Max leverage',
    priceBand: 'Price band',
    maxSlippage: 'Max slippage',
    baselineEquity: 'Baseline equity',
    dayStartEquity: 'Day start equity',
    currentEquity: 'Current equity',
  },

  orders: {
    loading: 'Loading orders…',
    failed: 'Orders not loaded (see the warning above)',
    noKey: 'No API key configured: orders are not shown',
    stopNotActiveTitle:
      'OKX creates the attached stop only when the order is completely filled. The part that has filled is a position WITHOUT a stop: let the order fill, or cancel the remainder and check in the Stops tab that the stop of the filled part exists.',
    cancelRequested: (ordId: string) => `Cancel requested for ${ordId}`,
    cancelFailed: (err: string) => `Cancel failed: ${err}`,
    canceledN: (n: number) => `Canceled ${n} order(s)`,
    cancelAllFailed: (err: string) => `Cancel all failed: ${err}`,
    confirmCancelAll: (n: number) => `Cancel all ${n} open orders?`,
    empty: 'No open orders',
    emptyHistory: 'No order history',
    whatHistory: 'order history',
    whatEarlier: 'earlier orders',
    type: 'Type',
    stopTitle: 'Stop-loss attached to the order: OKX creates it only when the order is completely filled (mark trigger, market execution)',
    filled: 'Filled',
    avgPx: 'Avg px',
    state: 'State',
    pnl: 'PnL',
    cancelAll: 'Cancel all',
    reduceOnlyTag: 'RO',
    notActive: 'not active',
  },

  fills: {
    empty: 'No fills',
    what: 'fills',
    whatEarlier: 'earlier fills',
    exec: 'Exec',
    order: 'Order',
  },

  positions: {
    loading: 'Loading positions…',
    failed: 'Positions not loaded (see the warning above)',
    noKey: 'No API key configured: positions are not shown',
    stopTitle: {
      none: 'No stop-loss (TP/SL order) rests at the exchange for this position. A stop attached to an order appears only once that order is completely filled; otherwise add one here. Trigger and trailing orders are not read.',
      partial: 'The stops at OKX close fewer contracts than this position holds: part of it has no stop.',
      full: 'Stop-loss resting at OKX for the whole position (see the Stops tab).',
      over: 'The stops at OKX add up to more contracts than this position holds. If a lot was closed, cancel its stop in the Stops tab.',
    },
    stopsUnread: 'The stops have not been read from OKX yet',
    nStops: (n: number) => `${n} stops`,
    noStop: 'no stop',
    covers: (covered: string, size: string) => `covers ${covered} of ${size} ct`,
    stopsOver: (covered: string, size: string) => `stops ${covered} ct > position ${size} ct`,
    addStop: 'add stop',
    addStopTitle: 'Place a mark-triggered market stop for the contracts no stop covers yet',
    closeRequested: (instId: string, posSide: PosSide) => `Close requested for ${instId} ${posSide}`,
    closeFailed: (err: string) => `Close failed: ${err}`,
    stopPlaced: (instId: string, sz: string, px: string) => `Stop placed: ${instId} ${sz} contracts at ${px}`,
    stopNotPlaced: (err: string) => `Stop NOT placed: ${err}`,
    stopPrompt: (uncovered: string, side: 'long' | 'short' | 'flat', instId: string) =>
      `Stop price for the ${uncovered} contracts of the ${side} position in ${instId} that have no stop (mark trigger, market execution):`,
    stopPriceInvalid: 'Enter the stop price as a positive number',
    confirmClose: (side: 'long' | 'short' | 'flat', instId: string) => `Close the ${side} position in ${instId} at market?`,
    empty: 'No open positions',
    caption: 'Positions',
    contracts: 'Contracts',
    coin: 'Coin',
    avgPx: 'Avg px',
    mark: 'Mark',
    stopHeaderTitle: 'Stop-loss orders resting at OKX for the position, as last read (Stops tab)',
    upl: 'UPL',
    uplPct: 'UPL %',
    lever: 'Lever',
    liqPx: 'Liq px',
    margin: 'Margin',
    notional: 'Notional',
    overLimitTitle: (instId: string, notional: string, limit: string) =>
      `${instId} position notional ${notional} USD is over the per-instrument limit ${limit} USD: trim it back to the limit`,
    overLimitTag: (quote: string, contracts: string | null) => `over limit: trim ${quote} USD${contracts !== null ? ` (${contracts} ct)` : ''}`,
    close: 'Close',
  },

  stops: {
    loading: 'Loading stops…',
    failed: 'Stops not loaded (see the warning above)',
    noKey: 'No API key configured: stops are not shown',
    noPositionTitle:
      'No open position matches this stop (instrument, margin mode, side). If the position was closed, the stop is a leftover: cancel it, or it will open a position against you when its price is reached.',
    readFailed: (err: string) => `Stops could not be read from OKX: ${err}`,
    moved: (instId: string, from: string, to: string) => `Stop moved: ${instId} ${from} → ${to}`,
    notMoved: (err: string) => `Stop NOT moved: ${err}`,
    cancelled: (instId: string, algoId: string) => `Stop cancelled: ${instId} ${algoId}`,
    notCancelled: (err: string) => `Stop NOT cancelled: ${err}`,
    newPriceInvalid: 'Enter the new stop price as a positive number',
    confirmLoosen: (instId: string, from: string, to: string) =>
      `This moves the stop of ${instId} AWAY from the price (${from} → ${to}): the position can lose more. Move it anyway?`,
    confirmCancel: (instId: string, px: string, hasPosition: boolean) => `Cancel the ${instId} stop at ${px}?${hasPosition ? ' Its position will be left without this stop.' : ''}`,
    reading: 'Reading…',
    unread: 'Stops have not been read from OKX yet',
    readAt: 'read from OKX at',
    notRefreshed: ' (not refreshed since)',
    none: 'No stops resting at OKX:',
    caption: 'Stops',
    closes: 'Closes',
    stopTitle: 'Stop-loss trigger price and the price that triggers it',
    exec: 'Exec',
    execTitle: 'How the closing order is executed once triggered',
    tp: 'TP',
    tpTitle: 'Take-profit trigger of the same algo order',
    newStop: 'New stop',
    noPosition: 'no position',
    wholePosition: 'whole position',
    pctOfPosition: (pct: string) => `${pct}% of position`,
    newStopAria: (instId: string, algoId: string) => `New stop price for ${instId} ${algoId}`,
    pricePlaceholder: 'price',
    move: 'Move',
  },

  ticket: {
    title: 'Order ticket',
    selectInstrument: 'Select an instrument',
    killSwitchNotice: 'Kill switch is on: only orders that close or reduce a position are accepted',
    buyLong: 'Buy / Long',
    sellShort: 'Sell / Short',
    buyCloseShort: 'Buy / Close short',
    sellCloseLong: 'Sell / Close long',
    type: 'Type',
    margin: 'Margin',
    closeExisting: 'Close / reduce existing position',
    tick: (tickSz: string) => `(tick ${tickSz})`,
    sizeHint: (minSz: string, lotSz: string) => `(min ${minSz} / lot ${lotSz} contracts)`,
    stopTitle:
      'Stop-loss attached to the order: OKX creates it only once the order is completely filled; while the order is partially filled, the filled part has no stop. Triggered by the mark price and executed at market. Leave empty for none.',
    stopMark: 'Stop (mark)',
    stopHint: (tickSz: string) => `(optional, tick ${tickSz})`,
    /** The stop typed is not on the losing side of the entry */
    stopWrongSide: (short: boolean) => `Not ${short ? 'above' : 'below'} the entry (a ${short ? 'short' : 'long'} needs its stop ${short ? 'above' : 'below'} it): the server refuses the stop.`,
    none: 'none',
    reduceOnly: 'Reduce only',
    completeForm: 'Complete the form',
    submitting: 'Submitting…',
    /** `ordType` is the order type as the dictionary names it (enums.ordType) */
    submitLabel: (intent: Intent | null, side: Side, ccy: string, ordType: string) => `${intent === null ? '' : `${intent}: `}${side === 'buy' ? 'Buy' : 'Sell'} ${ccy} ${ordType}`,
    placed: (o: Order, intent: Intent | null) =>
      `Order ${o.state}: ${intent === null ? '' : `${intent}, `}${o.side} ${o.sz} contracts ${o.instId}${o.px !== '' ? ` @ ${o.px}` : ''}${o.slTriggerPx === undefined ? '' : `, stop ${o.slTriggerPx} (mark)`} (${o.ordId})`,
    describe: (req: PlaceOrderRequest, intent: Intent | null) =>
      `${intent === null ? '' : `${intent}: `}${req.side} ${req.size.value} ${req.size.unit} ${req.instId} ${req.px === undefined ? 'market' : `@ ${req.px}`}${req.slTriggerPx === undefined ? '' : `, stop ${req.slTriggerPx} (mark)`}`,
    errDuplicate: 'The earlier attempt did reach OKX; this retry was refused as a duplicate. Check Open orders.',
    errUnknown: (err: string) => `Order status unknown: check Positions, Fills and Open orders before retrying (${err})`,
    errRejected: (err: string, risk: string | null) => `Order rejected: ${err}${risk === null ? '' : ` — ${risk}`}`,
  },

  leverage: {
    set: (lever: string, instId: string) => `Leverage set to ${lever}x on ${instId}`,
    invalid: 'Leverage must be a positive number',
    hint: (maxLever: string, riskMax: string | null) => `max ${maxLever}x exchange${riskMax === null ? '' : `, ${riskMax}x risk`}`,
    label: 'Leverage',
    unavailable: 'unavailable',
    setButton: 'Set',
  },

  preview: {
    previewing: 'Previewing…',
    enterSize: 'Enter a size to preview the order',
    enterPrice: 'Enter the price to preview the order',
    /** The form has a field that is not a number or a stop the server refuses: what the ticket says instead of a preview */
    incomplete: 'Complete the form to preview the order',
    action: 'Action',
    contracts: 'Contracts',
    coin: 'Coin',
    refPrice: 'Ref price',
    notional: 'Notional',
    estSlippage: 'Est. slippage',
    lossAtStop: 'Loss at stop',
    closingOk: 'Closing order: limits not applied',
    riskOk: 'Risk check passed',
  },

  /** The SIGNALS tab: the campaign rule read coin by coin (GET /api/campaign/signals). */
  signals: {
    loading: 'Loading the signals…',
    what: 'the signals',
    refreshing: 'Refreshing…',
    risk: 'Risk per trade',
    riskTitle: 'What one followed signal loses at its stop, as a share of the equity. It sizes every plan on this tab.',
    equity: 'Equity',
    updated: 'Updated',
    rule: (r: { entryChannel: number; exitChannel: number; addStep: string; adds: boolean; leverage: string }) =>
      `Campaign rule: long on a daily close above the ${r.entryChannel}-day high, exit on a daily close below the ${r.exitChannel}-day low${
        r.adds ? `, add at every +${r.addStep} (12-hour close)` : ', no adds'
      }; isolated, up to ${r.leverage}×.`,
    coins: 'Coins',
    colCoin: 'Coin',
    colState: 'State',
    colMark: 'Mark',
    colToEntry: 'To entry',
    toEntryTitle: 'How far the price must rise for the next daily close to beat the entry level',
    above: 'above',
    broken: 'broken',
    empty: 'No coin to read',
    outdated: (time: string) => `Not updated since ${time}: the figures below may be out of date.`,
    state: { entry: 'Entry', add: 'Add', exit: 'Exit', holding: 'Holding', near: 'Near', none: 'No signal', unavailable: 'N/A' } satisfies Record<CampaignSignalState, string>,
    headline: {
      entry: 'Entry signal: open a long',
      add: 'Add signal: add to the long',
      exit: 'Exit signal: close the long',
      holding: 'Holding a long: nothing to do',
      near: 'Near an entry: no signal yet',
      none: 'No signal',
      unavailable: 'Cannot be read',
    } satisfies Record<CampaignSignalState, string>,
    /** One sentence per reason code, from its figures */
    reason: {
      CLOSE_ABOVE_ENTRY: (p: CodeText, c: SignalContext) => `${c.coin} closed the day above its ${c.entryChannel}-day high ${p.level} (close ${p.close}).`,
      NEAR_ENTRY: (p: CodeText, c: SignalContext) =>
        `${c.coin} at ${p.markPx} is ${p.distancePct} below its ${c.entryChannel}-day high ${p.level}: a daily close above it is an entry.`,
      MARK_ABOVE_ENTRY: (p: CodeText, c: SignalContext) =>
        `${c.coin} at ${p.markPx} is above its ${c.entryChannel}-day high ${p.level}; the entry needs a daily close above it (00:00 UTC).`,
      BELOW_ENTRY: (p: CodeText, c: SignalContext) => `${c.coin} at ${p.markPx} is ${p.distancePct} below its ${c.entryChannel}-day high ${p.level}.`,
      HOLDING: (p: CodeText, c: SignalContext) =>
        `A long of ${p.contracts} contracts is held. Exit line (${c.exitChannel}-day low): ${p.trailingLine}${p.addTrigger === '' ? '' : `; next add at a 12-hour close of ${p.addTrigger} or more`}.`,
      CLOSE_BELOW_EXIT: (p: CodeText, c: SignalContext) => `${c.coin} closed the day below its ${c.exitChannel}-day low ${p.level} (close ${p.close}): the rule closes the long.`,
      ADD_TRIGGER_REACHED: (p: CodeText, c: SignalContext) =>
        `The 12-hour close ${p.close} (${p.barClose}) reached the add trigger ${p.trigger}: +${c.addStep} over the last entry ${p.addRef}.`,
      ADDS_OFF: () => 'Adds are off (no-add structure).',
      ADD_REF_FROM_POSITION: (p: CodeText) => `The journal has no opening fill of this long: the add is measured from its average price ${p.avgPx}.`,
      SHORT_HELD: (p: CodeText) => `A short of ${p.contracts} contracts is held on this coin; the rule is long only and does not count it.`,
      NOT_ENOUGH_BARS: (p: CodeText) => `Only ${p.have} confirmed daily bars; the channels need ${p.need}.`,
      BARS_UNAVAILABLE: (p: CodeText) => `The daily bars could not be read (${p.message}).`,
      NO_MARK_PRICE: () => 'No mark price: no distance and no plan.',
    } satisfies Record<CampaignSignalReasonCode, (p: CodeText, c: SignalContext) => string>,
    /** The sentences of a coin's state as one text */
    joinSentences: (parts: string[]) => parts.join(' '),
    ruleLine: (c: SignalContext, exitLine: string) => `Rule: long; exit on a daily close below the ${c.exitChannel}-day low ${exitLine}.`,
    exitAdvice: 'Close the long in the Positions tab, or let its stop at the exit line close it.',
    signalAt: { entry: 'Daily close', add: '12-hour close' },
    signalTime: 'Signal',
    nowVsSignal: 'Now vs signal close',
    noSignalTime: 'no signal',
    lastClose: 'Last daily close',
    nextClose: 'Next daily close',
    levels: 'Key levels',
    entryLevel: (n: number) => `Entry: ${n}-day high`,
    entryLevelTitle: 'The highest high of the last daily bars: the next daily close must close above it for an entry',
    entryLevelBroken: (n: number) => `Entry: ${n}-day high (broken)`,
    entryLevelBrokenTitle: 'The line the last daily close broke: that close gave this entry signal',
    entryBrokenBy: (close: string) => `closed at ${close}, above it`,
    exitLevel: (n: number) => `Exit line: ${n}-day low`,
    exitLevelTitle: 'The trailing line: a daily close below it ends the long; the channel trailing stop is kept at it',
    addLevel: 'Next add',
    addLevelTitle: 'A 12-hour close at or above it is an add signal',
    addAfterEntry: 'after an entry at the mark',
    addsOff: 'adds off',
    chartLine: { entry: (n: number) => `${n}-day high`, exit: (n: number) => `${n}-day low` },
    chartUntracked: 'No chart: this server does not track the coin.',
    chartFailed: 'The daily bars could not be loaded.',
    plan: { entry: 'Plan to follow the entry', add: 'Plan to follow the add' },
    noPlan: 'No plan: only an entry or an add signal has one.',
    groupPrice: 'Price',
    groupSize: 'Position',
    groupRisk: 'Risk',
    groupExit: 'Exit',
    entryPx: 'Entry (mark now)',
    stopPx: 'Stop (exit line)',
    stopDistance: 'Stop distance',
    contracts: 'Contracts',
    coin: 'Coin',
    notional: 'Notional',
    leverage: 'Leverage',
    margin: 'Margin',
    liqPx: 'Liquidation (est.)',
    atRisk: 'At risk',
    ofEquity: 'Of equity',
    riskTarget: 'Target',
    noSize: 'no size',
    trailingChannel: (bars: number) => `Trailing stop at the ${bars}-day low, moved after every daily close`,
    noTakeProfit: 'No take-profit: the rule exits on the channel only',
    afterAdd: 'After the add',
    afterAddLine: (contracts: string, avgPx: string, liqPx: string) => `${contracts} contracts, average ${avgPx}, liquidation ${liqPx}`,
    warnings: 'Warnings',
    warning: {
      STOP_NOT_BELOW_ENTRY: (p: CodeText) => `The price ${p.entryPx} is at or below the exit line ${p.stopPx}: there is no stop to size with, so the plan has no size.`,
      STOP_TOO_WIDE: (p: CodeText) => `The stop is ${p.stopDistancePct} below the entry, wider than ${p.limit}: the position is small for its risk.`,
      STOP_TOO_NARROW: (p: CodeText) => `The stop is only ${p.stopDistancePct} below the entry, closer than ${p.limit}: noise can stop it out, and the position is large.`,
      BELOW_MIN_ORDER: (p: CodeText) => `The risk buys only ${p.sized} contracts, below the minimum order of ${p.minSz}: the plan holds the minimum, which risks ${p.riskAmount} USDT.`,
      LIMITED_BY_ORDER_NOTIONAL: (p: CodeText) =>
        `The risk sizes ${p.riskContracts} contracts; the per-order limit of ${p.limit} USDT allows ${p.contracts}${countedAt(p)} (${p.notional} USDT), risking ${p.riskAmount} USDT: the plan holds ${p.contracts}.`,
      LIMITED_BY_POSITION_NOTIONAL: (p: CodeText) =>
        `The risk sizes ${p.riskContracts} contracts; with what is held on the coin, its position limit of ${p.limit} USDT allows ${p.contracts} more${countedAt(p)} (${p.notional} USDT), risking ${p.riskAmount} USDT: the plan holds ${p.contracts}.`,
      LIMITED_BY_TOTAL_NOTIONAL: (p: CodeText) =>
        `The risk sizes ${p.riskContracts} contracts; with all positions held, the total limit of ${p.limit} USDT allows ${p.contracts} more${countedAt(p)} (${p.notional} USDT), risking ${p.riskAmount} USDT: the plan holds ${p.contracts}.`,
      OVER_ORDER_NOTIONAL: (p: CodeText) => `Even the minimum order (${p.notional} USDT) is over the per-order limit of ${p.limit} USDT: the risk engine refuses it, so the plan has no size.`,
      OVER_POSITION_NOTIONAL: (p: CodeText) => `With even the minimum order the coin's positions come to ${p.projected} USDT, over its limit of ${p.limit}: the risk engine refuses it, so the plan has no size.`,
      OVER_TOTAL_NOTIONAL: (p: CodeText) => `With even the minimum order all positions come to ${p.projected} USDT, over the total limit of ${p.limit}: the risk engine refuses it, so the plan has no size.`,
      SIGNAL_STALE: (p: CodeText) => `The bar of the signal closed at ${p.closedAt}, more than a bar ago: a newer bar is not confirmed yet. Check before following.`,
      PRICE_FAR_ABOVE_SIGNAL: (p: CodeText) => `The price ${p.markPx} is already ${p.risePct} above the signal's close ${p.close} (more than ${p.limit}): a late entry, with the stop further away.`,
      EQUITY_UNKNOWN: () => 'No equity to size with: the plan has no size.',
      LINEAR_ONLY: () => 'Plans are for USDT-margined (linear) swaps only: this one has no size.',
      LEVERAGE_REDUCED: (p: CodeText) =>
        p.liqPxAtMax === '' || p.liqPx === ''
          ? `Leverage ${p.leverage}× instead of ${p.maxLeverage}×, so that the liquidation stays below the stop.`
          : `At ${p.maxLeverage}× the estimated liquidation ${p.liqPxAtMax} would be ${
              p.liqRelation === 'above'
                ? `above the stop ${p.stopPx}: the position would be liquidated before the stop`
                : p.liqRelation === 'near'
                  ? `below the stop ${p.stopPx} but within the buffer${p.limitPx === '' ? '' : ` (it must stay at or below ${p.limitPx})`}: a wick could liquidate the position before the stop`
                  : `not safely below the stop ${p.stopPx}${p.limitPx === '' ? '' : ` (it must stay at or below ${p.limitPx})`}`
            }. The leverage is lowered to ${p.leverage}×, where the liquidation is ${p.liqPx}, below the stop${p.limitPx === '' ? '' : ` (it must stay at or below ${p.limitPx})`}.`,
      LIQUIDATION_NEAR_STOP: (p: CodeText) =>
        `After the add${p.leverage === '' ? '' : `, at the position's ${p.leverage}×,`} the estimated liquidation ${p.liqPx} is not safely below the stop ${p.stopPx}${p.limitPx === '' ? '' : ` (it must stay at or below ${p.limitPx})`}.`,
      NOT_TRACKED: () => 'This server does not track the coin: an order on it is refused. Add it to INSTRUMENTS.',
      CAMPAIGN_ACCOUNT: () => "The campaign pot runs on this account: its positions are the pot's, and an order here disturbs it.",
      KILL_SWITCH: () => 'The kill switch is on: trading is halted.',
    } satisfies Record<CampaignPlanWarningCode, (p: CodeText) => string>,
    follow: 'Follow signal',
    followTitle: 'Opens a confirmation sheet with every parameter filled in; nothing is sent until you confirm there',
    manual: 'Open manually',
    manualTitle: 'Puts the coin and Buy / Long into the order ticket and moves the focus there; nothing else is filled in',
    manualUntracked: 'The order ticket offers the tracked coins only.',
    /** Why the follow button is disabled */
    block: {
      NOT_ACTIONABLE: 'Only an entry or an add signal can be followed.',
      CAMPAIGN_ACCOUNT: 'The campaign pot trades this account by itself: following a signal here would disturb it.',
      KILL_SWITCH: 'The kill switch is on: opening orders are refused.',
      TRADING_BLOCKED: 'Trading from Pegasus is disabled (see the order ticket).',
      NOT_TRACKED: 'This server does not track the coin: an order on it is refused.',
      NO_PLAN: 'There is no plan to follow.',
      NO_SIZE: 'The plan has no size (see the warnings).',
      EXITS_UNAVAILABLE: "Exits are not offered here: the plan's channel trailing stop cannot be placed. Open manually, with a stop.",
      EXITS_UNKNOWN: 'Whether exits are offered here could not be checked yet.',
    } satisfies Record<FollowBlock, string>,
    banner: {
      campaignAccount: (paperUrl: string) =>
        `This stack runs the campaign pot on its own paper account: the positions are the pot's and it trades them by itself. Following signals is disabled here; follow them on the paper stack (${paperUrl}).`,
      killSwitch: 'The kill switch is on: opening orders are refused, so no signal can be followed.',
      exitsUnavailable: 'Take-profit and trailing exits are offered in paper trading and against the local mock only. A followed signal needs its trailing stop, so following is disabled here.',
    },
  },

  /** The confirmation sheet of a followed signal. */
  follow: {
    title: { entry: 'Follow the entry signal', add: 'Follow the add signal' },
    signalLine: (when: string, close: string, level: string, kind: 'entry' | 'add', n: number) =>
      kind === 'entry' ? `${when}: daily close ${close} above the ${n}-day high ${level}` : `${when}: 12-hour close ${close} at or above the add trigger ${level}`,
    order: 'Order',
    ordType: 'Type',
    limitPx: 'Limit price',
    mgnMode: 'Margin mode',
    leverage: 'Leverage',
    leverageHint: (plan: string, max: string | null) => `plan ${plan}×${max === null ? '' : ` · limit ${max}×`}`,
    leverageFrom: (from: string, to: string) => `Leverage is set from ${from}× to ${to}× before the order is sent.`,
    size: 'Size',
    contracts: 'Contracts',
    riskPct: 'Risk % of equity',
    recompute: 'Size from risk',
    recomputeTitle: 'Contracts that lose this share of the equity from the entry to the stop, whole lots rounded down, at least the minimum order, and no more than the risk limits and the balance allow',
    belowMin: (minSz: string) => `the risk buys less than the minimum order: ${minSz} contracts`,
    /** The limits a size is cut to */
    bound: { order: 'per-order notional limit', instrument: "coin's position limit", total: 'total position limit', balance: 'available balance' } satisfies Record<CapBound, string>,
    cappedBy: (s: CappedSizeText) =>
      `Risk ${s.riskPct} sizes ${s.riskContracts} contracts; the ${s.bound} of ${s.limit} USDT allows ${s.contracts}${countedAtCap(s)}: ${s.contracts} filled in${
        s.riskAmount === '' ? '' : `, actual risk ${s.riskShare} (${s.riskAmount} USDT)`
      }.`,
    capBelowMin: (bound: string, limit: string, minSz: string) => `The ${bound} of ${limit} USDT allows less than the minimum order of ${minSz} contracts: the minimum is filled in, which the risk check refuses.`,
    overCap: (s: CappedSizeText) => `Over the ${s.bound} of ${s.limit} USDT: at most ${s.contracts} contracts${countedAtCap(s)}.`,
    /** The button beside the over-cap note that fills in the most the limit allows */
    useCap: (max: string) => `Use ${max}`,
    /** The contracts field is empty or not a size; the program's size is proposed */
    sizeNotFilled: (proposal: string) => `No size yet${proposal === '' ? '' : `; suggested ${proposal} contracts (Size from risk)`}.`,
    /** The size typed is not a whole number of lots: the server rounds it down to one */
    sizeOffLot: (typed: string, sent: string, lotSz: string) => `${typed} is not a whole number of lots of ${lotSz}: the order is sent for ${sent} contracts.`,
    /** The size typed is below the minimum order (after rounding to the lot): the server refuses it */
    sizeBelowMin: (typed: string, minSz: string) => `${typed} is below the minimum order of ${minSz} contracts: the server refuses it.`,
    /** The size is the program's, but the risk field holds no percentage to size from */
    riskPctInvalid: 'Risk %: enter a positive number to size from it; the size filled in is the last one computed.',
    stop: 'Stop (mark trigger)',
    stopBelow: (pct: string) => `${pct} below the entry`,
    /** A typed stop off the tick: the server rounds it up to the tick (towards the entry) */
    stopOnTick: (px: string, tick: string) => `rounded to the tick ${tick}: ${px}`,
    stopNotBelow: 'not below the entry: the server refuses it',
    stopInvalid: 'not a price: enter one (digits and a point), or leave it empty',
    /** The stop field is empty: the program's stop, and where the trailing stop stands after the fill ('' without one) */
    stopNotFilled: (proposal: string, afterFill: string) => `No stop attached${proposal === '' ? '' : `; suggested ${proposal} (the exit line)`}${afterFill === '' ? '' : `. ${afterFill}`}.`,
    afterFillChannel: (level: string) => `Channel trailing puts a stop at ${level} once the order has filled`,
    afterFillCallback: (level: string) => `The callback trailing stop stands at ${level} once the order has filled`,
    exitPlan: 'Exit plan',
    check: 'Live check',
    checking: 'Checking…',
    /** The order cannot be checked yet: what is missing */
    enterSize: (proposal: string) => `Enter the contracts to check the order${proposal === '' ? '' : `; suggested ${proposal}`}.`,
    enterLimitPx: 'Enter the limit price to check the order.',
    refPrice: 'Ref price',
    /** The limit price field is empty: the figures are at the mark meanwhile */
    limitPxMissing: (mark: string) => `not filled in; figures at the mark ${mark}`,
    notional: 'Notional',
    estSlippage: 'Est. slippage',
    marginAt: (lev: string) => `Margin at ${lev}×`,
    margin: 'Margin',
    /** The leverage field is empty or not a number: the figures that need it */
    leverageMissing: 'leverage not filled in',
    fee: (rate: string) => `Fee (taker ${rate}, est.)`,
    liqPx: 'Liquidation (est.)',
    /** Cross margin: the liquidation is not the order's own */
    liqCross: "cross: depends on the whole account's margin",
    /** The estimated liquidation is at or below zero: the position cannot be liquidated at this leverage */
    liqNone: 'none: at this leverage the price cannot reach it',
    /** The liquidation at the chosen leverage is not safely below the stop: above it, or below it but within the buffer */
    liqAboveStop: (l: LiquidationText) =>
      `${l.add ? `After the add, at the position's ${l.leverage}×, its` : `At ${l.leverage}× the`} liquidation ${l.liqPx} ${
        l.relation === 'above'
          ? `is above the stop ${l.stopPx}: the position would be liquidated before the stop`
          : `is below the stop ${l.stopPx} but within the buffer (it must stay at or below ${l.limitPx}): a wick could liquidate the position before the stop`
      }.${l.safeLeverage === '' ? '' : ` Lower the leverage to ${l.safeLeverage}×.`}`,
    lossAtStop: 'Loss at stop',
    /** The loss at the stop channel trailing puts after the fill, since none is attached */
    lossAtChannel: (level: string) => `at the channel stop ${level}`,
    /** The loss at the callback trailing stop's trigger, since no other stop is there */
    lossAtCallback: (level: string) => `at the callback stop ${level}`,
    /** The callback trailing stop's trigger is nearer than the stop: it fires first, at a smaller loss */
    callbackFirst: (level: string, loss: string, pct: string) => `the callback stop ${level} fires first: ${loss} USDT${pct === '' ? '' : ` (${pct} of equity)`}`,
    /** No stop at all: the loss is not bounded */
    lossNotBounded: 'not bounded (no stop)',
    ofEquity: (pct: string) => `${pct} of equity`,
    /** Under the contracts field: the loss at the stop as a share of the equity */
    atRiskShare: (pct: string) => `${pct} of equity at risk`,
    tpLegs: 'Take-profit legs',
    tpLeg: (n: number) => `TP${n}`,
    tpContracts: 'Contracts',
    tpProfit: 'Profit',
    riskOk: 'Risk check passed',
    /** The order passes without the parts of the exit plan that are not complete yet */
    riskOkPartial: 'Risk check passed for the order without the exit-plan parts still to fix.',
    leverageWillPass: (to: string) => `Passes once the leverage is set to ${to}×.`,
    summaryTitle: 'In one sentence',
    /** "182.7 contracts (18,270.0 ADA)" */
    sizeText: (contracts: string, coin: string) => `${contracts} contracts (${coin})`,
    sizeMissing: (proposal: string) => `contracts not filled in${proposal === '' ? '' : ` (suggested ${proposal})`}`,
    /** "stop 0.2366 (13.11% below), at risk 652.24 USDT (0.65% of equity)" */
    stopLine: (s: StopLineText) => `stop ${s.stop}${s.stopPct === '' ? '' : ` (${s.stopPct} below)`}${s.risk === '' ? '' : `, at risk ${s.risk} USDT${s.riskPct === '' ? '' : ` (${s.riskPct} of equity)`}`}`,
    /** No stop attached, but channel trailing puts one at its level once the order has filled */
    stopByChannel: (s: StopLineText) =>
      `no stop attached; channel trailing puts one at ${s.stop} after the fill${s.stopPct === '' ? '' : ` (${s.stopPct} below)`}${
        s.risk === '' ? '' : `, at risk ${s.risk} USDT${s.riskPct === '' ? '' : ` (${s.riskPct} of equity)`}`
      }`,
    /** No stop attached, but the callback trailing stop stands at its trigger once the order has filled */
    stopByCallback: (s: StopLineText) =>
      `no stop attached; the callback trailing stop stands at ${s.stop} after the fill${s.stopPct === '' ? '' : ` (${s.stopPct} below)`}${
        s.risk === '' ? '' : `, at risk ${s.risk} USDT${s.riskPct === '' ? '' : ` (${s.riskPct} of equity)`}`
      }`,
    stopWrongLine: (stop: string) => `stop ${stop} not below the entry (the server refuses it)`,
    /** The stop field holds something that is not a price */
    stopInvalidLine: (text: string) => `stop "${text}" is not a price (enter one, or leave it empty)`,
    noStopLine: 'no stop: the loss is not bounded',
    summary: (s: FollowSummaryText) =>
      `Buy ${s.size} of ${s.instId} ${s.ordType === 'market' ? 'at market' : s.limitPx === '' ? 'at a limit price not filled in yet' : `at limit ${s.limitPx}`}, ${s.mgnMode} ${
        s.leverage === '' ? 'leverage not filled in' : `${s.leverage}×`
      }; ${s.stop}; ${s.exits}.`,
    confirm: 'Confirm order',
    sending: 'Sending…',
    settingLeverage: 'Setting the leverage…',
    cancel: 'Cancel',
    closeTitle: 'Close without sending anything',
    placed: (contracts: string, instId: string, state: string) => `Signal followed: buy ${contracts} contracts of ${instId} (${state}).`,
    leverageFailed: (err: string) => `The leverage could not be set, so no order was sent: ${err}`,
    incomplete: 'Complete the form',
    suggest: 'Suggest',
    suggestStopTitle: "Fill in the plan's stop: the exit line of the rule",
    /** Why the confirm button is disabled, printed beside it */
    whyLeverage: 'Leverage: enter a positive number.',
    whyNoSize: (proposal: string) => `Contracts: not filled in${proposal === '' ? '' : `; suggested ${proposal}`}.`,
    whySizeBelowMin: (minSz: string, proposal: string) => `Contracts: below the minimum order of ${minSz}${proposal === '' ? '' : `; suggested ${proposal}`}.`,
    whyNoPx: 'Limit price: enter one.',
    /** Under the plan's warnings on the sheet: they are the plan's figures, the live check follows the form */
    planFigures: "The plan's warnings, at its own leverage, stop and the mark price; the live check on the right follows the form.",
    /** The stop typed is not below the entry: the sheet does not send it for the check, the server would refuse the order */
    whyStopWrong: 'Stop: not below the entry (the server refuses it); lower it, or leave it empty.',
    whyStopInvalid: 'Stop: enter a price, or leave it empty.',
    whyExits: (text: string) => `Exit plan: ${text}`,
    whyLiquidation: (safeLeverage: string) => `Liquidation before the stop${safeLeverage === '' ? '' : `: lower the leverage to ${safeLeverage}×`}.`,
    whyRefused: (code: string, text: string) => `Refused by the risk check (${code}): ${text}`,
    whyError: (text: string) => `Refused by the server: ${text}`,
    /** The live check's figures come from the form until the server has answered */
    estimated: 'estimated from the form; the server checks it next',
  },

  /** Take-profits and trailing stops: the editor of an order's exit plan and the exits of an open position. */
  exits: {
    section: 'Take-profit & trailing',
    sectionTitle: 'Exits attached to the order: take-profits, the cost-price stop and a trailing stop',
    unavailable: 'Take-profit and trailing exits are offered in paper trading and against the local mock only.',
    unknown: 'Whether exits are offered here could not be checked.',
    tp: 'Take-profit',
    tpMode: { none: 'None', single: 'Single', ladder: 'Ladder' } satisfies Record<TpMode, string>,
    basis: { price: 'Price', r: 'R', pct: '%' } satisfies Record<TpBasis, string>,
    basisTitle: 'R: multiples of the distance from the entry to the stop; %: percent from the entry; the value is converted when the basis changes',
    value: 'Price, R or %',
    atPrice: (px: string) => `= ${px}`,
    /** A typed price off the tick: the price it is rounded to (towards the entry, as the API rounds it) */
    onTick: (px: string, tick: string) => `= ${px} (rounded to the tick ${tick})`,
    asR: (r: string) => `${r}R`,
    /** The gain from the entry, "+26.22%" */
    gain: (pct: string) => `+${pct}`,
    legSize: (contracts: string) => `${contracts} ct`,
    legProfit: (usdt: string) => `+${usdt} USDT`,
    suggest: 'Suggest',
    suggestTitle: "Fill in the program's level: 2R with a stop (1.5R and 3R for a ladder), else 10% from the entry (5% and 10%)",
    /** The program's proposal for a level: "0.3437 (2R)" */
    proposal: (px: string, label: string) => `${px} (${label})`,
    /** The level (a price, an R multiple or a percentage) is not filled in */
    needPrice: (leg: number, proposal: string) => `Take-profit ${leg}: no level yet${proposal === '' ? '' : `; suggested ${proposal}`}.`,
    needShare: (leg: number, share: string) => `Take-profit ${leg}: no share yet${share === '' ? '' : `; suggested ${share}%`}.`,
    /** The level typed comes to a price on the losing side of the entry; the program's proposal ('' when none) */
    wrongSide: (leg: number, px: string, entry: string, short: boolean, proposal: string) =>
      `Take-profit ${leg}: ${px} is not ${short ? 'below' : 'above'} the entry ${entry} (a ${short ? 'short' : 'long'} takes profit ${short ? 'below' : 'above'} it)${proposal === '' ? '' : `; suggested ${proposal}`}.`,
    /** The leg's contracts, in whole lots, come to less than the minimum order: the server refuses the plan */
    legTooSmall: (leg: number, sz: string, minSz: string) => `Take-profit ${leg}: its share comes to ${sz} contracts, below the minimum order of ${minSz}: a larger share, fewer legs or a larger order.`,
    /** A position's resting take-profits: what they cover and the level the proposals are lifted beyond */
    restingCover: (covered: string, total: string, beyond: string) => `Take-profits resting for ${covered} of the ${total} contracts: a new leg is proposed for the rest, beyond ${beyond}.`,
    restingCoverAll: (total: string) => `The resting take-profits already cover the whole position (${total} contracts): cancel one to add a leg.`,
    howProposed: 'With a stop the levels are proposed in R (multiples of the distance from the entry to the stop); without one, as percentages from the entry.',
    /** A market order's levels are measured from the last price at the moment the exits section was opened */
    entryFrozen: (px: string) => `R and % are measured from ${px}, the last price when this section was opened; close and reopen it to measure from the price now.`,
    /** A stop is typed but not on the losing side: it does not count for the levels */
    stopWrongSide: (stop: string, short: boolean) =>
      `The stop ${stop} is not on the losing side of the entry (${short ? 'above it for a short' : 'below it for a long'}), so it does not count: the levels are proposed as percentages from the entry.`,
    pctOfSize: '% of size',
    pctOfPosition: '% of position',
    rest: 'rest',
    addLeg: '+ leg',
    removeLeg: 'Remove leg',
    breakeven: 'After the first take-profit, move the stop to the entry price',
    breakevenNeeds: 'needs a stop attached to the order and two legs or more',
    wholeOrderHint:
      'On an opening order the legs cover the whole order: the last one takes what the others leave. To take profit on part and let the rest trail, add take-profits to the position after the fill (Positions tab).',
    trailing: 'Trailing stop',
    trailingMode: { none: 'None', channel: 'Channel', callback: 'Callback' } satisfies Record<TrailingMode, string>,
    channelBars: 'Days',
    /** Channel trailing with its level known now */
    channelNow: (level: string, bars: string, short: boolean) =>
      `The stop is now at ${level} (the ${short ? 'highest high' : 'lowest low'} of the last ${bars} daily bars) and moves ${short ? 'down' : 'up'} only, after every 00:00 UTC close.`,
    /** Channel trailing whose level is computed when the order is placed */
    channelLater: (bars: string, short: boolean) =>
      `The stop will be the ${short ? 'highest high' : 'lowest low'} of the last ${bars} daily bars when the order is placed, and moves ${short ? 'down' : 'up'} only, after every 00:00 UTC close.`,
    /** The channel level now is not on the losing side of the entry: a stop there fires at once */
    channelWrongSide: (level: string, short: boolean) => `The level ${level} is not ${short ? 'above' : 'below'} the entry: a stop there would fire at once. Choose more days, or no channel trailing.`,
    callbackPct: 'Callback %',
    activePx: 'Activation price',
    optional: 'optional',
    /**
     * The callback trailing stop with where it would trigger ('' when unknown): at the current price, or at the
     * earliest once the price reaches the activation price (`pending`), and its activation price ('' when none)
     */
    callbackNow: (pct: string, px: string, activePx: string, short: boolean, pending: boolean) =>
      `Closes once the price comes back ${pct} from its ${short ? 'lowest' : 'highest'} since activation${
        px === '' ? '' : pending ? `; the earliest trigger is then ${px}` : `; at the current price that is ${px}`
      }${activePx === '' ? '' : `. Activates at ${activePx}`}.`,
    error: {
      TP_VALUE: (leg: number) => `Take-profit ${leg}: enter a price, an R multiple or a percentage above 0.`,
      TP_NEEDS_ENTRY: (leg: number) => `Take-profit ${leg}: an R multiple or a percentage needs an entry price (the limit price, or the last price for a market order).`,
      TP_R_NEEDS_STOP: (leg: number) => `Take-profit ${leg}: an R multiple needs an entry and a stop on the losing side.`,
      TP_WRONG_SIDE: (leg: number) => `Take-profit ${leg}: not on the profit side of the entry (above it for a long, below it for a short).`,
      TP_ORDER: (leg: number) => `Take-profit ${leg}: must be beyond take-profit ${leg - 1} (higher for a long, lower for a short): the legs fill in their order.`,
      TP_PCT: (leg: number) => `Take-profit ${leg}: enter its share as a percentage above 0 and at most 100.`,
      TP_LEG_TOO_SMALL: (leg: number) => `Take-profit ${leg}: its share comes to less than the minimum order: a larger share, fewer legs or a larger order.`,
      TP_REST: () => 'The legs before the last take 100% or more: nothing is left for the last one.',
      TP_OVER_100: () => 'The take-profit shares add up to more than 100%.',
      BREAKEVEN: () => 'The cost-price stop needs a stop and two take-profit legs or more.',
      CHANNEL_BARS: () => 'Channel days: a whole number from 2 to 100.',
      CALLBACK_RATIO: () => 'Callback: from 0.1% to 20%.',
      ACTIVE_PX: () => 'Activation price: a positive number, or empty.',
    } satisfies Record<ExitFormError['code'], (leg: number) => string>,
    /** What is missing or wrong with a take-profit leg, for the summary ("leg 2 not filled in, suggested 0.3794 (3R)") */
    legProblem: {
      missing: (proposal: string) => `not filled in${proposal === '' ? '' : `, suggested ${proposal}`}`,
      missingShare: (share: string) => `share not filled in${share === '' ? '' : `, suggested ${share}%`}`,
      TP_VALUE: 'not a valid level',
      TP_NEEDS_ENTRY: 'needs the entry price',
      TP_R_NEEDS_STOP: 'in R without a stop on the losing side',
      TP_WRONG_SIDE: 'not on the profit side of the entry',
      TP_ORDER: 'not beyond the leg before it',
      TP_PCT: 'share not valid',
      TP_LEG_TOO_SMALL: 'below the minimum order',
    },
    tpSharesProblem: 'take-profit shares to fix (100% or more before the last leg)',
    channelProblem: 'channel trailing stop: days to fix (2 to 100)',
    callbackProblem: 'callback trailing stop to fix (callback 0.1% to 20%, activation price a positive number or empty)',
    // the exit plan in words
    joinParts: (parts: string[]) => parts.join('; '),
    stopText: (px: string) => `stop ${px}`,
    tpNone: 'no take-profit',
    /** "2.00R 0.3437 (+26.22%, 100%)": the R and the gain when known; a leg with a problem says it instead */
    tpLegs: (legs: TpLegText[]) => legs.map((l, i) => (l.problem !== '' ? `leg ${i + 1} ${l.problem}` : `${l.r === '' ? '' : `${l.r} `}${l.px} (${[l.gain, l.pct].filter((s) => s !== '').join(', ')})`)).join(', '),
    tpList: (legs: TpLegText[]) =>
      `take-profit ${legs.map((l, i) => (l.problem !== '' ? `leg ${i + 1} ${l.problem}` : `${l.r === '' ? '' : `${l.r} `}${l.px} (${[l.gain, l.pct].filter((s) => s !== '').join(', ')})`)).join(', ')}`,
    breakevenOn: 'stop to the entry after the first take-profit',
    trailingNone: 'no trailing stop',
    trailingChannelText: (bars: number, level: string | null) => `trailing stop at the ${bars}-day low${level === null ? '' : `, now ${level}`}`,
    /** The callback trailing stop with its activation price and where it would trigger: at the current price, or, while the activation price is not reached (`pending`), at the earliest once it is */
    trailingCallbackText: (ratio: string, activePx: string | null, trigger: string | null, pending: boolean) =>
      `trailing stop ${ratio} callback${activePx === null ? '' : ` from ${activePx}`}${trigger === null ? '' : pending ? ` (${trigger} at the earliest)` : ` (${trigger} at the current price)`}`,
    // the exits of a position
    tpCount: (n: number) => `${n} legs`,
    channelShort: (bars: number, level: string) => `channel ${bars}d · ${level}`,
    callbackShort: (ratio: string, trigger: string) => `callback ${ratio}${trigger === '' ? '' : ` · ${trigger}`}`,
    colTp: 'Take-profit',
    colTpTitle: 'Take-profit orders resting at the exchange for the position',
    colTrailing: 'Trailing',
    colTrailingTitle: "The exchange's trailing stop (callback), or the channel trailing Pegasus keeps, with its level now",
    open: 'Exits',
    openTitle: 'Take-profits, trailing stops and channel trailing of this position',
    dialogTitle: (instId: string, side: string) => `Exits of ${instId} ${side}`,
    stops: 'Stop-loss',
    tps: 'Take-profit legs',
    trailingStops: "Trailing stop (exchange's)",
    channel: 'Channel trailing (Pegasus)',
    none: 'none',
    tpLine: (px: string, size: string) => `${px} · ${size}`,
    callbackLine: (ratio: string, trigger: string, active: string) =>
      `${ratio} callback${active === '' ? '' : `, from ${active}`}${trigger === '' ? ', not active yet' : `, triggers at ${trigger}`}`,
    channelLine: (bars: number, level: string) => `${bars}-day channel, stop at ${level}`,
    channelWaiting: (bars: number) => `${bars}-day channel, first level at the next daily close`,
    lastMove: (from: string, to: string, time: string) => `last moved ${from} → ${to} (${time})`,
    lastError: (msg: string) => `last attempt failed: ${msg}`,
    wholePosition: 'whole position',
    cancel: 'Cancel',
    confirmCancel: (what: string, instId: string) => `Cancel the ${what} of ${instId}?`,
    whatTp: (px: string) => `take-profit at ${px}`,
    whatTrailing: 'trailing stop',
    clearChannel: 'Stop channel trailing',
    clearChannelTitle: 'Pegasus stops moving the stop; the stop stays where it is',
    confirmClear: (instId: string) => `Stop channel trailing for ${instId}? The stop stays where it is.`,
    addTps: 'Add take-profit legs',
    addTpsHint: 'Each leg closes its share of the position; together they may cover less than all of it.',
    placeTps: 'Place take-profits',
    setTrailing: 'Set a trailing stop',
    place: 'Place',
    campaignPosition: "The campaign's position: its exits are the rule's and are not set by hand.",
    done: {
      tps: (n: number, instId: string) => `${n} take-profit leg${n === 1 ? '' : 's'} placed for ${instId}`,
      trailing: (instId: string, ratio: string) => `Trailing stop placed for ${instId}: ${ratio} callback`,
      channel: (instId: string, bars: number) => `Channel trailing set for ${instId}: ${bars}-day low`,
      cleared: (instId: string) => `Channel trailing stopped for ${instId}; the stop stays`,
      cancelled: (instId: string) => `Exit order cancelled for ${instId}`,
    },
    failed: (err: string) => `Not done: ${err}`,
  },

  /** The JOURNAL tab: every trade of the account (GET /api/journal). */
  journal: {
    loading: 'Loading the journal…',
    what: 'the journal',
    empty: 'No trade recorded yet',
    emptyFiltered: 'No trade matches the filters',
    status: { disabled: 'Not recording', starting: 'Starting', ready: 'Recording', blocked: 'Blocked' } satisfies Record<JournalStatus, string>,
    statusReason: {
      JOURNAL_DISABLED: 'This server keeps no trade journal: there is no account to record (no API key).',
      JOURNAL_STARTING: 'The journal is reading what happened while the API was not running; new trades appear once it is done.',
      JOURNAL_UNREADABLE: 'The journal file cannot be read: nothing is recorded until it is repaired or moved away.',
    } as Record<string, string>,
    filterCoin: 'Coin',
    filterSource: 'Source',
    filterStatus: 'Status',
    all: 'All',
    source: { manual: 'Manual', signal: 'Signal', campaign: 'Campaign', external: 'External' } satisfies Record<TradeSource, string>,
    sourceTitle: {
      manual: 'Opened from the order ticket',
      signal: 'A signal followed from the SIGNALS tab',
      campaign: "The campaign pot's own order",
      external: 'Not placed through Pegasus, or found open',
    } satisfies Record<TradeSource, string>,
    tradeStatus: { open: 'Open', closed: 'Closed' } satisfies Record<TradeStatus, string>,
    exitReason: {
      take_profit: 'take-profit',
      stop: 'stop',
      trailing: 'trailing stop',
      manual: 'by hand',
      campaign: 'campaign',
      liquidation: 'liquidated',
      adl: 'auto-deleveraged',
      external: 'outside Pegasus',
      unknown: 'unknown',
    } satisfies Record<TradeExitReason, string>,
    exitReasonLeg: (leg: number) => `take-profit ${leg}`,
    col: {
      opened: 'Opened',
      coin: 'Coin',
      side: 'Side',
      source: 'Source',
      entry: 'Entry avg',
      size: 'Size',
      notional: 'Notional',
      leverage: 'Leverage / mode',
      stop: 'Initial stop',
      tps: 'Take-profit plan',
      trailing: 'Trailing',
      status: 'Status',
      exit: 'Exit avg',
      pnl: 'Realised / net',
      realised: 'Realised',
      net: 'net',
      exitAndReason: 'exit avg · closed by',
      localUtc: 'local · UTC',
      r: 'R',
      duration: 'Held',
    },
    sizeTitle: 'Contracts opened in total (with the adds), and their coin',
    pnlTitle: 'Realised P&L of the exits; net is after fees and funding (USDT)',
    rTitle: 'Net P&L in multiples of the initial risk (entry to initial stop), once closed',
    tpCount: (n: number) => `${n} leg${n === 1 ? '' : 's'}`,
    openFor: (d: string) => `${d} so far`,
    adoptedTag: 'adopted',
    adoptedTitle: 'Found open without having seen it open: the entry is the position as the exchange reported it',
    shown: (n: number, total: number) => `${n} of ${total} trades`,
    loadOlder: 'Load older trades',
    loadingOlder: 'Loading…',
    detail: 'Trade',
    close: 'Close',
    loadingTrade: 'Loading the trade…',
    whatTrade: 'the trade',
    figures: 'Figures',
    opened: 'Opened',
    closed: 'Closed',
    held: 'Held',
    sizeNow: 'Size now',
    maxSize: 'Largest size',
    margin: 'Margin',
    fees: 'Fees',
    funding: 'Funding',
    realised: 'Realised',
    net: 'Net',
    initialRisk: 'Initial risk (1R)',
    closeReason: 'Closed by',
    plan: 'Plan',
    noPlan: 'No plan: Pegasus did not place the opening order (campaign or external), or the journal did not see its request.',
    planStop: 'Stop',
    planTps: 'Take-profits',
    planBreakeven: 'Cost-price stop',
    planTrailing: 'Trailing',
    yes: 'yes',
    no: 'no',
    signal: 'Signal followed',
    signalKind: { entry: 'entry', add: 'add' },
    signalLine: (kind: string, close: string, time: string, entryLevel: string, exitLevel: string) =>
      `${kind}: close ${close} (${time}); entry level ${entryLevel}, exit level ${exitLevel}`,
    fills: 'Fills',
    noFills: 'No fills recorded',
    role: { open: 'open', add: 'add', reduce: 'reduce', close: 'close' } satisfies Record<TradeFillRole, string>,
    colRole: 'Role',
    colPnl: 'P&L',
    colAfter: 'Held after',
    exits: 'Exits',
    colReason: 'Reason',
    timeline: 'Timeline',
    noTimeline: 'No event recorded',
    /** One sentence per event; the fields are formatted, '' when the event does not carry them */
    event: {
      order_placed: (e: EventText) =>
        `Order placed: ${e.side} ${e.contracts} contracts ${e.px === '' ? 'at market' : `at ${e.px}`}${e.source === '' ? '' : ` (${e.source})`}${e.plan === '' ? '' : `; ${e.plan}`}.`,
      order_cancelled: (e: EventText) => `Order cancelled${e.contracts === '' ? '' : `: ${e.contracts} contracts left unfilled`}.`,
      fill: (e: EventText) =>
        `Fill (${e.role}): ${e.side} ${e.contracts} contracts at ${e.px}${e.fee === '' ? '' : `, fee ${e.fee}`}${e.pnl === '' ? '' : `, P&L ${e.pnl}`}${e.reason === '' ? '' : ` — ${e.reason}`}.`,
      stop_placed: (e: EventText) => `Stop-loss placed at ${e.px}${e.contracts === '' ? '' : ` for ${e.contracts} contracts`}.`,
      stop_moved: (e: EventText) => `Stop-loss moved ${e.fromPx} → ${e.px}.`,
      stop_triggered: (e: EventText) => `Stop-loss triggered at ${e.px}.`,
      stop_cancelled: (e: EventText) => `Stop-loss at ${e.px} cancelled${e.code === '' ? '' : `: ${e.code}`}.`,
      tp_placed: (e: EventText) => `Take-profit ${e.leg} placed at ${e.px}${e.contracts === '' ? '' : ` for ${e.contracts} contracts`}.`,
      tp_moved: (e: EventText) => `Take-profit ${e.leg} moved ${e.fromPx} → ${e.px}.`,
      tp_triggered: (e: EventText) => `Take-profit ${e.leg} triggered at ${e.px}.`,
      tp_cancelled: (e: EventText) => `Take-profit ${e.leg} at ${e.px} cancelled${e.code === '' ? '' : `: ${e.code}`}.`,
      trailing_placed: (e: EventText) => `Trailing stop placed${e.px === '' ? '' : ` at ${e.px}`}${e.contracts === '' ? '' : ` for ${e.contracts} contracts`}.`,
      trailing_moved: (e: EventText) => `Trailing stop moved ${e.fromPx} → ${e.px}.`,
      trailing_triggered: (e: EventText) => `Trailing stop triggered${e.px === '' ? '' : ` at ${e.px}`}.`,
      trailing_cancelled: (e: EventText) => `Trailing stop cancelled${e.code === '' ? '' : `: ${e.code}`}.`,
      liquidation: (e: EventText) => `Liquidated: ${e.contracts} contracts at ${e.px}${e.pnl === '' ? '' : `, P&L ${e.pnl}`}.`,
      adopted: (e: EventText) => `Found open: ${e.contracts} contracts at ${e.px}${e.code === '' ? '' : ` (${e.code})`}.`,
      reconciled: (e: EventText) => `Reconciled with the exchange${e.code === '' ? '' : `: ${e.code}`}${e.contracts === '' ? '' : ` (${e.contracts} contracts)`}.`,
    } satisfies Record<JournalEventKind, (e: EventText) => string>,
    eventCode: {
      POSITION_CLOSED: 'the position was closed by then',
      POSITION_ADOPTED: 'the journal had not seen it open',
      POSITION_GONE: 'the position was gone, without fills to say how',
      SIZE_CORRECTED: 'the size set to what the exchange shows',
    } as Record<string, string>,
  },

  /** The CAMPAIGN tab: the scoreboard of the pot the API runs on the paper exchange (docs/strategy.md). */
  campaign: {
    loading: 'Loading the campaign…',
    what: 'the campaign',
    /** The tab on a stack where the campaign is disabled */
    disabledTitle: 'The campaign does not run on this stack',
    disabledNote: 'The campaign pot runs on a stack of its own, on its own paper account: start it with pnpm start --campaign (start-campaign.bat). Its page is on port 5175.',
    openCampaignPage: 'Open the campaign page',

    // the status
    status: 'Status',
    statusLabel: { disabled: 'disabled', blocked: 'blocked', running: 'running', finished: 'finished' },
    /** The reason of the status in words, by CampaignStatusReason.code; a code that is not here is shown with the API's message */
    reasons: {
      CAMPAIGN_DISABLED: 'The campaign is not enabled. It runs on paper trading only, with CAMPAIGN_ENABLED=1.',
      LEDGER_UNREADABLE: 'The ledger file cannot be read: nothing is traded until it is repaired or moved away.',
      ACCOUNT_NOT_DEDICATED: "The paper account is not the pot's own. The pot starts only on an account of its own: equity equal to the pot's start, no position, no open order.",
      ACCOUNT_UNAVAILABLE: 'The paper account cannot be read yet: nothing is traded until it can.',
      POT_FINISHED: 'The pot is finished: no campaign is open and the free cash is below the minimum stake. No other pot is started.',
    },
    rule: (r: CampaignRuleText) =>
      `${r.instruments} instruments · ${r.structure} · ${r.leverage}× isolated longs · enter on a daily close above the ${r.entryChannel}-day high, exit on one below the ${r.exitChannel}-day low${
        r.adds ? ` · add at every +${r.addStep}` : ''
      } · stake ${r.stakeFraction} of the free cash, at least ${r.minStake} USDT · pot ${r.potStart} USDT, bank ${r.bankFraction} of its value at every ×${r.rungFactor} rung`,

    // the steps
    steps: 'Steps',
    lastStep: 'Last step',
    nextStep: 'Next step',
    noStepYet: 'none yet',
    noNextStep: 'none: the campaign is not running',
    stepKind: { close: 'close', 'catch-up': 'catch-up' },
    stepRunning: 'running',
    stepEnded: (time: string) => `ended ${time}`,
    stepErrors: (n: number) => (n === 1 ? '1 execution error' : `${n} execution errors`),
    nextDaily: 'daily close: entries, exits, adds and the ladder',
    nextHalfDay: '12-hour close: adds and the ladder',
    /** Time left until the next close, ticking */
    countdown: (ms: number): string => {
      if (ms <= 0) return 'due now';
      const { h, m, s } = splitDuration(ms);
      return h > 0 ? `in ${h} h ${pad2(m)} min` : `in ${m} min ${pad2(s)} s`;
    },
    missedCloses: 'Missed closes',
    missedTitle:
      'Closes the service did not process in time (it was not running, or the account could not be read). An exit signal of a missed close is carried out late; adds and entries that were due are only logged.',
    foreign: (positions: string) =>
      `Positions on the campaign's instruments that the ledger does not know: ${positions}. They are reported, never touched, and no entry is made on those instruments.`,

    // the paper-stage acceptance
    acceptance: 'Paper-stage acceptance',
    ranToEnd: 'Campaigns run to their end',
    ranToEndTitle:
      'Campaigns the program ran to their end: closed on the exit signal, liquidated, or sold whole by a harvest. Stage G0 asks for 20, with no execution error, no missed close and a ledger the replay reproduces.',
    ofTarget: (n: number, target: number) => `${n} of ${target}`,
    notCounted: (open: number, external: number, unknown: number) =>
      `Not counted: ${open} open, ${external} closed by hand (external), ${unknown} ended without explanation (unknown).`,
    errorCount: 'Execution errors',
    errorCountTitle:
      'Actions the rule decided that were not carried out as decided, orders the book filled only in part, and positions left in a state the rule does not have. Skips the rule foresees are not errors.',
    errorTarget: 'target 0',
    noErrors: 'No execution error so far.',
    errors: 'Last execution errors',
    errorsShown: (shown: number, total: number) => `newest ${shown} of ${total}`,
    showAll: (n: number) => `Show all ${n}`,
    showFewer: 'Show fewer',
    code: 'Code',
    action: 'Action',
    message: 'Message',

    // the pot
    pot: 'Pot',
    notStarted: 'The pot has not started.',
    startValue: 'Start value',
    valueNow: 'Value now',
    freeCash: 'Free cash',
    openEquity: 'Open equity',
    banked: 'Banked',
    potMultiple: '(Value + banked) / start',
    potMultipleTitle: 'What the pot is worth now together with what it has banked, as a multiple of its start value',
    unknownNow: 'unknown: the account does not show it yet',
    nextRung: 'Next rung',
    rungsPassed: (n: number) => `${n} passed`,
    peak: 'Peak',
    noPeak: 'none yet',
    structure: 'Structure',
    structureLabel: { pyramid: 'pyramid', noadd: 'no-add' },
    btcAtStart: 'BTC mark at start',
    finishedAt: 'Finished',

    // the chart
    chart: 'Pot value',
    chartEmpty: 'No close processed yet: the lines start at the first step.',
    line: { value: 'Pot value', banked: 'Banked', heldBtc: 'Start value held in BTC' },
    replayLine: (structure: string, own: boolean) => (own ? `Replay, ${structure} (the pot's)` : `Replay, ${structure}`),
    latest: 'latest',
    replayOff: 'Replay unavailable: the pot has not started.',
    replayLoading: 'Loading the replay…',
    replayMissing: 'Replay unavailable: the API does not offer it yet (GET /api/campaign/replay answered 404).',
    replayError: (err: string) => `Replay unavailable: it could not be loaded (${err}).`,
    replayStatus: { unavailable: 'Replay unavailable', running: 'Replay being computed…', ready: 'Replay', failed: 'Replay failed' },
    replayWhy: (status: string, reason: string) => `${status}: ${reason}`,
    replayEarlier: (reason: string) => `The last replay failed (${reason}); the earlier result is shown.`,
    replayThrough: (through: string, computed: string) => `Replay through the ${through} close, computed ${computed}.`,

    // the campaigns
    campaigns: 'Campaigns',
    noCampaigns: 'No campaign yet',
    signalClose: 'Signal close',
    entryFill: 'Entry fill',
    stake: 'stake',
    adds: 'Adds',
    harvested: 'Harvested',
    proceeds: 'Proceeds',
    state: 'Status',
    multiple: 'Multiple',
    now: 'now',
    liqPx: 'Liq px',
    stateLabel: { open: 'open', exit: 'exit', liquidated: 'liquidated', harvest: 'harvest', external: 'external', unknown: 'unknown' },
    stateTitle: {
      open: 'Open: the multiple is (harvested + equity at the mark) / stake, now.',
      exit: 'Closed on the exit signal.',
      liquidated: 'Closed by the exchange: liquidated.',
      harvest: 'A harvest sold all of it (less than the minimum order would have been left).',
      external: "Closed by an order that was not the campaign's (by hand): the proceeds are not measured.",
      unknown: "The position was gone and the exchange's order history did not say why: an execution error.",
    },
    exitPending: 'exit pending',
    exitPendingTitle: (close: string) => `The exit signal of the ${close} close is not carried out yet: it is attempted again at every step.`,
    notMeasured: 'not measured',
    entryTitle: (time: string, contracts: string, price: string) => `filled ${time}: ${contracts} contracts; sized at ${price}`,
    addLine: (time: string, contracts: string, px: string) => `${time}: +${contracts} contracts @ ${px}`,

    // the bankings
    bankings: 'Bankings',
    noBankings: 'Nothing banked yet',
    close: 'Close',
    rungs: 'Rungs',
    value: 'Value',
    target: 'Target',
    fromCash: 'From cash',
    sold: 'Sold',
    fromSales: 'From sales',
    amount: 'Amount',

    // the reconciliation
    reconciliation: 'Reconciliation with the replay',
    verdict: { match: 'match', differs: 'differs', 'live-only': 'live only', 'replay-only': 'replay only' },
    reconAllMatch: 'Every campaign matches the replay.',
    reconNone: 'No campaign to reconcile yet.',
    campaign: 'Campaign',
    verdictCol: 'Verdict',
    differences: 'Differences',
    diff: (field: string, live: string, replay: string) => `${field}: live ${live}, replay ${replay}`,
    tolerances: (list: string) => `Tolerances: ${list}.`,

    // the decision log
    log: 'Decision log',
    logWhat: 'the decision log',
    logLoading: 'Loading the decision log…',
    logEmpty: 'No step yet',
    logCount: (shown: number, total: number) => `${shown} of ${total} steps`,
    loadOlder: 'Load older steps',
    loadingOlder: 'Loading…',
    seq: '#',
    kind: 'Kind',
    started: 'Started',
    ended: 'Ended',
    potBefore: 'Pot before',
    potBeforeLine: (value: string, freeCash: string, openEquity: string, banked: string, rungs: number) =>
      `Pot before the step: ${value} USDT · free cash ${freeCash} · open equity ${openEquity} · banked ${banked} · rungs passed ${rungs}`,
    actions: 'Actions',
    errorsCol: 'Errors',
    accountUnread: 'account not read',
    closesLooked: (closes: string) => `Closes looked at: ${closes}`,
    inputs: 'Inputs',
    notes: 'Notes',
    noActions: 'No action',
    halfDayBar: '12-hour bar O / H / L / C',
    price: 'Price',
    daily: 'Daily close',
    entryHigh: 'Entry high',
    exitLow: 'Exit low',
    signals: 'Signals',
    entrySignal: 'ENTRY',
    exitSignal: 'EXIT',
    notConfirmed: 'not confirmed in time',
    note: 'Note',
    plan: 'Plan',
    result: 'Result',
    outcome: 'Outcome',
    reason: 'Reason',
    attempts: 'Attempts',
    errorTag: 'execution error',
    actionKind: { bank: 'bank', sell: 'sell', exit: 'exit', add: 'add', enter: 'enter', liquidated: 'liquidated', gone: 'gone', foreign: 'foreign' },
    outcomeLabel: { done: 'done', skipped: 'skipped', missed: 'missed', failed: 'failed', noted: 'noted' },
    /** The rules behind a skip, by the reason the log gives; an error code is shown as it came */
    skipReason: {
      cash: 'free cash below the minimum stake',
      'min-size': 'below the minimum order',
      'add-cap': 'add cap reached',
      'kill-switch': 'kill switch on',
      'foreign-position': 'position the ledger does not know',
      'position-gone': 'position gone',
      liquidated: 'liquidated already',
      external: 'closed by hand already',
    },
    group: (kind: string, outcome: string | null, count: number) => `${kind}${outcome === null ? '' : ` ${outcome}`} ×${count}`,
  },

  /** What an API error code means, for the codes the server explains in English only; empty here: the server's own message is shown. */
  apiErrors: {} as Record<string, string>,
  /** "CODE: explanation (the server's message)" */
  errorWithMessage: (code: string, known: string, message: string) => `${code}: ${known} (${message})`,
  /** A risk rejection in words, by RiskCheckResult.code, from its details and the server's message. The older codes are worded by the server in English. */
  riskReject: {
    MAX_ORDER_NOTIONAL: (d: RiskDetails) => `the order's notional ${usdtOf(d, 'notional')} is over the per-order limit of ${usdtOf(d, 'limit')}`,
    MAX_POSITION_NOTIONAL: (d: RiskDetails) => `the coin's positions would come to ${usdtOf(d, 'projected')}, over its limit of ${usdtOf(d, 'limit')}`,
    MAX_TOTAL_NOTIONAL: (d: RiskDetails) => `all positions would come to ${usdtOf(d, 'projected')}, over the total limit of ${usdtOf(d, 'limit')}`,
    TP_WRONG_SIDE: (d: RiskDetails) =>
      `Take-profit ${val(d, 'leg')} at ${val(d, 'triggerPx')} is on the wrong side: a long's take-profit must be above both the entry ${val(d, 'entryPx')} and the mark ${val(d, 'markPx')} (a short's below both).`,
    CALLBACK_RATIO: (d: RiskDetails) => `The callback ${val(d, 'callbackRatio')} is outside the allowed 0.1% to 20%.`,
    ACTIVE_PX_WRONG_SIDE: (d: RiskDetails) =>
      `The activation price ${val(d, 'activePx')} must be beyond the mark ${val(d, 'markPx')} and the last price ${val(d, 'lastPx')} on the profit side (above both for a long).`,
  } as Record<string, (details: RiskDetails, message: string) => string>,
  /** Errors of the exits and the journal in words, by code, from their details */
  errorWords: {
    EXITS_UNAVAILABLE: () => 'Take-profit and trailing exits are offered in paper trading and against the local mock only: nothing was sent.',
    TP_LEG_TOO_SMALL: (d: RiskDetails) =>
      `Take-profit ${val(d, 'leg')} would close ${val(d, 'sz')} contracts, below the minimum order of ${val(d, 'minSz')}: use fewer legs or a larger size.`,
    TP_TRIGGERS_NOT_DISTINCT: (d: RiskDetails) => `Two take-profit legs have the same price once rounded to the tick (${val(d, 'triggers')}): give each its own price.`,
    BREAKEVEN_NEEDS_SPLIT_TP: () => 'The cost-price stop needs a stop and two take-profit legs or more.',
    TP_EXCEEDS_POSITION: (d: RiskDetails) =>
      `With the ${val(d, 'existing')} contracts the take-profits already close, these ${val(d, 'requested')} would close more than the position's ${val(d, 'size')}: cancel one or ask for less.`,
    TRAILING_EXCEEDS_POSITION: (d: RiskDetails) =>
      `With the ${val(d, 'existing')} contracts the trailing stops already close, ${val(d, 'requested')} more would close more than the position's ${val(d, 'size')}.`,
    CAMPAIGN_POSITION: () => "This is the campaign's position: its exits are the rule's and are not set by hand.",
    TRAILING_STATE_UNREADABLE: () => "Channel trailing is off: the API's trailing state file cannot be read. Repair it or move it away.",
    TRADE_NOT_FOUND: (d: RiskDetails) => `The journal has no trade ${val(d, 'id')}.`,
  } as Record<string, (details: RiskDetails) => string>,
};


export type Messages = typeof en;
