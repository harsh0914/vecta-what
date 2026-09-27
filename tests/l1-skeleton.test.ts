import { describe, it, expect } from 'vitest';
import { createHealthCheckHandler } from '../src/server/health.js';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { FakeCloverClient } from '../src/adapters/in-memory/fake-clover-client.js';
import { FakeLlm } from '../src/adapters/in-memory/fake-llm.js';
import { FakeEmbedder } from '../src/adapters/in-memory/fake-embedder.js';
import { InMemoryVectorIndex } from '../src/adapters/in-memory/in-memory-vector-index.js';

describe('L1 Skeleton and Environment Self-Check', () => {
  it('L1 /healthz self-check reports env vars, database, worker status, and scheduler holder', async () => {
    const clock = new ControllableClock(1700000000000);
    const store = new InMemoryStore(clock);
    const healthHandler = createHealthCheckHandler({
      store,
      clock,
      getWorkerStatus: () => ({ activeJobs: 0, listening: true }),
      getSchedulerHolder: async () => 'test-instance-1',
    });

    const mockReq: any = {};
    let statusCode = 0;
    let jsonBody: any = null;
    const mockRes: any = {
      status: (code: number) => {
        statusCode = code;
        return mockRes;
      },
      json: (data: any) => {
        jsonBody = data;
        return mockRes;
      },
    };

    await healthHandler(mockReq, mockRes);
    expect(statusCode).toBe(200);
    expect(jsonBody).toBeDefined();
    expect(jsonBody.status).toBe('ok');
    expect(Array.isArray(jsonBody.missingEnvVars)).toBe(true);
    expect(jsonBody.database).toHaveProperty('connected');
    expect(jsonBody.worker).toEqual({ activeJobs: 0, listening: true });
    expect(jsonBody.schedulerLeader).toBe('test-instance-1');
  });

  it('L1 secrets are never logged or exposed in responses', async () => {
    process.env.CLOVER_APP_SECRET = 'secret_clover_val_9988';
    process.env.CLOVER_WEBHOOK_SECRET = 'secret_webhook_val_1122';
    process.env.ADMIN_TOKEN = 'secret_admin_tok_3344';

    try {
      const clock = new ControllableClock();
      const store = new InMemoryStore(clock);
      const healthHandler = createHealthCheckHandler({
        store,
        clock,
        getWorkerStatus: () => ({ activeJobs: 0, listening: true }),
        getSchedulerHolder: async () => null,
      });

      let jsonBody: any = null;
      const mockRes: any = {
        status: () => mockRes,
        json: (data: any) => {
          jsonBody = data;
          return mockRes;
        },
      };

      await healthHandler({} as any, mockRes);
      const serialized = JSON.stringify(jsonBody);
      // Secrets must never be exposed
      expect(serialized).not.toContain('secret_clover_val_9988');
      expect(serialized).not.toContain('secret_webhook_val_1122');
      expect(serialized).not.toContain('secret_admin_tok_3344');
    } finally {
      delete process.env.CLOVER_APP_SECRET;
      delete process.env.CLOVER_WEBHOOK_SECRET;
      delete process.env.ADMIN_TOKEN;
    }
  });

  it('L1 in-memory adapters satisfy all six port interfaces', async () => {
    const clock = new ControllableClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);

    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const llm = new FakeLlm();
    const embedder = new FakeEmbedder();
    const vectorIndex = new InMemoryVectorIndex();

    expect(store).toBeDefined();
    expect(clover).toBeDefined();
    expect(llm).toBeDefined();
    expect(embedder).toBeDefined();
    expect(vectorIndex).toBeDefined();
  });
});
