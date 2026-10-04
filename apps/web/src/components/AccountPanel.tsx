import { Panel } from './Panel';
import { fmtNum, fmtSigned, fmtTime, signOf } from '../lib/format';
import { accountAsOf, accountUnknown, type AccountUnknown } from '../store/alerts';
import { useStore } from '../store/store';

const UNKNOWN_TEXT: Record<Exclude<AccountUnknown, 'disabled'>, string> = {
  waiting: 'Waiting for server…',
  loading: 'Loading account…',
  failed: 'Account not loaded (see the warning above)',
  unloaded: 'Account not loaded',
};

export function AccountPanel() {
  const balance = useStore((s) => s.balance);
  const account = useStore((s) => s.account);
  // Re-sent by the server every 5 s, which also keeps the "as of" label current.
  const connection = useStore((s) => s.connection);
  const unknown = useStore(accountUnknown);
  const asOf = accountAsOf(connection, Date.now());

  if (unknown === 'disabled') {
    return (
      <Panel title="Account" pad>
        <div className="empty">
          No API key configured: only market data is shown
          <br />
          未配置 API key，仅显示行情
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Account" extra={asOf === null ? null : <span className="stale-tag">as of {fmtTime(asOf)}</span>} pad>
      <div className="kv-list">
        <span className="k">Total equity</span>
        <span className="v num">{balance === null ? '–' : `${fmtNum(balance.totalEq)} USD`}</span>
        <span className="k">Position mode</span>
        <span className="v">{account?.posMode ?? '–'}</span>
        <span className="k">Account level</span>
        <span className="v">{account?.acctLv ?? '–'}</span>
      </div>
      {balance !== null && balance.details.length > 0 && (
        <table className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Ccy</th>
              <th>Equity</th>
              <th>Avail</th>
              <th>Cash</th>
              <th>UPL</th>
            </tr>
          </thead>
          <tbody>
            {balance.details.map((d) => (
              <tr key={d.ccy} className="num">
                <td className="left">{d.ccy}</td>
                <td>{fmtNum(d.eq, 4)}</td>
                <td>{fmtNum(d.availEq, 4)}</td>
                <td>{fmtNum(d.cashBal, 4)}</td>
                <td className={signOf(d.upl)}>{fmtSigned(d.upl, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {balance === null && <div className="empty">{unknown === null ? 'No balance yet' : UNKNOWN_TEXT[unknown]}</div>}
    </Panel>
  );
}
