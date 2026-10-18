import { useEffect, useState } from 'react';
import type { CampaignServiceStatus } from '@pegasus/shared';
import { useTrader } from '../hooks/useTrader';
import { useT } from '../i18n';
import { readBottomHeight, writeBottomHeight } from '../lib/bottomHeight';
import type { BottomSize } from '../lib/bottomHeight';
import { useStore } from '../store/store';
import { useUi, type Tab } from '../store/ui';
import { CampaignPanel } from './CampaignPanel';
import { FillsTable } from './FillsTable';
import { JournalPanel } from './JournalPanel';
import { OrdersTable } from './OrdersTable';
import { Panel } from './Panel';
import { PositionsTable } from './PositionsTable';
import { SignalsPanel } from './SignalsPanel';
import { Splitter } from './Splitter';
import { StopsTable } from './StopsTable';
import { TraderPanel } from './TraderPanel';

export type { Tab };

/**
 * The tab the page opens on: the campaign's on the campaign stack (the campaign is not disabled), the trader's on
 * the trader stack, the signals otherwise; null while the campaign's status (or, with the campaign disabled, whether
 * the trader is enabled) is not known yet. The page does not remember a tab, so every load is a
 * first visit.
 */
export function defaultTab(status: CampaignServiceStatus | null, traderEnabled: boolean | null): Tab | null {
  if (status === null) return null;
  if (status !== 'disabled') return 'campaign';
  if (traderEnabled === null) return null;
  return traderEnabled ? 'trader' : 'signals';
}

/** Tabs that are pages of their own: the bottom panel opens taller for them. */
const TALL: readonly Tab[] = ['campaign', 'trader', 'signals', 'journal'];

export function BottomTabs() {
  const t = useT();
  const campaignStatus = useStore((s) => s.campaign?.status ?? null);
  const traderEnabled = useTrader().data?.enabled ?? null;
  // A tab the trader picked (or a link opened) stays; until then the default is decided once, from the first status
  // the page hears, and a later change of the status does not move the page.
  const picked = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const [initial, setInitial] = useState<Tab | null>(() => defaultTab(campaignStatus, traderEnabled));
  useEffect(() => {
    if (initial === null) setInitial(defaultTab(campaignStatus, traderEnabled));
  }, [initial, campaignStatus, traderEnabled]);
  const tab: Tab = picked ?? initial ?? 'signals';
  const positions = useStore((s) => s.positions.length);
  const orders = useStore((s) => Object.keys(s.orders).length);
  const stops = useStore((s) => s.algoOrders?.orders.length ?? 0);
  const openTrades = useStore((s) => Object.values(s.journal?.trades ?? {}).filter((x) => x.status === 'open').length);
  // The height the divider above was dragged to, kept per size in localStorage; null is the stylesheet's height.
  const size: BottomSize = TALL.includes(tab) ? 'tall' : 'normal';
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
    { id: 'trader', label: t.tabs.trader },
    { id: 'signals', label: t.tabs.signals, title: t.tabs.signalsTitle },
    { id: 'journal', label: t.tabs.journal, title: t.tabs.journalTitle, count: openTrades },
    { id: 'positions', label: t.tabs.positions, count: positions },
    { id: 'orders', label: t.tabs.orders, count: orders },
    { id: 'stops', label: t.tabs.stops, count: stops },
    { id: 'history', label: t.tabs.history },
    { id: 'fills', label: t.tabs.fills },
  ];

  const title = (
    <span className="tabs">
      {tabs.map((item) => (
        <button key={item.id} className={`tab${tab === item.id ? ' active' : ''}`} title={item.title} onClick={() => setTab(item.id)}>
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
        className={`panel-bottom${size === 'tall' ? ' panel-bottom-tall' : ''}`}
        {...(height !== null ? { style: { flex: `0 0 ${height}px` } } : {})}
      >
        {tab === 'campaign' && <CampaignPanel />}
        {tab === 'trader' && <TraderPanel />}
        {tab === 'signals' && <SignalsPanel />}
        {tab === 'journal' && <JournalPanel />}
        {tab === 'positions' && <PositionsTable />}
        {tab === 'orders' && <OrdersTable mode="open" />}
        {tab === 'stops' && <StopsTable />}
        {tab === 'history' && <OrdersTable mode="history" />}
        {tab === 'fills' && <FillsTable />}
      </Panel>
    </>
  );
}
