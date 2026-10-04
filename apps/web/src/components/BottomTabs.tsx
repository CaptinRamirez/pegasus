import { useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store/store';
import { FillsTable } from './FillsTable';
import { OrdersTable } from './OrdersTable';
import { Panel } from './Panel';
import { PositionsTable } from './PositionsTable';
import { SignalsPanel } from './SignalsPanel';
import { StopsTable } from './StopsTable';

type Tab = 'positions' | 'orders' | 'stops' | 'history' | 'fills' | 'signals';

export function BottomTabs() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('positions');
  const positions = useStore((s) => s.positions.length);
  const orders = useStore((s) => Object.keys(s.orders).length);
  const stops = useStore((s) => s.algoOrders?.orders.length ?? 0);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'positions', label: t.tabs.positions, count: positions },
    { id: 'orders', label: t.tabs.orders, count: orders },
    { id: 'stops', label: t.tabs.stops, count: stops },
    { id: 'history', label: t.tabs.history },
    { id: 'fills', label: t.tabs.fills },
    { id: 'signals', label: t.tabs.signals },
  ];

  const title = (
    <span className="tabs">
      {tabs.map((item) => (
        <button key={item.id} className={`tab${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>
          {item.label}
          {item.count !== undefined && item.count > 0 && <span className="count">{item.count}</span>}
        </button>
      ))}
    </span>
  );

  return (
    <Panel title={title} className="panel-bottom">
      {tab === 'positions' && <PositionsTable />}
      {tab === 'orders' && <OrdersTable mode="open" />}
      {tab === 'stops' && <StopsTable />}
      {tab === 'history' && <OrdersTable mode="history" />}
      {tab === 'fills' && <FillsTable />}
      {tab === 'signals' && <SignalsPanel />}
    </Panel>
  );
}
