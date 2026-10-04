import { useState, type FormEvent } from 'react';
import { errorText, useT } from '../i18n';
import { api } from '../lib/api';
import { useStore } from '../store/store';
import { LangSwitch } from './LangSwitch';

export function TokenGate() {
  const t = useT();
  const setToken = useStore((s) => s.setToken);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      await api.instruments(token);
      setToken(token);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card form" onSubmit={(e) => void submit(e)}>
        <div className="row">
          <h1 className="grow">PEGASUS</h1>
          <LangSwitch />
        </div>
        <p>{t.gate.prompt}</p>
        <div className="field">
          <label htmlFor="token">{t.gate.tokenLabel}</label>
          <input
            id="token"
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
        </div>
        {error !== null && <div className="notice notice-danger">{errorText(error, t)}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || value.trim() === ''}>
          {busy ? t.gate.checking : t.gate.signIn}
        </button>
      </form>
    </div>
  );
}
