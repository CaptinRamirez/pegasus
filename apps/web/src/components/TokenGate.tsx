import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/http';
import { useStore } from '../store/store';

export function TokenGate() {
  const setToken = useStore((s) => s.setToken);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card form" onSubmit={(e) => void submit(e)}>
        <h1>PEGASUS</h1>
        <p>Enter the API token (API_TOKEN of the pegasus server).</p>
        <div className="field">
          <label htmlFor="token">API token</label>
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
        {error !== null && <div className="notice notice-danger">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || value.trim() === ''}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
