import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Instrument, SetLeverageRequest, TdMode } from '@pegasus/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/http';
import { useStore } from '../../store/store';

interface Props {
  inst: Instrument;
  tdMode: TdMode;
  posSide: 'long' | 'short';
  longShort: boolean;
}

export function LeverageControl({ inst, tdMode, posSide, longShort }: Props) {
  const pushToast = useStore((s) => s.pushToast);
  const riskMax = useStore((s) => s.riskConfig?.maxLeverage ?? null);
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');

  const queryKey = ['leverage', inst.instId, tdMode] as const;
  const current = useQuery({
    queryKey,
    queryFn: () => api.leverage(inst.instId, tdMode),
    staleTime: 60_000,
  });

  const active = current.data?.find((l) => l.posSide === posSide) ?? current.data?.[0];
  const activeLever = active?.lever;
  useEffect(() => {
    if (activeLever !== undefined) setValue(activeLever);
  }, [activeLever]);

  const set = useMutation({
    mutationFn: (body: SetLeverageRequest) => api.setLeverage(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      pushToast('success', `Leverage set to ${data[0]?.lever ?? value}x on ${inst.instId}`);
    },
    onError: (e) => pushToast('error', errorMessage(e)),
  });

  const submit = () => {
    const lever = value.trim();
    if (!/^\d+(\.\d+)?$/.test(lever)) {
      pushToast('error', 'Leverage must be a positive number');
      return;
    }
    const body: SetLeverageRequest = longShort
      ? { instId: inst.instId, lever, mgnMode: tdMode, posSide }
      : { instId: inst.instId, lever, mgnMode: tdMode };
    set.mutate(body);
  };

  const hint = `max ${inst.maxLever}x exchange${riskMax === null ? '' : `, ${riskMax}x risk`}`;
  return (
    <div className="field">
      <label>
        Leverage <span className="dim">({hint})</span>
      </label>
      <div className="input-group">
        <input
          className="num"
          inputMode="decimal"
          value={value}
          placeholder={current.isLoading ? '…' : '1'}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn" onClick={submit} disabled={set.isPending || value.trim() === ''}>
          Set
        </button>
      </div>
    </div>
  );
}
