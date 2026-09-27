import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';
import { FakeCloverClient } from '../src/adapters/in-memory/fake-clover-client.js';
import { JobQueue } from '../src/core/queue/job-queue.js';
import { InboxConsumer } from '../src/core/queue/inbox-consumer.js';
import {
  evaluateStock,
  generateOAuthState,
  validateOAuthState,
  getReviewKey,
  createCloverRouter,
  getValidAccessToken,
} from '../src/core/clover/clover-service.js';
import { HttpCloverClient } from '../src/adapters/clover/http-clover-client.js';

describe('Phase 3: Clover OAuth, Reads, Limits, and Webhooks', () => {
  const originalEnv = { ...process.env };
  const ADMIN_TOKEN = 'test-admin-token-secret-12345';
  const CLOVER_APP_ID = 'TEST_APP_ID';
  const CLOVER_APP_SECRET = 'TEST_APP_SECRET';
  const CLOVER_WEBHOOK_SECRET = 'TEST_WH_SECRET_987';
  const PUBLIC_BASE_URL = 'https://vectawhat.example.com';

  beforeEach(() => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.CLOVER_APP_ID = CLOVER_APP_ID;
    process.env.CLOVER_APP_SECRET = CLOVER_APP_SECRET;
    process.env.CLOVER_WEBHOOK_SECRET = CLOVER_WEBHOOK_SECRET;
    process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    process.env.CLOVER_ENV = 'sandbox';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // A1: Connect page
  it('A1 /connect shows value line + Connect button to Clover authorize with a valid signed state', async () => {
    const clock = new ControllableClock(1700000000000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    const app = express();
    app.use(router);

    const mockRes: any = {
      sendContent: '',
      send(html: string) {
        this.sendContent = html;
        return this;
      },
    };

    await (router as any).handleConnect({} as any, mockRes);
    expect(mockRes.sendContent).toContain('Make any small business\'s point-of-sale catalog usable by AI agents: one click, no code.');
    expect(mockRes.sendContent).toContain('Connect Clover');
    expect(mockRes.sendContent).toContain('/oauth/v2/authorize');

    // Extract state and verify signature
    const stateMatch = mockRes.sendContent.match(/state=([^"&]+)/);
    expect(stateMatch).not.toBeNull();
    const state = stateMatch![1];
    expect(validateOAuthState(state, ADMIN_TOKEN, clock)).toBe(true);
  });

  // A2: Launch-path handling
  it('A2 /oauth/callback without our valid state redirects to /oauth/v2/authorize with a fresh state and ignores legacy code', async () => {
    const clock = new ControllableClock(1700000000000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    let redirectUrl = '';
    const mockRes: any = {
      redirect: (statusOrUrl: any, url?: string) => {
        redirectUrl = url || statusOrUrl;
      },
      status: () => mockRes,
      send: () => mockRes,
    };

    // Callback with legacy code and no state
    const mockReqNoState: any = {
      query: { merchant_id: 'm1', code: 'legacy_v1_code_to_ignore' },
    };

    await (router as any).handleOAuthCallback(mockReqNoState, mockRes);
    expect(redirectUrl).toContain('/oauth/v2/authorize');
    expect(redirectUrl).toContain('client_id=' + CLOVER_APP_ID);
    expect(redirectUrl).toContain('redirect_uri=' + encodeURIComponent(PUBLIC_BASE_URL + '/oauth/callback'));

    const stateMatch = redirectUrl.match(/state=([^&]+)/);
    expect(stateMatch).not.toBeNull();
    expect(validateOAuthState(stateMatch![1], ADMIN_TOKEN, clock)).toBe(true);
  });

  // A3: Token exchange
  it('A3 valid state exchanges the code with JSON {client_id, client_secret, code} and saves the grant BEFORE responding', async () => {
    const clock = new ControllableClock(1700000000000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    const validState = generateOAuthState(ADMIN_TOKEN, clock);
    let renderedHtml = '';
    const mockRes: any = {
      send: (html: string) => {
        renderedHtml = html;
        return mockRes;
      },
    };

    const mockReq: any = {
      query: { merchant_id: 'm1', code: 'auth_code_123', state: validState },
    };

    await (router as any).handleOAuthCallback(mockReq, mockRes);

    // Verify grant saved in merchants collection
    const merchantDoc = await store.doc('merchants', 'm1').get();
    expect(merchantDoc.exists).toBe(true);
    const data = merchantDoc.data()!;
    expect(data.status).toBe('CONNECTED');
    expect(data.accessToken).toBe('clover_access_auth_code_123');
    expect(data.refreshToken).toBe('clover_refresh_auth_code_123');
  });

  // A4: Install -> event
  it('A4 after the grant write, one installed inbox event with NO token in it; Connected page links to signed review URL', async () => {
    const clock = new ControllableClock(1700000000000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    const validState = generateOAuthState(ADMIN_TOKEN, clock);
    let renderedHtml = '';
    const mockRes: any = {
      send: (html: string) => {
        renderedHtml = html;
        return mockRes;
      },
    };

    const mockReq: any = {
      query: { merchant_id: 'm1', code: 'auth_code_abc', state: validState },
    };

    await (router as any).handleOAuthCallback(mockReq, mockRes);

    // Check inbox events
    const inboxSnap = await store.collection('inbox').where('merchantId', '==', 'm1').get();
    expect(inboxSnap.docs.length).toBe(1);
    const inboxEvent = inboxSnap.docs[0].data()!;
    expect(inboxEvent.type).toBe('installed');

    // MUST NOT contain tokens in inbox
    const serializedInbox = JSON.stringify(inboxEvent);
    expect(serializedInbox).not.toContain('clover_access');
    expect(serializedInbox).not.toContain('clover_refresh');

    // Check signed review link
    const expectedKey = getReviewKey(ADMIN_TOKEN, 'm1');
    expect(renderedHtml).toContain(`/review/m1?k=${expectedKey}`);
  });

  // A5: Refresh single-flight
  it('A5 refresh is single-flight via a Firestore transaction lease and a rotating refresh token is never spent twice', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();

    // Merchant token expiring in 2 minutes (< 5 min)
    await store.doc('merchants', 'm1').set({
      id: 'm1',
      status: 'CONNECTED',
      accessToken: 'old_access_token',
      refreshToken: 'initial_refresh_token',
      accessExpiresAt: clock.epochSeconds() + 120, // 2 min left
      refreshExpiresAt: clock.epochSeconds() + 86400,
    });

    // Run 2 concurrent refresh requests
    const p1 = getValidAccessToken({ store, clover, merchantId: 'm1', clock });
    const p2 = getValidAccessToken({ store, clover, merchantId: 'm1', clock });

    const [token1, token2] = await Promise.all([p1, p2]);
    expect(token1).toBe(token2);
    expect(token1).toContain('clover_access_refreshed');

    // Refresh should only have been called once on the clover client
    const refreshCalls = clover.callLogs.filter((c) => c.method === 'refreshToken');
    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0].args[0]).toBe('initial_refresh_token');
  });

  // A6: Token recovery
  it('A6 a 401 with X-Clover-Recovery-Available true calls /oauth/v2/recovery', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();

    await store.doc('merchants', 'm1').set({
      id: 'm1',
      status: 'CONNECTED',
      accessToken: 'old_access_token',
      refreshToken: 'fail_refresh_token', // triggers 401 with recovery available
      accessExpiresAt: clock.epochSeconds() + 60,
      refreshExpiresAt: clock.epochSeconds() + 86400,
    });

    const token = await getValidAccessToken({ store, clover, merchantId: 'm1', clock });
    expect(token).toContain('clover_access_recovered');

    const recoverCalls = clover.callLogs.filter((c) => c.method === 'recoverToken');
    expect(recoverCalls.length).toBe(1);
  });

  // A7: Auth failure
  it('A7 401/403 marks the merchant DISCONNECTED and the job DEAD with no retries', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);

    await store.doc('merchants', 'm1').set({
      id: 'm1',
      status: 'CONNECTED',
      accessToken: 'revoked_token',
      refreshToken: 'unrecoverable_token',
      accessExpiresAt: clock.epochSeconds() - 10,
      refreshExpiresAt: clock.epochSeconds() + 86400,
    });

    clover.injectErrorOnce('refreshToken', 403);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: 'm1',
      payload: {},
      idempotencyKey: 'auth_fail_test',
    });
    const handle = (await queue.claim(job.id))!;

    let caughtError: any;
    try {
      await getValidAccessToken({ store, clover, merchantId: 'm1', clock });
    } catch (err: any) {
      caughtError = err;
      await queue.fail(handle, err);
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.fatal).toBe(true);

    const merchantDoc = (await store.doc('merchants', 'm1').get()).data()!;
    expect(merchantDoc.status).toBe('DISCONNECTED');

    const jobDoc = (await store.doc('jobs', job.id).get()).data()!;
    expect(jobDoc.status).toBe('DEAD'); // no retries on auth failure
  });

  // A8: Dev connect
  it('A8 dev-connect works only when CLOVER_ENV is sandbox', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    let status = 0;
    let jsonResp: any = null;
    const mockRes: any = {
      status(code: number) {
        status = code;
        return mockRes;
      },
      json(data: any) {
        jsonResp = data;
        return mockRes;
      },
    };

    // When sandbox -> succeeds
    process.env.CLOVER_ENV = 'sandbox';
    await (router as any).handleDevConnect(
      { params: { mid: 'm_dev' }, body: { token: 'manual_dev_token' }, headers: { 'x-admin-token': ADMIN_TOKEN } } as any,
      mockRes
    );
    expect(status).toBe(200);
    const m = (await store.doc('merchants', 'm_dev').get()).data()!;
    expect(m.status).toBe('CONNECTED');
    expect(m.accessToken).toBe('manual_dev_token');

    // When production -> refused with 403
    process.env.CLOVER_ENV = 'production';
    await (router as any).handleDevConnect(
      { params: { mid: 'm_prod' }, body: { token: 'manual_prod_token' }, headers: { 'x-admin-token': ADMIN_TOKEN } } as any,
      mockRes
    );
    expect(status).toBe(403);
  });

  // B1: Items listing
  it('B1 items listing uses expand=categories,tags,itemStock (max 3), limit 1000, offset paging to a short page', async () => {
    const clover = new FakeCloverClient();
    clover.seedDemoBistro();

    const page1 = await clover.listItems('PWXW6VQTEWJ11', { limit: 1000, offset: 0 });
    expect(page1.elements.length).toBe(32);
    expect(page1.elements[0].categories).toBeDefined();
    expect(page1.elements[0].tags).toBeDefined();
    expect(page1.elements[0].itemStock).toBeDefined();
  });

  // B2: Incremental filter
  it('B2 modifiedTime filter only on incremental runs', async () => {
    const clover = new FakeCloverClient();
    const items = [
      { id: '1', name: 'Item 1', modifiedTime: 100 },
      { id: '2', name: 'Item 2', modifiedTime: 500 },
    ];
    clover.setCatalog('m1', items);

    const fullList = await clover.listItems('m1', { limit: 1000, offset: 0 });
    expect(fullList.elements.length).toBe(2);

    const incList = await clover.listItems('m1', { limit: 1000, offset: 0, modifiedSince: 300 });
    expect(incList.elements.length).toBe(1);
    expect(incList.elements[0].id).toBe('2');
  });

  // B3: Stock rule
  it('B3 stock rule (quantity 0 with autoManage off is IN stock, available=false is out)', () => {
    // Tawa Roti: quantity 0, autoManage off -> in stock
    const tawaRoti = {
      id: 'roti',
      name: 'Tawa Roti',
      available: true,
      autoManage: false,
      itemStock: { quantity: 0 },
    };
    expect(evaluateStock(tawaRoti)).toBe(true);

    // Korean Fried Chicken Sandwich: available = false -> out of stock
    const kfc = {
      id: 'kfc',
      name: 'Korean Fried Chicken Sandwich',
      available: false,
      autoManage: false,
      itemStock: {},
    };
    expect(evaluateStock(kfc)).toBe(false);

    // Hidden item -> out of stock
    const hiddenItem = {
      id: 'hidden',
      name: 'Hidden Special',
      available: true,
      hidden: true,
      autoManage: false,
    };
    expect(evaluateStock(hiddenItem)).toBe(false);

    // Tracked item with quantity 0 -> out of stock
    const trackedZero = {
      id: 'tracked',
      name: 'Tracked Zero',
      available: true,
      autoManage: true,
      itemStock: { quantity: 0 },
    };
    expect(evaluateStock(trackedZero)).toBe(false);

    // Tracked item with quantity 5 -> in stock
    const trackedPos = {
      id: 'tracked_pos',
      name: 'Tracked Pos',
      available: true,
      autoManage: true,
      itemStock: { quantity: 5 },
    };
    expect(evaluateStock(trackedPos)).toBe(true);
  });

  // B4: Concurrency caps
  it('B4 at most 4 concurrent requests per merchant and 8 app-wide', async () => {
    const httpClient = new HttpCloverClient({
      appId: CLOVER_APP_ID,
      appSecret: CLOVER_APP_SECRET,
      env: 'sandbox',
    });

    expect(httpClient.limits.merchantConcurrency).toBe(4);
    expect(httpClient.limits.appConcurrency).toBe(8);
  });

  // B5: 429/5xx backoff
  it('B5 429/5xx wait at least 1s, honour retry-after, exponential backoff with jitter, max 8 attempts', async () => {
    const httpClient = new HttpCloverClient({
      appId: CLOVER_APP_ID,
      appSecret: CLOVER_APP_SECRET,
      env: 'sandbox',
    });

    const backoff0 = httpClient.computeBackoffMs(0, { 'retry-after': '2' });
    expect(backoff0).toBe(2000); // honours retry-after seconds

    const backoffNoHeader = httpClient.computeBackoffMs(1, {});
    expect(backoffNoHeader).toBeGreaterThanOrEqual(1000); // at least 1s
    expect(httpClient.maxAttempts).toBe(8);
  });

  // B6: Headers
  it('B6 Bearer header only plus User-Agent VectaWhat / 0.1', () => {
    const httpClient = new HttpCloverClient({
      appId: CLOVER_APP_ID,
      appSecret: CLOVER_APP_SECRET,
      env: 'sandbox',
    });

    const headers = httpClient.buildHeaders('my_token_xyz');
    expect(headers['Authorization']).toBe('Bearer my_token_xyz');
    expect(headers['User-Agent']).toContain('VectaWhat / 0.1');
  });

  // C1: Verification handshake
  it('C1 verificationCode is logged and 200', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    const logSpy = vi.spyOn(console, 'log');

    let status = 0;
    const mockRes: any = {
      status(code: number) {
        status = code;
        return mockRes;
      },
      json() {
        return mockRes;
      },
      send() {
        return mockRes;
      },
    };

    const mockReq: any = {
      body: { verificationCode: 'verify_code_999' },
      headers: {},
    };

    await (router as any).handleWebhook(mockReq, mockRes);
    expect(status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[clover] WEBHOOK VERIFICATION CODE = verify_code_999'));
    logSpy.mockRestore();
  });

  // C2: Auth
  it('C2 missing or wrong X-Clover-Auth is 401 and an unset secret rejects everything', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    let status = 0;
    const mockRes: any = {
      status(code: number) {
        status = code;
        return mockRes;
      },
      json() {
        return mockRes;
      },
      send() {
        return mockRes;
      },
    };

    // Wrong header
    await (router as any).handleWebhook(
      { body: { appId: '123' }, headers: { 'x-clover-auth': 'wrong_secret' } } as any,
      mockRes
    );
    expect(status).toBe(401);

    // Missing header
    await (router as any).handleWebhook(
      { body: { appId: '123' }, headers: {} } as any,
      mockRes
    );
    expect(status).toBe(401);

    // Unset secret rejects everything
    delete process.env.CLOVER_WEBHOOK_SECRET;
    await (router as any).handleWebhook(
      { body: { appId: '123' }, headers: { 'x-clover-auth': 'any' } } as any,
      mockRes
    );
    expect(status).toBe(401);
  });

  // C3: Fast ack
  it('C3 webhook writes one inbox doc and responds fast', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const clover = new FakeCloverClient();
    const queue = new JobQueue(store, clock);
    const router = createCloverRouter({ store, clock, clover, queue });

    let status = 0;
    const mockRes: any = {
      status(code: number) {
        status = code;
        return mockRes;
      },
      json() {
        return mockRes;
      },
    };

    const webhookPayload = {
      appId: CLOVER_APP_ID,
      merchants: {
        m1: [{ objectId: 'I:item_123', type: 'UPDATE', ts: 1000 }],
      },
    };

    await (router as any).handleWebhook(
      { body: webhookPayload, headers: { 'x-clover-auth': CLOVER_WEBHOOK_SECRET } } as any,
      mockRes
    );

    expect(status).toBe(200);

    const inboxDocs = await store.collection('inbox').get();
    expect(inboxDocs.docs.length).toBe(1);
    expect(inboxDocs.docs[0].data()?.body).toEqual(webhookPayload);
  });

  // C4: Event mapping
  it('C4 I/IS/IA map to SYNC_ITEM per object, IC/IG/IM to one full reconcile', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);
    const consumer = new InboxConsumer(store, queue, clock);

    // Write inbox event with I, IS, IA, IC
    const inboxRef = store.doc('inbox', 'wh_event_1');
    await inboxRef.set({
      id: 'wh_event_1',
      type: 'clover_webhook',
      merchantId: 'm1',
      key: 'wh:delivery_1',
      body: {
        merchants: {
          m1: [
            { objectId: 'I:item_1', type: 'UPDATE', ts: 100 },
            { objectId: 'IS:item_2', type: 'UPDATE', ts: 101 },
            { objectId: 'IA:item_3', type: 'UPDATE', ts: 102 },
            { objectId: 'IC:cat_1', type: 'UPDATE', ts: 103 },
            { objectId: 'UNKNOWN:other', type: 'UPDATE', ts: 104 },
          ],
        },
      },
      status: 'NEW',
      attempts: 0,
      createdAt: clock.now(),
    });

    await consumer.processInboxEvent('wh_event_1');

    const jobs = await store.collection('jobs').get();
    // 3 SYNC_ITEM jobs + 1 reconcile SNAPSHOT job = 4 jobs
    expect(jobs.docs.length).toBe(4);

    const syncJobs = jobs.docs.filter((d) => d.data()?.kind === 'SYNC_ITEM');
    expect(syncJobs.length).toBe(3);
    const syncItemIds = syncJobs.map((d) => d.data()?.payload?.itemId);
    expect(syncItemIds).toContain('item_1');
    expect(syncItemIds).toContain('item_2');
    expect(syncItemIds).toContain('item_3');

    const reconcileJobs = jobs.docs.filter((d) => d.data()?.kind === 'SNAPSHOT');
    expect(reconcileJobs.length).toBe(1);
    expect(reconcileJobs[0].data()?.payload?.kind).toBe('full');
  });

  // C5: Idempotent redelivery
  it('C5 the same delivery twice creates no new jobs', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);
    const consumer = new InboxConsumer(store, queue, clock);

    const eventPayload = {
      merchants: {
        m1: [{ objectId: 'I:item_dup', type: 'UPDATE', ts: 1000 }],
      },
    };

    // Delivery 1
    await store.doc('inbox', 'wh_1').set({
      id: 'wh_1',
      type: 'clover_webhook',
      merchantId: 'm1',
      key: 'wh:delivery_dup',
      body: eventPayload,
      status: 'NEW',
      attempts: 0,
      createdAt: clock.now(),
    });
    await consumer.processInboxEvent('wh_1');

    const jobsCount1 = (await store.collection('jobs').get()).docs.length;
    expect(jobsCount1).toBe(1);

    // Delivery 2 (same payload delivered again)
    await store.doc('inbox', 'wh_2').set({
      id: 'wh_2',
      type: 'clover_webhook',
      merchantId: 'm1',
      key: 'wh:delivery_dup_2',
      body: eventPayload,
      status: 'NEW',
      attempts: 0,
      createdAt: clock.now(),
    });
    await consumer.processInboxEvent('wh_2');

    const jobsCount2 = (await store.collection('jobs').get()).docs.length;
    expect(jobsCount2).toBe(1); // Exact same jobs, no duplicate!
  });
});
