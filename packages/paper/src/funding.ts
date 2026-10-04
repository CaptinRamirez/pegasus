import { ZERO, d, type Dec, type Engine, type OkxMgnMode, type OkxPosSide, type OkxPosition } from '@pegasus/mock-okx/engine';

/** The size of a position from `ts` on, in contracts; negative for a short. */
export interface SizeChange {
  ts: number;
  pos: string;
}

export interface FundingEntry {
  instId: string;
  mgnMode: OkxMgnMode;
  posSide: OkxPosSide;
  /** The settlement time, epoch ms */
  fundingTime: number;
  rate: string;
  /** Contracts held at the settlement; negative for a short */
  pos: string;
  markPx: string;
  /** What the account received (positive) or paid (negative), USDT */
  amount: string;
}

/** The part of the paper account's saved state that belongs to funding. */
export interface FundingState {
  /** Last settlement time applied (or passed over without a position), by instrument */
  lastSettled: Record<string, number>;
  /** Size history of every position since the last settlement of its instrument, by `instId|mgnMode|posSide` */
  sizeLog: Record<string, SizeChange[]>;
  /** Settlements applied, oldest first, capped */
  ledger: FundingEntry[];
}

export interface FundingSource {
  /** Settlements with a funding time after `after` and not after `now`, oldest first, with the rate that was charged. */
  settlements(instId: string, after: number, now: number): Promise<Array<{ fundingTime: number; rate: string }>>;
  /** The mark price at `ts` (the open of the one-minute mark price bar that starts there); null when it cannot be read. */
  markAt(instId: string, ts: number): Promise<Dec | null>;
}

const MAX_LEDGER = 2_000;

export const emptyFundingState = (): FundingState => ({ lastSettled: {}, sizeLog: {}, ledger: [] });

const keyOf = (instId: string, mgnMode: string, posSide: string): string => `${instId}|${mgnMode}|${posSide}`;

/**
 * Charges funding the way the exchange does: at every settlement time, on the position held at that instant,
 * `contracts x contract value x mark price x rate`, paid by the long when the rate is positive. Positions are
 * followed through their size history, so a settlement that is applied late (the program was closed, or the
 * rate was published a minute after the hour) still uses the size and the mark price of its own time.
 */
export class FundingSettler {
  private running: Promise<number> | null = null;

  constructor(
    private readonly engine: Engine,
    readonly state: FundingState,
    private readonly source: FundingSource,
    private readonly log: (msg: string) => void,
  ) {}

  /** Records the sizes a positions push carries; pushes that only move the mark change nothing. */
  notePositions(positions: OkxPosition[]): void {
    for (const p of positions) {
      const signed = p.posSide === 'short' ? d(p.pos || '0').neg() : d(p.pos || '0');
      const key = keyOf(p.instId, p.mgnMode, p.posSide);
      const log = (this.state.sizeLog[key] ??= []);
      const last = log[log.length - 1];
      if (last ? d(last.pos).eq(signed) : signed.isZero()) continue;
      log.push({ ts: Number(p.uTime), pos: signed.toFixed() });
    }
  }

  /** Instruments that held a position at any time since their last settlement. */
  private instruments(): string[] {
    const out = new Set<string>();
    for (const [key, log] of Object.entries(this.state.sizeLog)) {
      if (log.some((c) => !d(c.pos).isZero())) out.add(key.slice(0, key.indexOf('|')));
    }
    return [...out];
  }

  /** Applies every settlement up to `now` that is still owed; resolves with how many payments were booked. */
  settle(now: number): Promise<number> {
    this.running ??= this.run(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(now: number): Promise<number> {
    let booked = 0;
    for (const instId of this.instruments()) {
      const inst = this.engine.instruments.get(instId);
      if (!inst) continue;
      // Nothing is owed before the oldest size still on record: a new position does not page through the
      // settlements of the months the instrument was not held.
      const after = Math.max(this.state.lastSettled[instId] ?? 0, this.oldestChange(instId) - 1);
      const due = await this.source.settlements(instId, after, now);
      for (const s of due) {
        const held = this.heldAt(instId, s.fundingTime);
        if (held.length > 0) {
          const markPx = await this.source.markAt(instId, s.fundingTime);
          if (markPx === null) {
            this.log(`funding of ${instId} at ${new Date(s.fundingTime).toISOString()} not settled yet: its mark price could not be read; it is tried again`);
            break;
          }
          for (const h of held) {
            const amount = h.pos.mul(d(inst.ctVal)).mul(markPx).mul(d(s.rate)).neg();
            this.engine.account.applyFunding(instId, h.mgnMode, h.posSide, amount);
            this.state.ledger.push({ instId, mgnMode: h.mgnMode, posSide: h.posSide, fundingTime: s.fundingTime, rate: s.rate, pos: h.pos.toFixed(), markPx: markPx.toFixed(), amount: amount.toFixed() });
            this.log(`funding ${instId} ${new Date(s.fundingTime).toISOString()}: rate ${s.rate}, ${h.pos.toFixed()} contracts at mark ${markPx.toFixed()} -> ${amount.toFixed(4)} USDT`);
            booked++;
          }
        }
        this.state.lastSettled[instId] = s.fundingTime;
        this.prune(instId, s.fundingTime);
      }
    }
    if (this.state.ledger.length > MAX_LEDGER) this.state.ledger.splice(0, this.state.ledger.length - MAX_LEDGER);
    if (booked > 0) this.engine.matcher.pushAccount();
    return booked;
  }

  private oldestChange(instId: string): number {
    let oldest = Infinity;
    for (const [key, log] of Object.entries(this.state.sizeLog)) {
      const first = log[0];
      if (key.startsWith(`${instId}|`) && first && first.ts < oldest) oldest = first.ts;
    }
    return oldest;
  }

  /** The positions of an instrument that were open at `ts`. */
  private heldAt(instId: string, ts: number): Array<{ mgnMode: OkxMgnMode; posSide: OkxPosSide; pos: Dec }> {
    const out: Array<{ mgnMode: OkxMgnMode; posSide: OkxPosSide; pos: Dec }> = [];
    for (const [key, log] of Object.entries(this.state.sizeLog)) {
      const [id, mgnMode, posSide] = key.split('|') as [string, OkxMgnMode, OkxPosSide];
      if (id !== instId) continue;
      let pos = ZERO;
      for (const c of log) {
        if (c.ts > ts) break;
        pos = d(c.pos);
      }
      if (!pos.isZero()) out.push({ mgnMode, posSide, pos });
    }
    return out;
  }

  /** Drops the size history a settled time no longer needs: everything before the size held at `ts`. */
  private prune(instId: string, ts: number): void {
    for (const [key, log] of Object.entries(this.state.sizeLog)) {
      if (!key.startsWith(`${instId}|`)) continue;
      let keepFrom = 0;
      for (let i = 0; i < log.length; i++) if ((log[i]?.ts ?? Infinity) <= ts) keepFrom = i;
      if (keepFrom > 0) log.splice(0, keepFrom);
      if (log.length === 1 && d(log[0]?.pos ?? '0').isZero()) delete this.state.sizeLog[key];
    }
  }
}
