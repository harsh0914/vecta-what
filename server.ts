import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createHealthCheckHandler } from './src/server/health.js';
import { ControllableClock } from './src/adapters/in-memory/controllable-clock.js';
import { InMemoryStore } from './src/adapters/in-memory/in-memory-store.js';
import { FirestoreStore } from './src/adapters/firestore/firestore-store.js';
import { Store } from './src/core/ports/store.js';
import { JobQueue } from './src/core/queue/job-queue.js';
import { JobRunner } from './src/core/queue/job-runner.js';
import { InboxConsumer } from './src/core/queue/inbox-consumer.js';
import { createCloverRouter } from './src/core/clover/clover-service.js';
import { HttpCloverClient } from './src/adapters/clover/http-clover-client.js';
import { FakeCloverClient } from './src/adapters/in-memory/fake-clover-client.js';
import { FakeLlm } from './src/adapters/in-memory/fake-llm.js';
import { FakeEmbedder } from './src/adapters/in-memory/fake-embedder.js';
import { InMemoryVectorIndex } from './src/adapters/in-memory/in-memory-vector-index.js';
import { CatalogPipeline } from './src/core/pipeline/catalog-pipeline.js';
import { PairingPipeline } from './src/core/pipeline/pairing-pipeline.js';
import { CloverClient } from './src/core/ports/clover.js';
import { Llm } from './src/core/ports/llm.js';
import { Embedder } from './src/core/ports/embedder.js';
import { GeminiLlm } from './src/adapters/gemini/gemini-llm.js';
import { GeminiEmbedder } from './src/adapters/gemini/gemini-embedder.js';
import { createReviewRouter, computeReviewKey } from './src/server/review-routes.js';
import { createAgentRouter } from './src/server/agent-routes.js';
import { createDiscoveryRouter, DEMO_BISTRO_MERCHANT_ID } from './src/server/discovery-routes.js';
import { createCompareRouter } from './src/server/compare-routes.js';
import { ItemDocument, MerchantDocument, RunDocument, JobDocument } from './src/core/types.js';

import { loadFirebaseConfig } from './src/adapters/firestore/firebase-config.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createServer() {
  const app = express();
  app.use(express.json());

  const clock = new ControllableClock();
  let store: Store;

  const firebaseConfig = process.env.NODE_ENV !== 'test'
    ? loadFirebaseConfig(path.resolve(__dirname, 'firebase-applet-config.json'))
    : null;

  let serverIdentity = 'unknown';
  if (process.env.NODE_ENV !== 'test') {
    try {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth();
      const creds = await auth.getCredentials();
      serverIdentity = creds.client_email || 'default';
      const runtimeProjectId = await auth.getProjectId();
      console.log(`[server] Running identity: ${serverIdentity} (runtime project: ${runtimeProjectId})`);
      console.log(`[server] Target Firestore: project=${firebaseConfig?.projectId}, database=${firebaseConfig?.firestoreDatabaseId}`);
    } catch (err) {
      console.warn('[server] Could not determine runtime GoogleAuth identity:', err);
    }
  }

  if (firebaseConfig) {
    try {
      store = new FirestoreStore({
        projectId: firebaseConfig.projectId,
        databaseId: firebaseConfig.firestoreDatabaseId,
      });
      console.log(`[server] Firestore connected to project: ${firebaseConfig.projectId}, database: ${firebaseConfig.firestoreDatabaseId}`);
    } catch (e) {
      console.warn('[server] Falling back to InMemoryStore:', e);
      store = new InMemoryStore(clock);
    }
  } else {
    store = new InMemoryStore(clock);
  }

  let clover: CloverClient;
  if (process.env.CLOVER_APP_ID && process.env.CLOVER_APP_SECRET) {
    clover = new HttpCloverClient({
      appId: process.env.CLOVER_APP_ID,
      appSecret: process.env.CLOVER_APP_SECRET,
      env: process.env.CLOVER_ENV === 'production' ? 'production' : 'sandbox',
    });
  } else {
    clover = new FakeCloverClient();
  }

  const queue = new JobQueue(store, clock);
  let llm: Llm;
  let embedder: Embedder;
  if (process.env.NODE_ENV !== 'test') {
    try {
      llm = new GeminiLlm();
      embedder = new GeminiEmbedder();
    } catch (e) {
      console.warn('[server] Falling back to FakeLlm/FakeEmbedder:', e);
      llm = new FakeLlm();
      embedder = new FakeEmbedder();
    }
  } else {
    llm = new FakeLlm();
    embedder = new FakeEmbedder();
  }
  const vectorIndex = new InMemoryVectorIndex();

  const pipeline = new CatalogPipeline({
    store,
    clover,
    llm,
    embedder,
    vectorIndex,
    queue,
    clock,
  });

  const pairingPipeline = new PairingPipeline({
    store,
    llm,
    clock,
  });

  const runner = new JobRunner({
    queue,
    store,
    clock,
    concurrency: 4,
    handlers: {
      SNAPSHOT: async (_payload, handle) => pipeline.runSnapshot(handle),
      SYNC_ITEM: async (_payload, handle) => pipeline.syncItem(handle),
      PAIR_MENU: async (_payload, handle) => pairingPipeline.runPairing(handle),
    },
  });
  const inboxConsumer = new InboxConsumer(store, queue, clock);

  if (process.env.NODE_ENV !== 'test') {
    runner.start();
    inboxConsumer.start();

    // Auto-seed Demo Bistro merchant and initial snapshot
    const demoMid = DEMO_BISTRO_MERCHANT_ID;
    store.doc<MerchantDocument>('merchants', demoMid).get().then(async (snap) => {
      if (!snap.exists) {
        await store.doc('merchants', demoMid).set({
          id: demoMid,
          name: 'Vecta Demo Bistro',
          status: 'CONNECTED',
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
      }
      const existingItems = await store.collection('items').where('merchantId', '==', demoMid).get();
      if (existingItems.docs.length === 0) {
        await queue.enqueue({
          kind: 'SNAPSHOT',
          merchantId: demoMid,
          idempotencyKey: `snapshot:${demoMid}:initial`,
          payload: { kind: 'snapshot', merchantId: demoMid, force: true },
        });
      }
    }).catch((err) => {
      console.warn('[server] Demo Bistro auto-seed notice:', err);
    });
  }

  // Mount Discovery routes (/sites/bistro, /sites/spice, llms.txt, agent-card.json)
  app.use(createDiscoveryRouter(store));

  // Mount Public Agent API (/agents/:mid/search, /agents/:mid/pairings)
  app.use(createAgentRouter({ store, embedder, vectorIndex }));

  // Mount Merchant Review API (/api/review/:mid)
  app.use(createReviewRouter({ store, embedder, vectorIndex, queue }));

  // Mount General Assistant and Compare API (/api/assistant, /api/compare)
  app.use(createCompareRouter({ llm }));

  // Mount Clover OAuth, Webhooks, and Dev-Connect routes
  const cloverRouter = createCloverRouter({ store, clock, clover, queue });
  app.use(cloverRouter);

  // Health check endpoint
  app.get('/healthz', createHealthCheckHandler({
    store,
    clock,
    identity: serverIdentity,
    target: {
      projectId: firebaseConfig?.projectId,
      databaseId: firebaseConfig?.firestoreDatabaseId,
    },
    getWorkerStatus: () => ({
      activeJobs: runner.getActiveJobCount(),
      listening: runner.isListening(),
    }),
    getSchedulerHolder: async () => 'instance-dev',
  }));

  // Overview endpoint for admin & demo monitoring (SPEC §9.5)
  app.get('/api/overview', async (_req, res) => {
    try {
      const merchantsSnap = await store.collection<MerchantDocument>('merchants').get();
      const merchants = merchantsSnap.docs.map((d) => d.data()).filter(Boolean);

      const overviewList = await Promise.all(
        merchants.map(async (m) => {
          const mid = m.id;
          const itemsSnap = await store.collection<ItemDocument>('items').where('merchantId', '==', mid).get();
          const items = itemsSnap.docs.map((d) => d.data()).filter(Boolean);

          const stageCounts: Record<string, number> = { DISCOVERED: 0, ENRICHED: 0, INDEXED: 0, DELETED: 0, FAILED: 0 };
          const reviewCounts: Record<string, number> = { PENDING: 0, APPROVED: 0, EDITED: 0 };
          let itemsWithPairings = 0;

          for (const it of items) {
            stageCounts[it.stage] = (stageCounts[it.stage] || 0) + 1;
            reviewCounts[it.reviewStatus] = (reviewCounts[it.reviewStatus] || 0) + 1;
            if (it.pairingsApproved && it.pairingsApproved.length > 0) {
              itemsWithPairings++;
            }
          }

          const jobsSnap = await store.collection<JobDocument>('jobs').where('merchantId', '==', mid).get();
          const jobs = jobsSnap.docs.map((d) => d.data()).filter(Boolean);
          const jobCounts: Record<string, number> = { QUEUED: 0, CLAIMED: 0, RUNNING: 0, DONE: 0, RETRY: 0, DEAD: 0 };
          for (const j of jobs) {
            jobCounts[j.status] = (jobCounts[j.status] || 0) + 1;
          }

          const runsSnap = await store.collection<RunDocument>('runs').where('merchantId', '==', mid).get();
          const runs = runsSnap.docs.map((d) => d.data()).filter(Boolean);
          runs.sort((a, b) => b.startedAt - a.startedAt);

          const reviewKey = computeReviewKey(mid);
          return {
            merchantId: mid,
            name: m.name,
            status: m.status,
            disconnectedReason: m.disconnectedReason,
            lastSyncedAt: m.lastSyncedAt,
            stageCounts,
            reviewCounts,
            itemsWithPairings,
            jobCounts,
            recentRuns: runs.slice(0, 5),
            reviewUrl: `/review/${mid}?k=${reviewKey}`,
            reviewKey,
          };
        })
      );

      res.json({ merchants: overviewList });
    } catch (err: any) {
      console.error('[server] /api/overview error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  return app;
}

const PORT = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV !== 'test') {
  createServer().then((app) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] Vecta-what listening on port ${PORT}`);
    });
  }).catch((err) => {
    console.error('[server] Failed to start server:', err);
    process.exit(1);
  });
}
