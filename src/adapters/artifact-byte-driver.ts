import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { ArtifactByteDriver } from "./seams.ts";

const DIGEST = /^(?:sha256:)?([a-f0-9]{64})$/u;

function digestHex(digest: string): string {
  const match = DIGEST.exec(digest);
  if (match?.[1] === undefined) throw new Error(`invalid_digest: ${digest}`);
  return match[1];
}

function verify(digest: string, bytes: Uint8Array): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  const expected = digestHex(digest);
  if (actual !== expected)
    throw new Error(`digest_mismatch: expected sha256:${expected}, received ${actual}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class LocalArtifactByteDriver implements ArtifactByteDriver {
  readonly #root: string;
  #ready: Promise<string> | undefined;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async #storageRoot(): Promise<string> {
    this.#ready ??= (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      return await realpath(this.#root);
    })();
    return await this.#ready;
  }

  async #path(digest: string): Promise<string> {
    const hex = digestHex(digest);
    const root = await this.#storageRoot();
    const shard = resolve(root, hex.slice(0, 2));
    const path = resolve(shard, `${hex.slice(2)}.blob`);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("artifact_path_escape");
    try {
      const status = await lstat(shard);
      if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(shard)) !== shard)
        throw new Error("artifact_path_escape");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return path;
  }

  async get(digest: string): Promise<Uint8Array | null> {
    const path = await this.#path(digest);
    try {
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink())
        throw new Error(`artifact_corrupt: ${digest}`);
      const bytes = await readFile(path);
      try {
        verify(digest, bytes);
      } catch {
        throw new Error(`artifact_corrupt: ${digest}`);
      }
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    verify(digest, bytes);
    const path = await this.#path(digest);
    const existing = await this.get(digest);
    if (existing !== null) return;
    await atomicWrite(path, bytes);
    const stored = await this.get(digest);
    if (stored === null) throw new Error(`artifact_write_failed: ${digest}`);
  }

  async materialize(digest: string, destination: string): Promise<void> {
    const bytes = await this.get(digest);
    if (bytes === null) throw new Error(`artifact_not_found: ${digest}`);
    await atomicWrite(resolve(destination), bytes);
  }
}

export class MemoryArtifactByteDriver implements ArtifactByteDriver {
  readonly materialized = new Map<string, Uint8Array>();
  readonly #bytes = new Map<string, Uint8Array>();

  async get(digest: string): Promise<Uint8Array | null> {
    const bytes = this.#bytes.get(digestHex(digest));
    return bytes === undefined ? null : bytes.slice();
  }

  async materialize(digest: string, destination: string): Promise<void> {
    const bytes = await this.get(digest);
    if (bytes === null) throw new Error(`artifact_not_found: ${digest}`);
    this.materialized.set(destination, bytes);
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    verify(digest, bytes);
    const hex = digestHex(digest);
    const existing = this.#bytes.get(hex);
    if (existing !== undefined && !Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error(`immutable_artifact_conflict: ${digest}`);
    }
    this.#bytes.set(hex, bytes.slice());
  }
}
