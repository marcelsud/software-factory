#!/usr/bin/env node
import { createHash } from "node:crypto";

let frame = "";
for await (const chunk of process.stdin) frame += chunk;
const request = JSON.parse(frame);
const emptyDigest = createHash("sha256").update("").digest("hex");
const now = new Date().toISOString();
process.stdout.write(
  JSON.stringify({
    attemptId: request.attemptId,
    changedFiles: [],
    failure: {
      category: "adapter",
      message: "trusted OMP JSON/stdio bridge has no configured model invocation",
      retriable: false,
    },
    logs: {
      stderrBytes: 0,
      stderrDigest: emptyDigest,
      stderrTruncated: false,
      stdoutBytes: 0,
      stdoutDigest: emptyDigest,
    },
    resources: { cpuMs: 0, maxRssBytes: 0 },
    status: "failed",
    tests: [],
    timing: { durationMs: 0, finishedAt: now, startedAt: now },
  }),
);
