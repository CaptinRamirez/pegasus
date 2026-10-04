import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Instrument, SetLeverageRequest, TdMode } from '@pegasus/shared';
import { errorText, useLang, useT } from '../../i18n';
import { api } from '../../lib/api';
import { getTradingBlock, useStore } from '../../store/store';

interface Props {
  inst: Instrument;
  tdMode: TdMode;
  posSide: 'long' | 'short';
  longShort: boolean;
}

export function LeverageControl({ inst, tdMode, posSide, longShort }: Props) {
  const t = useT();
  const lang = useLang();
  const pushToast = useStore((s) => s.pushToast);
  const riskMax = useStore((s) => s.riskConfig?.maxLeverage ?? null);
  const tradingBlock = useStore(getTradingBlock);
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
  const failed = current.isError;
  // The box always shows this instrument's own leverage: never a number typed for, or fetched for, another one.
  useEffect(() => {
    setValue(failed ? '' : (activeLever ?? ''));
  }, [inst.instId, tdMode, posSide, activeLever, failed]);

  const set = useMutation({
    mutationFn: (body: SetLeverageRequest) => api.setLeverage(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      pushToast('success', t.leverage.set(data[0]?.lever ?? value, inst.instId));
    },
    onError: (e) => pushToast('error', errorText(e, t)),
  });

  const submit = () => {
    const lever = value.trim();
    if (!/^\d+(\.\d+)?$/.test(lever)) {
      pushToast('error', t.leverage.invalid);
      return;
    }
    const body: SetLeverageRequest = longShort
      ? { instId: inst.instId, lever, mgnMode: tdMode, posSide }
      : { instId: inst.instId, lever, mgnMode: tdMode };
    set.mutate(body);
  };

  return (
    <div className="field">
      <label>
        {t.leverage.label} <span className="dim">({t.leverage.hint(inst.maxLever, riskMax)})</span>
        {failed && <span className="neg"> {t.leverage.unavailable}</span>}
      </label>
      <div className="input-group">
        <input
          className="num"
          inputMode="decimal"
          value={value}
          placeholder={current.isLoading ? '…' : failed ? t.leverage.unavailable : '1'}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="btn"
          onClick={submit}
          disabled={set.isPending || value.trim() === '' || tradingBlock !== null}
          {...(tradingBlock === null ? {} : { title: tradingBlock[lang] })}
        >
          {t.leverage.setButton}
        </button>
      </div>
    </div>
  );
}
