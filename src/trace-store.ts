import type { TraceStore, ExecutionTrace } from "./types.js";

/**
 * In-memory trace store. For development and testing.
 */
export class InMemoryTraceStore implements TraceStore {
  private traces: ExecutionTrace[] = [];
  private byId = new Map<string, ExecutionTrace>();
  private byIdempotencyKey = new Map<string, ExecutionTrace>();
  private maxSize: number;

  private cloneTrace(trace: ExecutionTrace): ExecutionTrace {
    return {
      ...trace,
      provider: trace.provider ? { ...trace.provider } : undefined,
      events: trace.events.map((event) => ({
        ...event,
        metadata: event.metadata ? { ...event.metadata } : undefined,
      })),
    };
  }

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  async save(trace: ExecutionTrace): Promise<void> {
    const existing = this.byId.get(trace.traceId);
    if (existing) {
      const index = this.traces.findIndex((item) => item.traceId === trace.traceId);
      if (index >= 0) {
        this.traces[index] = trace;
      }
      this.byId.set(trace.traceId, trace);
      this.byIdempotencyKey.set(trace.idempotencyKey, trace);
      if (existing.idempotencyKey !== trace.idempotencyKey) {
        this.byIdempotencyKey.delete(existing.idempotencyKey);
      }
      return;
    }

    // Evict oldest if at capacity
    if (this.traces.length >= this.maxSize) {
      const oldest = this.traces.shift();
      if (oldest) {
        this.byId.delete(oldest.traceId);
        this.byIdempotencyKey.delete(oldest.idempotencyKey);
      }
    }
    this.traces.push(trace);
    this.byId.set(trace.traceId, trace);
    this.byIdempotencyKey.set(trace.idempotencyKey, trace);
  }

  async get(traceId: string): Promise<ExecutionTrace | null> {
    return this.byId.get(traceId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<ExecutionTrace | null> {
    return this.byIdempotencyKey.get(key) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<ExecutionTrace | null> {
    return this.getByIdempotencyKey(key);
  }

  async list(filter: {
    callerId?: string;
    toolName?: string;
    limit?: number;
  }): Promise<ExecutionTrace[]> {
    let results = [...this.traces];
    if (filter.callerId) {
      results = results.filter((t) => t.callerId === filter.callerId);
    }
    if (filter.toolName) {
      results = results.filter((t) => t.toolName === filter.toolName);
    }
    if (filter.limit && filter.limit > 0) {
      results = results.slice(-filter.limit);
    }
    return results;
  }

  async toJSON(filter?: {
    callerId?: string;
    toolName?: string;
    limit?: number;
  }): Promise<ExecutionTrace[]> {
    const traces = await this.list(filter ?? {});
    return traces.map((trace) => this.cloneTrace(trace));
  }

  /** Get total trace count (for testing) */
  get count(): number {
    return this.traces.length;
  }
}
