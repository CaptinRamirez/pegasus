import type { ConnectionStatus, InstId, MarketStream } from '@pegasus/shared';
import { fmtTime } from '../lib/format';
import type { TerminalState } from './types';

/** One line of the banner under the header: English first, then a short Chinese line for the owner. */
export interface Alert {
  id: string;
  en: string;
  zh: string;
}

export type AlertInput = Pick<TerminalState, 'wsStatus' | 'wsDownSince' | 'lastMessageAt' | 'connection' | 'connectionAt' | 'privateDownSince'>;

type AlertCondition = (s: AlertInput, now: number) => Alert | null;

/** A reconnect that succeeds within this time is not worth a banner. */
export const BACKEND_DOWN_GRACE_MS = 3_000;
const STREAMS_NAMED = 3;
const STREAM_LABEL: Record<MarketStream, string> = { ticker: 'price', book: 'order book', mark: 'mark price' };
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
      zh: '无法连接后端，下方数据不是实时数据',
    };
  }
  return {
    id: 'backend',
    en: `Backend disconnected since ${fmtTime(s.lastMessageAt)}. Prices, order book and positions below are frozen.`,
    zh: '与后端的连接已断开，下方数据已停止更新',
  };
};

/** " Oldest data: 14:03:22." when the server knows how old its market data is. */
function oldestData(c: ConnectionStatus, at: number | null): string {
  return at === null || c.dataAgeMs < 0 ? '' : ` Oldest data: ${fmtTime(at - c.dataAgeMs)}.`;
}

const okxMarketDown: AlertCondition = (s) => {
  const c = s.connection;
  if (c === null || c.okxPublic === 'connected') return null;
  return {
    id: 'okx-public',
    en: `OKX market data feed ${c.okxPublic}. Prices and order books are frozen.${oldestData(c, s.connectionAt)}`,
    zh: '与 OKX 的行情连接已断开，价格和盘口已停止更新',
  };
};

const okxCandlesDown: AlertCondition = (s) => {
  const c = s.connection;
  if (c === null || c.okxBusiness === 'connected') return null;
  return { id: 'okx-business', en: `OKX candle feed ${c.okxBusiness}. The chart is not updating.`, zh: 'K线连接已断开，图表已停止更新' };
};

function describeStream(key: string): string {
  const i = key.lastIndexOf(':');
  const stream = key.slice(i + 1);
  const label = stream === 'ticker' || stream === 'book' || stream === 'mark' ? STREAM_LABEL[stream] : stream;
  return `${key.slice(0, i)} ${label}`;
}

const staleStreams: AlertCondition = (s) => {
  const c = s.connection;
  // With the feed itself down every stream is listed; the feed alert already says so.
  if (c === null || c.okxPublic !== 'connected' || c.staleStreams.length === 0) return null;
  const named = c.staleStreams.slice(0, STREAMS_NAMED).map(describeStream).join(', ');
  const more = c.staleStreams.length > STREAMS_NAMED ? ` (+${c.staleStreams.length - STREAMS_NAMED} more)` : '';
  return {
    id: 'stale',
    en: `Market data stopped updating: ${named}${more}. Those values are frozen.${oldestData(c, s.connectionAt)}`,
    zh: '部分行情已停止更新，相关价格和盘口可能已过期',
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
    zh: 'OKX 账户推送已断开，持仓、委托和余额约每分钟才刷新一次',
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
      zh: `账户数据未更新${why.zh}。持仓、委托和余额尚未加载，空表不代表空仓`,
    };
  }
  if (now - a.lastSyncAt > ACCOUNT_STALE_MS) {
    return {
      id: 'account',
      en: `Account data is not updating since ${fmtTime(a.lastSyncAt)}${why.en} (${said}). Positions, orders and balance below are from that time.`,
      zh: `账户数据已停止更新${why.zh}。下方持仓、委托和余额不是最新数据`,
    };
  }
  // The data is still arriving one way or the other: say which half is missing instead of "not updating".
  if (c.okxPrivate === 'connected') {
    return {
      id: 'account',
      en: `The last account refresh failed${why.en} (${said}). Live updates from the account stream still arrive.`,
      zh: `账户定时刷新失败${why.zh}，实时推送仍在更新`,
    };
  }
  return {
    id: 'account',
    en: `Live account stream unavailable${why.en} (${said}). Positions, orders and balance refresh about once a minute.`,
    zh: `账户实时推送不可用${why.zh}。持仓、委托和余额约每分钟刷新一次`,
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
export function killSwitchSweepNotice(s: Pick<TerminalState, 'connection' | 'account'>): string {
  if (s.connection?.account.state === 'disabled') {
    return 'No API key is configured, so Pegasus cannot cancel anything: your open orders on OKX stay as they are.';
  }
  if (s.account === null) {
    return 'The account is not loaded, so Pegasus may not be able to cancel your open orders: check them on OKX and cancel them there.';
  }
  // The sweep is not attempted with a key that cannot trade.
  if (!s.account.canTrade) {
    return 'This API key is read-only, so Pegasus cannot cancel anything: your open orders on OKX stay as they are.';
  }
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
