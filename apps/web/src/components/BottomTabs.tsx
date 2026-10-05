import { useEffect, useState } from 'react';
import type { CampaignServiceStatus } from '@pegasus/shared';
import { useT } from '../i18n';
import { readBottomHeight, writeBottomHeight } from '../lib/bottomHeight';
import type { BottomSize } from '../lib/bottomHeight';
import { useStore } from '../store/store';
import { CampaignPanel } from './CampaignPanel';
import { FillsTable } from './FillsTable';
import { OrdersTable } from './OrdersTable';
import { Panel } from './Panel';
import { PositionsTable } from './PositionsTable';
import { SignalsPanel } from './SignalsPanel';
import { Splitter } from './Splitter';
import { StopsTable } from './StopsTable';

export type Tab = 'campaign' | 'positions' | 'orders' | 'stops' | 'history' | 'fills' | 'signals';

/**
 * The tab the page opens on: the campaign's, unless the campaign is disabled; null while its status is not known yet.
 * The page does not remember a tab, so every load is a first visit.
 */
export function defaultTab(status: CampaignServiceStatus | null): Tab | null {
  if (status === null) return null;
  return status === 'disabled' ? 'positions' : 'campaign';
}

export function BottomTabs() {
  const t = useT();
  const campaignStatus = useStore((s) => s.campaign?.status ?? null);
  // A tab the trader picked stays; until then the default is decided once, from the first status the page hears,
  // and a later change of the status does not move the page.
  const [picked, setPicked] = useState<Tab | null>(null);
  const [initial, setInitial] = useState<Tab | null>(() => defaultTab(campaignStatus));
  useEffect(() => {
    if (initial === null) setInitial(defaultTab(campaignStatus));
  }, [initial, campaignStatus]);
  const tab: Tab = picked ?? initial ?? 'positions';
  const positions = useStore((s) => s.positions.length);
  const orders = useStore((s) => Object.keys(s.orders).length);
  const stops = useStore((s) => s.algoOrders?.orders.length ?? 0);
  // The height the divider above was dragged to, kept per size in localStorage; null is the stylesheet's height.
  const size: BottomSize = tab === 'campaign' ? 'tall' : 'normal';
  const [heights, setHeights] = useState<Record<BottomSize, number | null>>(() => ({
    normal: readBottomHeight('normal'),
    tall: readBottomHeight('tall'),
  }));
  const height = heights[size];
  const resize = (px: number | null) => {
    writeBottomHeight(size, px);
    setHeights((h) => ({ ...h, [size]: px }));
  };

  const tabs: { id: Tab; label: string; count?: number; title?: string }[] = [
    { id: 'campaign', label: t.tabs.campaign },
    { id: 'positions', label: t.tabs.positions, count: positions },
    { id: 'orders', label: t.tabs.orders, count: orders },
    { id: 'stops', label: t.tabs.stops, count: stops },
    { id: 'history', label: t.tabs.history },
    { id: 'fills', label: t.tabs.fills },
    { id: 'signals', label: t.tabs.signals, title: t.tabs.signalsTitle },
  ];

  const title = (
    <span className="tabs">
      {tabs.map((item) => (
        <button key={item.id} className={`tab${tab === item.id ? ' active' : ''}`} title={item.title} onClick={() => setPicked(item.id)}>
          {item.label}
          {item.count !== undefined && item.count > 0 && <span className="count">{item.count}</span>}
        </button>
      ))}
    </span>
  );

  return (
    <>
      <Splitter title={t.layout.resizeBottom} onResize={resize} onReset={() => resize(null)} />
      <Panel
        title={title}
        className={`panel-bottom${tab === 'campaign' ? ' panel-bottom-tall' : ''}`}
        {...(height !== null ? { style: { flex: `0 0 ${height}px` } } : {})}
      >
        {tab === 'campaign' && <CampaignPanel />}
        {tab === 'positions' && <PositionsTable />}
        {tab === 'orders' && <OrdersTable mode="open" />}
        {tab === 'stops' && <StopsTable />}
        {tab === 'history' && <OrdersTable mode="history" />}
        {tab === 'fills' && <FillsTable />}
        {tab === 'signals' && <SignalsPanel />}
      </Panel>
    </>
  );
}
