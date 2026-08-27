import { createHash } from "node:crypto";

import type {
  AgentRuntime,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  ArtifactByteDriver,
  GitHubTransport,
  GitHubTransportRequest,
  GitHubTransportResponse,
  GitPublication,
  GitPublisher,
} from "../adapters/seams.ts";

export class FakeGitHubTransport implements GitHubTransport {
  readonly requests: GitHubTransportRequest[] = [];
  readonly #responses: GitHubTransportResponse[];

  constructor(responses: readonly GitHubTransportResponse[] = []) {
    this.#responses = [...responses];
  }

  async request(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("fake GitHub response not configured");
    return response;
  }
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly requests: AgentRuntimeRequest[] = [];
  readonly #result: AgentRuntimeResult;

  constructor(
    result: AgentRuntimeResult = {
      result: { data: {}, outcome: "completed", outputArtifactDigests: [], summary: "ok" },
      status: "succeeded",
    },
  ) {
    this.#result = result;
  }

  async execute(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    this.requests.push(request);
    return this.#result;
  }
}

export class FakeGitPublisher implements GitPublisher {
  readonly publications: GitPublication[] = [];

  async publish(publication: GitPublication): Promise<{ readonly revision: string }> {
    this.publications.push(publication);
    const identity = [
      publication.repository,
      publication.branch,
      publication.baseRevision,
      publication.treeDigest,
      publication.commitMessage,
    ].join("\0");
    return { revision: createHash("sha256").update(identity, "utf8").digest("hex") };
  }
}

export class MemoryArtifactByteDriver implements ArtifactByteDriver {
  readonly materialized = new Map<string, Uint8Array>();
  readonly #bytes = new Map<string, Uint8Array>();

  async get(digest: string): Promise<Uint8Array | null> {
    const bytes = this.#bytes.get(digest);
    return bytes === undefined ? null : bytes.slice();
  }

  async materialize(digest: string, destination: string): Promise<void> {
    const bytes = this.#bytes.get(digest);
    if (bytes === undefined) throw new Error(`artifact_not_found: ${digest}`);
    this.materialized.set(destination, bytes.slice());
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== digest)
      throw new Error(`digest_mismatch: expected ${digest}, received ${actual}`);
    const existing = this.#bytes.get(digest);
    if (existing !== undefined && !existing.every((byte, index) => byte === bytes[index])) {
      throw new Error(`immutable_artifact_conflict: ${digest}`);
    }
    this.#bytes.set(digest, bytes.slice());
  }
}
