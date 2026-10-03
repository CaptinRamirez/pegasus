import { useState } from 'react';
import { useStore } from '../store/store';
import { FillsTable } from './FillsTable';
import { OrdersTable } from './OrdersTable';
import { Panel } from './Panel';
import { PositionsTable } from './PositionsTable';
import { SignalsPanel } from './SignalsPanel';

type Tab = 'positions' | 'orders' | 'history' | 'fills' | 'signals';

export function BottomTabs() {
  const [tab, setTab] = useState<Tab>('positions');
  const positions = useStore((s) => s.positions.length);
  const orders = useStore((s) => Object.keys(s.orders).length);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'positions', label: 'Positions', count: positions },
    { id: 'orders', label: 'Open orders', count: orders },
    { id: 'history', label: 'History' },
    { id: 'fills', label: 'Fills' },
    { id: 'signals', label: 'Signals' },
  ];

  const title = (
    <span className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="count">{t.count}</span>}
        </button>
      ))}
    </span>
  );

  return (
    <Panel title={title} className="panel-bottom">
      {tab === 'positions' && <PositionsTable />}
      {tab === 'orders' && <OrdersTable mode="open" />}
      {tab === 'history' && <OrdersTable mode="history" />}
      {tab === 'fills' && <FillsTable />}
      {tab === 'signals' && <SignalsPanel />}
    </Panel>
  );
}
