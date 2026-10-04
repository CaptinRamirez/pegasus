import type { CancelSweepState, Order, PlaceOrderRequest, PosSide, Side, TrendParams } from '@pegasus/shared';
import type { Intent } from '../components/ticket/form';
import { fmtAgeCoarse } from '../lib/format';

/** Diagnostic values of a risk rejection (RiskCheckResult.details). */
export type RiskDetails = Record<string, unknown>;

const OTHER_LOT_TITLE =
  "A position or an entry order on this side is already open. Each daily cut trades its own lot: apply this row only if what is open is the other cut's lot and this cut's own lot is not in yet. Pegasus does not track which lot belongs to which cut.";

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

  toasts: { dismiss: 'Click to dismiss' },

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

  tabs: { positions: 'Positions', orders: 'Open orders', stops: 'Stops', history: 'History', fills: 'Fills', signals: 'Signals' },

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

  signals: {
    ticketFilled: (side: Side, contracts: string, instId: string, px: string, cut: string | null, noStop: boolean) =>
      `Ticket filled: ${side} ${contracts} contracts ${instId} @ ${px}${cut === null ? '' : ` (${cut} cut)`}${
        noStop ? '. NO stop was carried into the ticket (the plan has no positive stop price): set the stop yourself' : ''
      }`,
    refreshing: 'Refreshing…',
    riskTitle: (cuts: number) =>
      `Risk per trade as a fraction of equity. The framework uses 0.5% for the first three months and 0.75% afterwards.${
        cuts > 1 ? ` It is the risk of one unit, shared equally between the ${cuts} daily cuts.` : ''
      }`,
    risk: 'risk',
    barClosedTitle:
      'The most recent daily candle the signals are computed from; every cut has its own (see the rows). Shown in the warning colour when a newer bar should already exist for one of the rows.',
    barClosed: (time: string, ageMs: number) => `bar closed ${time}, ${fmtAgeCoarse(ageMs)} ago`,
    updated: 'updated',
    equity: 'equity',
    lotTitle: (riskPct: string, capPct: string) => `One cut's lot: risk ${riskPct} of equity, notional cap ${capPct}. The lots of an instrument together are one unit.`,
    perUnit: (riskPct: string, capPct: string, cuts: number) => `risk ${riskPct} of equity per unit · notional cap ${capPct} · each cut sized at 1/${cuts} of a unit`,
    perTrade: (riskPct: string, capPct: string) => `risk ${riskPct} of equity per trade · notional cap ${capPct}`,
    /** The rules in one line; `cuts` are the close times of the daily cuts, `utcDaily` a single cut at 00:00 UTC. */
    summary: (cuts: string[], utcDaily: boolean, p: TrendParams, shortsOff: boolean) =>
      `${cuts.length > 1 ? `daily closes at ${cuts.join(' and ')}` : utcDaily ? 'UTC daily close' : `daily close at ${cuts[0] ?? ''}`} · ${p.entryChannel}d breakout · MA${p.trendMaPeriod} · ${p.atrStopMultiple}×ATR(${p.atrPeriod}) stop${
        shortsOff ? ' · shorts off' : ''
      } · auto-refresh 5m`,
    unavailable: 'Signals unavailable',
    loading: 'Loading signals…',
    noInstruments: 'No instruments to report on',
    outdated: (time: string) => `Signals not updated since ${time}. The table below may be out of date; Apply is disabled.`,
    regime: 'Regime',
    close: 'Close',
    distAtr: 'dist (ATR)',
    atrPct: 'ATR %',
    dHigh: (n: number) => `${n}d high`,
    dLow: (n: number) => `${n}d low`,
    exitTitle: 'The exit channel the last close was tested against. The level for the next session is in the expanded row.',
    erTitle: (n: number) => `Efficiency ratio over ${n} days: |net move| / path length`,
    volRatio: 'Vol ratio',
    volRatioTitle: (short: number, long: number) => `${short}d / ${long}d realised vol`,
    funding3d: 'Funding 3d',
    annualised: 'annualised',
    book: 'Book',
    bookTitle: 'Depth imbalance (bid − ask) / (bid + ask) over the visible book; execution context only, not a direction signal',
    spreadDepth: 'spread · depth',
    oi: 'OI',
    oiTitle: 'Open interest of the instrument: current level; change over the last 10 completed UTC days (over the last completed day), measured in coin',
    oiSub: '10d chg (1d)',
    signals: 'Signals',
    stopLong: 'Stop long',
    stopShort: 'stop short',
    stopPct: 'Stop %',
    contractsTitle: (shortsOff: boolean): string =>
      shortsOff ? 'Size of a new long. Short entries are switched off (allowShort = false).' : 'Size of a new long; the sub line is the size of a new short (shorts are sized at half)',
    contractsLong: 'Contracts long',
    short: 'short',
    coinLong: 'Coin long',
    notionalTitle: 'Notional of the contracts shown, after rounding down to whole lots',
    notionalLong: 'Notional long',
    riskLong: 'Risk long',
  },

  row: {
    inPositionTitle: 'A position on this side is already open. Adding to an open position (pyramiding) is not part of the framework yet.',
    entryPendingTitle: 'An entry order on this side is already open and not filled yet. Cancel it or let it fill before applying the signal again, or the position would be doubled.',
    otherLotTitle: OTHER_LOT_TITLE,
    unitFullTitle: 'The position and the entry orders on this side already amount to the lots of all the daily cuts (one unit). Adding more (pyramiding) is not part of the framework yet.',
    outdatedTitle: 'The signals could not be refreshed, so this row may be out of date. Refresh before applying it.',
    fundingUncheckedTitle: 'The funding history was unavailable, so the funding gate was skipped for this entry. Check the funding rate on OKX before acting.',
    latestCutTitle: 'The daily bar of this cut closed most recently: this is the row to act on now.',
    shortsOffTitle: 'Short entries are switched off (allowShort = false). The short exit and the stop of an open short are still shown.',
    capped: 'capped',
    noEquity: 'no equity',
    shortOff: 'short off',
    bookTitle: (levels: number) => `Visible depth over ${levels} levels; execution context only, not a direction signal.`,
    oiUnit: { usd: 'USD', contracts: 'contracts' },
    oiTitleLive: (unit: string) => `Live open interest of this instrument in ${unit}. Its daily history is unavailable right now, so the 1-day and 10-day changes cannot be shown.`,
    oiTitleHistory: (unit: string, points: number) =>
      `Open interest of this instrument in ${unit}: the level is today's value so far. The changes compare completed UTC days (OKX daily history, ${points} days): the last completed day against 10 days before it (against the day before it), measured in coin, so a price move alone does not count.`,
    liveNoHistory: 'live · no history',
    structureLabel: 'structure:',
    bookNa: 'book n/a',
    bookLine: (imbalance: string, spread: string, depth: string) => `book imbalance ${imbalance}, spread ${spread}, depth ${depth}`,
    oiNa: 'OI n/a',
    oiLive: (level: string) => `OI ${level} (live level; history and changes unavailable)`,
    oiLine: (level: string, change1d: string, change10d: string, percentile: string) => `OI ${level}, 1d ${change1d}, 10d ${change10d}, pct ${percentile}`,
    latestClose: ' · latest close',
    volTitle: (short: number, volShort: string, long: number, volLong: string) => `${short}d vol ${volShort} / ${long}d vol ${volLong} (annualised)`,
    perAnnum: (pct: string) => `${pct} p.a.`,
    fundingUnchecked: 'funding unchecked',
    inPosition: 'in position',
    entryPending: 'entry pending',
    sizeAdjust: (multiplier: string, adjustments: string[]) => `size ×${multiplier}: ${adjustments.join(', ')}`,
    noEquityTitle: 'No equity: sizing unavailable',
    /** `otherLot`: something is already open on the side, which may be the lot of another cut */
    fillTicketTitle: (side: Side, contracts: string, close: string, otherLot: boolean) => `Fill the ticket: ${side} ${contracts} contracts @ ${close}${otherLot ? `. ${OTHER_LOT_TITLE}` : ''}`,
    apply: 'Apply',
    sizingNoEquity: 'sizing: no equity available (sign in with a funded account or pass ?equity)',
    sizingLong: 'sizing long:',
    sizingShort: 'sizing short:',
    sizingShortOff: 'sizing short: off (short entries are switched off, allowShort = false)',
    nextSession: (exitChannel: number, longStop: string, shortStop: string) =>
      `next session (the ${exitChannel}-day channel including the last bar): trail a long's exchange stop to ${longStop}, a short's to ${shortStop}; only ever move a stop in the position's favour`,
    barClosed: (time: string) => `bar closed ${time}`,
    dataFetched: (time: string) => ` · exchange data fetched ${time}`,
    longEntry: 'LONG ENTRY',
    shortEntry: 'SHORT ENTRY',
    longExit: 'LONG EXIT',
    shortExit: 'SHORT EXIT',
  },

  /** What an API error code means, for the codes the server explains in English only; empty here: the server's own message is shown. */
  apiErrors: {} as Record<string, string>,
  /** A risk rejection in words, by RiskCheckResult.code, from its details and the server's message; empty here for the same reason. */
  riskReject: {} as Record<string, (details: RiskDetails, message: string) => string>,
};

export type Messages = typeof en;
