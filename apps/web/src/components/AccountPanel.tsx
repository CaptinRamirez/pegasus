import { Panel } from './Panel';
import { labelOf, useT, type Messages } from '../i18n';
import { fmtNum, fmtSigned, fmtTime, signOf } from '../lib/format';
import { accountAsOf, accountUnknown, type AccountUnknown } from '../store/alerts';
import { useStore } from '../store/store';

const unknownText = (t: Messages): Record<Exclude<AccountUnknown, 'disabled'>, string> => ({
  waiting: t.common.waitingServer,
  loading: t.account.loading,
  failed: t.account.failed,
  unloaded: t.common.accountNotLoaded,
});

export function AccountPanel() {
  const t = useT();
  const balance = useStore((s) => s.balance);
  const account = useStore((s) => s.account);
  // Re-sent by the server every 5 s, which also keeps the "as of" label current.
  const connection = useStore((s) => s.connection);
  const unknown = useStore(accountUnknown);
  const asOf = accountAsOf(connection, Date.now());

  if (unknown === 'disabled') {
    return (
      <Panel title={t.account.title} pad>
        <div className="empty">{t.account.noKey}</div>
      </Panel>
    );
  }

  return (
    <Panel title={t.account.title} extra={asOf === null ? null : <span className="stale-tag">{t.common.asOf(fmtTime(asOf))}</span>} pad>
      <div className="kv-list">
        <span className="k">{t.account.totalEquity}</span>
        <span className="v num">{balance === null ? '–' : `${fmtNum(balance.totalEq)} USD`}</span>
        <span className="k">{t.account.posMode}</span>
        <span className="v">{account === null ? '–' : labelOf(t.enums.posMode, account.posMode)}</span>
        <span className="k">{t.account.level}</span>
        <span className="v">{account?.acctLv ?? '–'}</span>
      </div>
      {balance !== null && balance.details.length > 0 && (
        <table className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>{t.account.ccy}</th>
              <th>{t.account.equity}</th>
              <th>{t.account.avail}</th>
              <th>{t.account.cash}</th>
              <th>{t.account.upl}</th>
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
      {balance === null && <div className="empty">{unknown === null ? t.account.noBalance : unknownText(t)[unknown]}</div>}
    </Panel>
  );
}
