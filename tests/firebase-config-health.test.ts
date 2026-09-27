import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadFirebaseConfig } from '../src/adapters/firestore/firebase-config.js';
import { createHealthCheckHandler } from '../src/server/health.js';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';

describe('Firebase Config Loader & Health Check', () => {
  const testConfigPath = path.resolve(process.cwd(), 'tests/test-firebase-config.json');

  beforeEach(() => {
    if (fs.existsSync(testConfigPath)) {
      fs.unlinkSync(testConfigPath);
    }
  });

  it('loads projectId and firestoreDatabaseId from config file correctly', () => {
    const validConfig = {
      projectId: 'test-project-12345',
      firestoreDatabaseId: 'test-db-id',
      apiKey: 'test-api-key',
    };
    fs.writeFileSync(testConfigPath, JSON.stringify(validConfig));

    const loaded = loadFirebaseConfig(testConfigPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.projectId).toBe('test-project-12345');
    expect(loaded?.firestoreDatabaseId).toBe('test-db-id');

    fs.unlinkSync(testConfigPath);
  });

  it('returns null if config file does not exist', () => {
    const loaded = loadFirebaseConfig('/tmp/non-existent-config.json');
    expect(loaded).toBeNull();
  });

  it('throws an error if config is missing projectId or databaseId', () => {
    fs.writeFileSync(testConfigPath, JSON.stringify({ apiKey: 'missing-ids' }));
    expect(() => loadFirebaseConfig(testConfigPath)).toThrow(/missing required projectId or firestoreDatabaseId/i);
    fs.unlinkSync(testConfigPath);
  });

  it('/healthz performs a real Firestore round trip and returns 200 when store is healthy', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const handler = createHealthCheckHandler({
      store,
      clock,
      getWorkerStatus: () => ({ activeJobs: 0, listening: true }),
    });

    let statusCode = 0;
    let jsonResult: any = null;
    const res: any = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: any) {
        jsonResult = data;
        return res;
      },
    };

    await handler({} as any, res);

    expect(statusCode).toBe(200);
    expect(jsonResult.status).toBe('ok');
    expect(jsonResult.database.connected).toBe(true);
  });

  it('/healthz returns 503 with error code when Firestore round trip fails', async () => {
    const clock = new ControllableClock(1000);
    const failingStore: any = {
      doc: () => ({
        get: async () => {
          const err: any = new Error('7 PERMISSION_DENIED: Cloud Firestore API has not been used');
          err.code = 7;
          throw err;
        },
      }),
    };

    const handler = createHealthCheckHandler({
      store: failingStore,
      clock,
      getWorkerStatus: () => ({ activeJobs: 0, listening: true }),
    });

    let statusCode = 0;
    let jsonResult: any = null;
    const res: any = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: any) {
        jsonResult = data;
        return res;
      },
    };

    await handler({} as any, res);

    expect(statusCode).toBe(503);
    expect(jsonResult.status).toBe('UNHEALTHY');
    expect(jsonResult.database.connected).toBe(false);
    expect(jsonResult.database.code).toBe(7);
    expect(jsonResult.error).toContain('PERMISSION_DENIED');
  });
});
