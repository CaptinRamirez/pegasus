import { useEffect, useState } from 'react';
import { useLang } from '../i18n';
import { activeAlerts } from '../store/alerts';
import { useStore } from '../store/store';

/** Full-width warnings under the header whenever what the page shows is not live. */
export function StatusBanner() {
  const lang = useLang();
  const wsStatus = useStore((s) => s.wsStatus);
  const wsDownSince = useStore((s) => s.wsDownSince);
  const connection = useStore((s) => s.connection);
  const connectionAt = useStore((s) => s.connectionAt);
  const privateDownSince = useStore((s) => s.privateDownSince);
  // Only read while the socket is down, when it no longer changes with every message.
  const lastMessageAt = useStore((s) => (s.wsStatus === 'open' ? null : s.lastMessageAt));

  // The disconnect grace period ends without any store change, so the banner keeps its own clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const alerts = activeAlerts({ wsStatus, wsDownSince, lastMessageAt, connection, connectionAt, privateDownSince }, Math.max(now, Date.now()));
  return (
    <div className="banners">
      {alerts.map((a) => (
        <div key={a.id} className="banner" role="alert">
          {a[lang]}
        </div>
      ))}
    </div>
  );
}
