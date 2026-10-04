import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountSnapshot, OkxPosMode, OrderStoreSnapshot } from '@pegasus/mock-okx/engine';
import type { FundingState } from './funding.js';

/** Everything the paper account is, kept in one JSON file so that it survives the program being closed. */
export interface PaperState {
  version: 1;
  /** When the account was created, epoch ms */
  createdAt: number;
  /** The balance the account was created with, USDT */
  initialBalance: string;
  posMode: OkxPosMode;
  /** Until when each instrument's prices were watched; what lies between this and the next start is replayed */
  lastSeen: Record<string, number>;
  account: AccountSnapshot;
  orders: OrderStoreSnapshot;
  funding: FundingState;
}

/**
 * Reads the saved account; null when there is none yet. A file that is there but cannot be read as a paper
 * account is an error: starting a fresh account over it would silently drop the positions it holds.
 */
export function loadState(file: string): PaperState | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`the paper account file ${file} cannot be read (${(err as Error).message}); restore ${file}.bak over it, or delete it to start a new account`);
  }
  const s = parsed as Partial<PaperState> | null;
  if (typeof s !== 'object' || s === null || s.version !== 1 || typeof s.account !== 'object' || typeof s.orders !== 'object' || typeof s.funding !== 'object' || typeof s.lastSeen !== 'object') {
    throw new Error(`the paper account file ${file} is not a version 1 paper account; restore ${file}.bak over it, or delete it to start a new account`);
  }
  return s as PaperState;
}

/** Keeps the file as it was read at start-up next to it (`.bak`): one step back if a session goes wrong. */
export function backupState(file: string): void {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
}

export function saveState(file: string, state: PaperState): void {
  // Synchronous, so two writes can never interleave; through a temporary file, so a crash mid-write never leaves half a file.
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, file);
}
