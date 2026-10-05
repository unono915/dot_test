import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Machine facts recorded next to every measurement (the spec's reference PC is 4 CPU / 8 GB / SSD). */
export function machine() {
  return {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.versions.node,
  };
}

export async function timed<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - start), value };
}

export function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** Writes a measurement record under test-results/perf (git-ignored evidence). */
export function record(name: string, data: unknown): void {
  const dir = path.resolve('test-results', 'perf');
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ name, measuredAt: new Date().toISOString(), machine: machine(), data }, null, 2);
  writeFileSync(path.join(dir, `${name}.json`), body);
  console.log(body);
}
