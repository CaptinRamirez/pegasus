import { D, Decimal, floorToStep, notionalQuote, type AlgoOrderList, type ConnState, type ConnectionStatus, type InstId, type Instrument, type Lang, type Localized, type MarketStream, type Position, type PositionOverLimit, type RiskState } from '@pegasus/shared';
import { fmtNum, fmtTime } from '../lib/format';
import type { TerminalState } from './types';

/** One line of the banner under the header, in both languages: the banner shows the one of the page. */
export interface Alert extends Localized {
  id: string;
}

export type AlertInput = Pick<TerminalState, 'wsStatus' | 'wsDownSince' | 'lastMessageAt' | 'connection' | 'connectionAt' | 'privateDownSince'>;

type AlertCondition = (s: AlertInput, now: number) => Alert | null;

/** A reconnect that succeeds within this time is not worth a banner. */
export const BACKEND_DOWN_GRACE_MS = 3_000;
const STREAMS_NAMED = 3;
const STREAM_LABEL: Record<MarketStream, Localized> = {
  ticker: { en: 'price', zh: '价格' },
  book: { en: 'order book', zh: '盘口' },
  mark: { en: 'mark price', zh: '标记价格' },
};
/** A socket state as the Chinese lines name it; the English ones use the state's own word. */
const CONN_ZH: Record<ConnState, string> = { connected: '已连接', connecting: '正在重连', disconnected: '已断开' };
/** Account data older than this is labelled with the time it is from: the reconcile runs every 60 s. */
export const ACCOUNT_STALE_MS = 90_000;
/** The account stream reconnects by itself within seconds; only a longer outage is worth a banner. */
export const ACCOUNT_STREAM_GRACE_MS = 10_000;

/** Plain-language reading of the OKX codes documented in docs/okx-api-notes.md (10.2, 10.6); any other failure is shown verbatim only. */
const ACCOUNT_ERROR_HINT: Record<string, { en: string; zh: string }> = {
  '50100': { en: 'OKX has frozen this API key', zh: 'API key 已被 OKX 冻结' },
  '50101': {
    en: 'the API key belongs to the other OKX environment (a demo key used for live trading, or the reverse); check OKX_DEMO in .env',
    zh: 'API key 与当前环境（实盘/模拟盘）不匹配，请检查 .env 中的 OKX_DEMO',
  },
  '50102': { en: "this computer's clock is too far from OKX's; synchronise the system time", zh: '本机时间与 OKX 相差过大，请同步系统时间' },
  '50105': { en: 'the API passphrase is wrong', zh: 'API 密码短语（passphrase）错误' },
  '50110': { en: "this computer's IP address is not on the API key's allow-list", zh: '本机 IP 不在 API key 的白名单内' },
  '50111': { en: 'OKX does not recognise the API key', zh: 'API key 无效' },
  '50113': { en: 'the request signature is invalid; the API secret is probably wrong', zh: '签名无效，API secret 可能有误' },
  '60009': { en: 'OKX rejected the login of the account stream; check the API key, secret and passphrase', zh: 'OKX 拒绝了账户推送的登录，请检查 API key、secret 和 passphrase' },
};

const backendDown: AlertCondition = (s, now) => {
  if (s.wsStatus === 'open' || s.wsDownSince === null || now - s.wsDownSince <= BACKEND_DOWN_GRACE_MS) return null;
  if (s.lastMessageAt === null) {
    return {
      id: 'backend',
      en: `Cannot reach the backend (trying since ${fmtTime(s.wsDownSince)}). Nothing below is live.`,
      zh: `无法连接后端（自 ${fmtTime(s.wsDownSince)} 起持续重试）。下方数据都不是实时数据。`,
    };
  }
  return {
    id: 'backend',
    en: `Backend disconnected since ${fmtTime(s.lastMessageAt)}. Prices, order book and positions below are frozen.`,
    zh: `与后端的连接已于 ${fmtTime(s.lastMessageAt)} 断开。下方的价格、盘口和持仓已停止更新。`,
  };
};

/** " Oldest data: 14:03:22." when the server knows how old its market data is. */
function oldestData(c: ConnectionStatus, at: number | null): Localized {
  if (at === null || c.dataAgeMs < 0) return { en: '', zh: '' };
  const time = fmtTime(at - c.dataAgeMs);
  return { en: ` Oldest data: ${time}.`, zh: `最旧的数据来自 ${time}。` };
}

const okxMarketDown: AlertCondition = (s) => {
  const c = s.connection;
  if (c === null || c.okxPublic === 'connected') return null;
  const oldest = oldestData(c, s.connectionAt);
  return {
    id: 'okx-public',
    en: `OKX market data feed ${c.okxPublic}. Prices and order books are frozen.${oldest.en}`,
    zh: `OKX 行情连接${CONN_ZH[c.okxPublic]}，价格和盘口已停止更新。${oldest.zh}`,
  };
};

const okxCandlesDown: AlertCondition = (s) => {
  const c = s.connection;
  if (c === null || c.okxBusiness === 'connected') return null;
  return { id: 'okx-business', en: `OKX candle feed ${c.okxBusiness}. The chart is not updating.`, zh: `OKX K线连接${CONN_ZH[c.okxBusiness]}，图表已停止更新。` };
};

function describeStream(key: string, lang: Lang): string {
  const i = key.lastIndexOf(':');
  const stream = key.slice(i + 1);
  const label = stream === 'ticker' || stream === 'book' || stream === 'mark' ? STREAM_LABEL[stream][lang] : stream;
  return `${key.slice(0, i)} ${label}`;
}

const staleStreams: AlertCondition = (s) => {
  const c = s.connection;
  // With the feed itself down every stream is listed; the feed alert already says so.
  if (c === null || c.okxPublic !== 'connected' || c.staleStreams.length === 0) return null;
  const named = (lang: Lang): string => c.staleStreams.slice(0, STREAMS_NAMED).map((key) => describeStream(key, lang)).join(lang === 'zh' ? '、' : ', ');
  const extra = c.staleStreams.length - STREAMS_NAMED;
  const oldest = oldestData(c, s.connectionAt);
  return {
    id: 'stale',
    en: `Market data stopped updating: ${named('en')}${extra > 0 ? ` (+${extra} more)` : ''}. Those values are frozen.${oldest.en}`,
    zh: `部分行情已停止更新：${named('zh')}${extra > 0 ? `（另有 ${extra} 项）` : ''}。这些数值已不再变化。${oldest.zh}`,
  };
};

/**
 * The private socket is down while the account itself is fine: the REST reconcile keeps the data at most a
 * minute old, which no other alert says. Without an API key that socket is never connected and nothing is missing.
 */
const accountStreamDown: AlertCondition = (s, now) => {
  const c = s.connection;
  if (c === null || c.account.state !== 'ok' || c.okxPrivate === 'connected') return null;
  if (s.privateDownSince === null || now - s.privateDownSince <= ACCOUNT_STREAM_GRACE_MS) return null;
  return {
    id: 'okx-private',
    en: `OKX account stream ${c.okxPrivate} since ${fmtTime(s.privateDownSince)}. Positions, orders and balance refresh only about once a minute.`,
    zh: `OKX 账户推送自 ${fmtTime(s.privateDownSince)} 起${CONN_ZH[c.okxPrivate]}。持仓、委托和余额约每分钟才刷新一次。`,
  };
};

const accountFailed: AlertCondition = (s, now) => {
  const c = s.connection;
  const a = c?.account;
  if (c === null || a === undefined || a.state !== 'error' || a.error === null) return null;
  const hint = ACCOUNT_ERROR_HINT[a.error.code];
  const why = { en: hint === undefined ? '' : `: ${hint.en}`, zh: hint === undefined ? '' : `：${hint.zh}` };
  const said = a.error.code === '' ? a.error.message : `OKX: [${a.error.code}] ${a.error.message}`;
  if (a.lastSyncAt === null) {
    return {
      id: 'account',
      en: `Account data is not updating${why.en} (${said}). Positions, orders and balance are NOT loaded: an empty table does not mean a flat account.`,
      zh: `账户数据未更新${why.zh}（${said}）。持仓、委托和余额尚未加载：空表不代表空仓。`,
    };
  }
  if (now - a.lastSyncAt > ACCOUNT_STALE_MS) {
    return {
      id: 'account',
      en: `Account data is not updating since ${fmtTime(a.lastSyncAt)}${why.en} (${said}). Positions, orders and balance below are from that time.`,
      zh: `账户数据自 ${fmtTime(a.lastSyncAt)} 起停止更新${why.zh}（${said}）。下方的持仓、委托和余额是那一刻的数据。`,
    };
  }
  // The data is still arriving one way or the other: say which half is missing instead of "not updating".
  if (c.okxPrivate === 'connected') {
    return {
      id: 'account',
      en: `The last account refresh failed${why.en} (${said}). Live updates from the account stream still arrive.`,
      zh: `最近一次账户刷新失败${why.zh}（${said}）。账户推送的实时更新仍在到达。`,
    };
  }
  return {
    id: 'account',
    en: `Live account stream unavailable${why.en} (${said}). Positions, orders and balance refresh about once a minute.`,
    zh: `账户实时推送不可用${why.zh}（${said}）。持仓、委托和余额约每分钟刷新一次。`,
  };
};

/** Checked in order; add further conditions here. */
const CONDITIONS: AlertCondition[] = [backendDown, okxMarketDown, okxCandlesDown, staleStreams, accountStreamDown, accountFailed];

export function activeAlerts(s: AlertInput, now: number): Alert[] {
  const out: Alert[] = [];
  for (const condition of CONDITIONS) {
    const alert = condition(s, now);
    if (alert !== null) out.push(alert);
  }
  return out;
}

/** The time account data is from, when that is worth saying: the last sync once it is older than 90 s; null while fresh or unknown. */
export function accountAsOf(connection: ConnectionStatus | null, now: number): number | null {
  const at = connection?.account.lastSyncAt ?? null;
  return at !== null && now - at > ACCOUNT_STALE_MS ? at : null;
}

/**
 * Stops older than this are marked with the time they were read: the server reads them with every reconcile
 * (60 s) and sends the list after each read, so a list this old means its reads are failing or the socket is down.
 */
export const STOPS_STALE_MS = 150_000;

/** The time the stops were read, when that is worth a warning: once the list is older than STOPS_STALE_MS; null while fresh or not read. */
export function stopsAsOf(list: AlgoOrderList | null, now: number): number | null {
  return list !== null && now - list.ts > STOPS_STALE_MS ? list.ts : null;
}

export type AccountUnknown = 'waiting' | 'disabled' | 'loading' | 'failed' | 'unloaded';

/**
 * Why the page holds no account data although the account may not be flat: the server was never heard
 * (waiting), no API key is configured, the first load is still running, it failed, or the socket went down
 * before the account was ever loaded (unloaded). null when the data was loaded, however old it is by now.
 */
export function accountUnknown(s: Pick<TerminalState, 'connection' | 'accountLoaded' | 'lastMessageAt'>): AccountUnknown | null {
  if (s.connection === null) {
    if (s.lastMessageAt === null) return 'waiting';
    return s.accountLoaded ? null : 'unloaded';
  }
  const a = s.connection.account;
  if (a.state === 'disabled') return 'disabled';
  if (a.lastSyncAt !== null) return null;
  return a.state === 'error' ? 'failed' : 'loading';
}

/** What the kill switch's cancel sweep will do, for the confirmation dialog: it must not promise a cancel that cannot happen. */
export function killSwitchSweepNotice(s: Pick<TerminalState, 'connection' | 'account'>, lang: Lang = 'en'): string {
  const zh = lang === 'zh';
  if (s.connection?.account.state === 'disabled') {
    return zh ? '未配置 API key，Pegasus 无法撤销任何委托：你在 OKX 上的当前委托保持不变。' : 'No API key is configured, so Pegasus cannot cancel anything: your open orders on OKX stay as they are.';
  }
  if (s.account === null) {
    return zh ? '账户尚未加载，Pegasus 可能无法撤销你的当前委托：请到 OKX 上查看并在那里撤单。' : 'The account is not loaded, so Pegasus may not be able to cancel your open orders: check them on OKX and cancel them there.';
  }
  // The sweep is not attempted with a key that cannot trade.
  if (!s.account.canTrade) {
    return zh ? '该 API key 为只读，Pegasus 无法撤销任何委托：你在 OKX 上的当前委托保持不变。' : 'This API key is read-only, so Pegasus cannot cancel anything: your open orders on OKX stay as they are.';
  }
  if (zh) return '账户上的全部当前委托都会被撤销，包括挂着的离场委托（止盈 / 止损限价单）和你直接在 OKX 上下的委托。OKX 上的条件（策略）止损单不受影响。持仓保持不变。';
  return (
    'ALL open orders on the account will be cancelled, including resting exit orders (take-profit / stop limit orders) and orders you placed on OKX directly. ' +
    'Conditional (algo) stop orders on OKX are not touched. Positions stay open.'
  );
}

/** Whether what the page holds for the stream may be out of date: the server flagged it, or the server cannot be heard. */
export function isStreamStale(s: Pick<TerminalState, 'connection'>, instId: InstId | null, stream: MarketStream): boolean {
  if (s.connection === null) return true;
  return instId !== null && s.connection.staleStreams.includes(`${instId}:${stream}`);
}

/** How much of one position row to close so that its instrument is back at the per-instrument limit. */
export interface TrimAdvice {
  /** Quote (USD) notional to close: the instrument's excess, at most the row's own notional */
  quote: Decimal;
  /** The same in contracts, rounded down to lotSz; null when the row cannot be valued per contract (untracked instrument, no price) */
  contracts: Decimal | null;
}

/**
 * The trim shown on a position row of an instrument in RiskState.overLimit. A contract is valued as OKX values the
 * position (notionalUsd / pos), else at the mark price. `over.excess` is what this row is to close: with several
 * rows on the instrument (long/short mode) pass the row's share from trimShares, not the instrument's excess.
 */
export function trimAdvice(p: Position, over: PositionOverLimit, inst?: Instrument): TrimAdvice {
  const absPos = D(p.pos || '0').abs();
  const rowNotional = D(p.notionalUsd || '0').abs();
  const excess = D(over.excess);
  const quote = rowNotional.gt(0) ? Decimal.min(excess, rowNotional) : excess;
  if (inst === undefined || absPos.isZero()) return { quote, contracts: null };
  const perContract = rowNotional.gt(0) ? rowNotional.div(absPos) : D(p.markPx || '0').gt(0) ? notionalQuote(1, p.markPx, inst) : null;
  if (perContract === null || perContract.lte(0)) return { quote, contracts: null };
  return { quote, contracts: floorToStep(Decimal.min(quote.div(perContract), absPos), inst.lotSz) };
}

/**
 * How an instrument's excess is spread over its position rows (the two legs of long/short mode): all of it on the
 * larger leg, and only what that leg cannot cover on the next. Showing the whole excess on every row would have the
 * trader close it once per row. A row that gets nothing is not in the map; a leg OKX reports no notional for takes
 * what is left (trimAdvice values it at the mark).
 */
export function trimShares(positions: Position[], over: PositionOverLimit): Map<Position, Decimal> {
  const size = (p: Position): Decimal => D(p.notionalUsd || '0').abs();
  const legs = positions
    .filter((p) => p.instId === over.instId && !D(p.pos || '0').isZero())
    .sort((a, b) => size(b).cmp(size(a)) || D(b.pos).abs().cmp(D(a.pos).abs()));
  const shares = new Map<Position, Decimal>();
  let left = D(over.excess);
  for (const leg of legs) {
    if (left.lte(0)) break;
    const share = size(leg).gt(0) ? Decimal.min(left, size(leg)) : left;
    shares.set(leg, share);
    left = left.sub(share);
  }
  return shares;
}

/** The one-line advisory of the risk panel while a position has outgrown a notional limit; null while none has. */
export function overLimitNotice(risk: Pick<RiskState, 'overLimit' | 'totalOverLimit'> | null, lang: Lang = 'en'): string | null {
  if (risk === null) return null;
  const zh = lang === 'zh';
  const parts: string[] = [];
  if (risk.overLimit.length > 0) {
    parts.push(
      zh
        ? `超过单合约上限：${risk.overLimit.map((o) => `${o.instId} 超出 ${fmtNum(o.excess, 0)} USD`).join('、')}。`
        : `Over the per-instrument limit: ${risk.overLimit.map((o) => `${o.instId} by ${fmtNum(o.excess, 0)} USD`).join(', ')}.`,
    );
  }
  if (risk.totalOverLimit !== '') {
    parts.push(zh ? `持仓总名义价值超出上限 ${fmtNum(risk.totalOverLimit, 0)} USD。` : `Total position notional is ${fmtNum(risk.totalOverLimit, 0)} USD over the limit.`);
  }
  if (parts.length === 0) return null;
  // Advisory only: Pegasus never trades by itself and blocks nothing because of it.
  return zh ? `${parts.join('')}请减仓至上限以内；平仓订单始终允许。` : `${parts.join(' ')} Trim back to the limit; closing orders are always allowed.`;
}
