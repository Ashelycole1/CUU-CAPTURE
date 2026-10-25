import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore } from './types';

/** Dev/test driver: files under `${DATA_DIR}/blobs`. Never used on Vercel. */
export class LocalDiskStore implements BlobStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..') || key.startsWith('/')) {
      throw new Error(`Invalid blob key: ${key}`);
    }
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`Invalid blob key: ${key}`);
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<{ key: string }> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
    return { key };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.resolve(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}
