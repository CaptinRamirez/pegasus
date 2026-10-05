import { useCampaignSeed } from './hooks/useCampaign';
import { useHistorySeed, useSession } from './hooks/useSession';
import { useStore } from './store/store';
import { AccountPanel } from './components/AccountPanel';
import { BottomTabs } from './components/BottomTabs';
import { Chart } from './components/Chart';
import { Header } from './components/Header';
import { InstrumentList } from './components/InstrumentList';
import { OrderBook } from './components/OrderBook';
import { OrderTicket } from './components/OrderTicket';
import { RiskPanel } from './components/RiskPanel';
import { StatusBanner } from './components/StatusBanner';
import { Toasts } from './components/Toasts';
import { TokenGate } from './components/TokenGate';
import { Trades } from './components/Trades';

function Terminal() {
  useHistorySeed();
  useCampaignSeed();
  return (
    <div className="app">
      <Header />
      <StatusBanner />
      <div className="main">
        <div className="col col-left">
          <InstrumentList />
          <OrderBook />
          <Trades />
        </div>
        <div className="col col-center">
          <Chart />
          <BottomTabs />
        </div>
        <div className="col col-right">
          <OrderTicket />
          <AccountPanel />
          <RiskPanel />
        </div>
      </div>
      <Toasts />
    </div>
  );
}

export function App() {
  const token = useStore((s) => s.token);
  useSession(token);
  return token === null ? <TokenGate /> : <Terminal />;
}
