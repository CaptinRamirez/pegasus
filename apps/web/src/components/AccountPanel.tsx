import { Panel } from './Panel';
import { fmtNum, fmtSigned, signOf } from '../lib/format';
import { useStore } from '../store/store';

export function AccountPanel() {
  const balance = useStore((s) => s.balance);
  const account = useStore((s) => s.account);

  return (
    <Panel title="Account" pad>
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
      {balance === null && <div className="empty">No balance yet</div>}
    </Panel>
  );
}
