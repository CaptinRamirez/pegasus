import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where downloaded history is kept between runs. Keys are file-name safe. */
export interface CacheStore {
  read<T>(key: string): T | null;
  write(key: string, value: unknown): void;
}

/** One JSON file per key in `dir`. A file that cannot be read counts as missing. */
export class FileCache implements CacheStore {
  constructor(private readonly dir: string) {}

  read<T>(key: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  write(key: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${key}.json`);
    // Written beside the file and moved over it: an interrupted run never leaves half a file.
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  }
}

/** For tests. */
export class MemoryCache implements CacheStore {
  readonly entries = new Map<string, string>();

  read<T>(key: string): T | null {
    const text = this.entries.get(key);
    return text === undefined ? null : (JSON.parse(text) as T);
  }

  write(key: string, value: unknown): void {
    this.entries.set(key, JSON.stringify(value));
  }
}
