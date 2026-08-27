import type { PinnedAgentProfile, StepResultDocument } from "../contracts/index.ts";

export interface GitHubTransportRequest {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
}

export interface GitHubTransportResponse {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface GitHubTransport {
  request(request: GitHubTransportRequest): Promise<GitHubTransportResponse>;
}

export interface AgentRuntimeRequest {
  readonly agentProfile: PinnedAgentProfile;
  readonly attemptId: string;
  readonly inputArtifactDigests: readonly string[];
  readonly skillDigests: Readonly<Record<string, string>>;
}

export interface AgentRuntimeResult {
  readonly result: StepResultDocument;
  readonly status: "succeeded" | "failed";
}

export interface AgentRuntime {
  execute(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
}

export interface GitPublication {
  readonly baseRevision: string;
  readonly branch: string;
  readonly commitMessage: string;
  readonly repository: string;
  readonly treeDigest: string;
}

export interface GitPublisher {
  publish(publication: GitPublication): Promise<{ readonly revision: string }>;
}

export interface ArtifactByteDriver {
  get(digest: string): Promise<Uint8Array | null>;
  materialize(digest: string, destination: string): Promise<void>;
  put(digest: string, bytes: Uint8Array): Promise<void>;
}
