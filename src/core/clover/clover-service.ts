import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { Store } from '../ports/store.js';
import { Clock } from '../ports/clock.js';
import { CloverClient, CloverItem } from '../ports/clover.js';
import { JobQueue } from '../queue/job-queue.js';
import { Merchant } from '../types.js';

export function evaluateStock(item: Partial<CloverItem>): boolean {
  if (item.available === false) {
    return false;
  }
  if (item.hidden === true) {
    return false;
  }
  const qty = item.itemStock?.quantity;
  if (item.autoManage === true && qty != null && qty <= 0) {
    return false;
  }
  return true;
}

export function generateOAuthState(adminToken: string, clock: Clock): string {
  const issuedAt = clock.epochSeconds();
  const hmac = crypto.createHmac('sha256', adminToken).update(String(issuedAt)).digest('hex');
  return `${issuedAt}.${hmac}`;
}

export function validateOAuthState(state: string, adminToken: string, clock: Clock): boolean {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 2) return false;

  const [issuedAtStr, providedHmac] = parts;
  const issuedAt = parseInt(issuedAtStr, 10);
  if (isNaN(issuedAt)) return false;

  const now = clock.epochSeconds();
  // Valid for 15 minutes (900 seconds), allow 60s future drift
  if (now - issuedAt > 15 * 60 || issuedAt > now + 60) {
    return false;
  }

  const expectedHmac = crypto.createHmac('sha256', adminToken).update(issuedAtStr).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedHmac, 'hex'),
      Buffer.from(expectedHmac, 'hex')
    );
  } catch {
    return false;
  }
}

export function getReviewKey(adminToken: string, merchantId: string): string {
  return crypto.createHmac('sha256', adminToken).update(merchantId).digest('hex').substring(0, 24);
}

export function validateReviewKey(adminToken: string, merchantId: string, providedKey: string): boolean {
  if (!providedKey || typeof providedKey !== 'string') return false;
  const expectedKey = getReviewKey(adminToken, merchantId);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedKey, 'hex'),
      Buffer.from(expectedKey, 'hex')
    );
  } catch {
    return false;
  }
}

export interface GetValidAccessTokenOptions {
  store: Store;
  clover: CloverClient;
  merchantId: string;
  clock: Clock;
}

export async function getValidAccessToken(options: GetValidAccessTokenOptions): Promise<string> {
  const { store, clover, merchantId, clock } = options;
  const merchantRef = store.doc<Merchant>('merchants', merchantId);

  const initialSnap = await merchantRef.get();
  if (!initialSnap.exists || !initialSnap.data()) {
    const err: any = new Error(`Merchant ${merchantId} not found`);
    err.fatal = true;
    throw err;
  }

  const merchant = initialSnap.data()!;
  if (merchant.status !== 'CONNECTED') {
    const err: any = new Error(`Merchant ${merchantId} is disconnected: ${merchant.disconnectedReason || 'Auth required'}`);
    err.fatal = true;
    throw err;
  }

  const nowSec = clock.epochSeconds();
  // If access token valid for more than 5 minutes (300s), use it directly
  if (merchant.accessExpiresAt - nowSec > 300) {
    return merchant.accessToken;
  }

  // Needs refresh: Single-flight via Firestore transaction lease
  let leaseAcquired = false;
  let currentRefreshToken = merchant.refreshToken;
  let initialAccessToken = merchant.accessToken;

  while (!leaseAcquired) {
    let outcome: any;
    try {
      outcome = await store.runTransaction(async (tx) => {
        const snap = await tx.get(merchantRef);
        if (!snap.exists || !snap.data()) {
          throw new Error(`Merchant ${merchantId} not found`);
        }
        const current = snap.data()!;

        // If another worker already refreshed token while we waited
        if (current.accessExpiresAt - clock.epochSeconds() > 300) {
          return { alreadyRefreshed: true, token: current.accessToken };
        }

        // Check if lease is currently held by someone else
        if (current.refreshLeaseUntil && current.refreshLeaseUntil > clock.epochSeconds()) {
          return { leaseHeld: true };
        }

        // Only take lease if stored access token is still the one we read
        if (current.accessToken !== initialAccessToken) {
          initialAccessToken = current.accessToken;
          currentRefreshToken = current.refreshToken;
        }

        tx.update(merchantRef, {
          refreshLeaseUntil: clock.epochSeconds() + 30, // 30s lease
        });
        return { leaseAcquired: true, refreshToken: current.refreshToken };
      });
    } catch (txErr: any) {
      if (/transaction conflict|concurrent modification/i.test(txErr.message)) {
        await clock.sleep(500);
        continue;
      }
      throw txErr;
    }

    if (outcome.alreadyRefreshed) {
      return outcome.token!;
    }

    if (outcome.leaseHeld) {
      // Losers wait 500 ms and re-read
      await clock.sleep(500);
      continue;
    }

    if (outcome.leaseAcquired) {
      leaseAcquired = true;
      currentRefreshToken = outcome.refreshToken!;
      break;
    }
  }

  // We hold the lease, execute refresh call
  try {
    let newTokens: any;
    try {
      newTokens = await clover.refreshToken(currentRefreshToken);
    } catch (refreshErr: any) {
      // Check for recovery header (A6)
      const headers = refreshErr.headers || {};
      const recoveryAvailable = headers['x-clover-recovery-available'] === 'true' || refreshErr['x-clover-recovery-available'] === 'true';
      if (refreshErr.status === 401 && recoveryAvailable) {
        newTokens = await clover.recoverToken(currentRefreshToken);
      } else {
        throw refreshErr;
      }
    }

    // Write rotated tokens and release lease in transaction
    await store.runTransaction(async (tx) => {
      tx.update(merchantRef, {
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
        accessExpiresAt: newTokens.access_token_expiration,
        refreshExpiresAt: newTokens.refresh_token_expiration,
        refreshLeaseUntil: 0,
      });
    });

    return newTokens.access_token;
  } catch (err: any) {
    // If fatal 401/403, mark merchant DISCONNECTED
    if (err.status === 401 || err.status === 403) {
      await store.doc('merchants', merchantId).update({
        status: 'DISCONNECTED',
        disconnectedReason: `Auth failure: ${err.message}`,
        refreshLeaseUntil: 0,
      });
      err.fatal = true;
    } else {
      // Clear lease so it can be retried
      await store.doc('merchants', merchantId).update({
        refreshLeaseUntil: 0,
      });
    }
    throw err;
  }
}

export interface CloverRouterOptions {
  store: Store;
  clock: Clock;
  clover: CloverClient;
  queue: JobQueue;
}

export function createCloverRouter(options: CloverRouterOptions): Router {
  const router = Router();
  const { store, clock, clover, queue } = options;

  // Handler for A1: /connect
  const handleConnect = async (_req: Request, res: Response) => {
    const adminToken = process.env.ADMIN_TOKEN || '';
    const state = generateOAuthState(adminToken, clock);
    const authorizeUrl = clover.getAuthorizeUrl(state);

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Connect Clover · Vecta-what</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f7f7f5; margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
    .card { background: #fff; border: 1px solid #e4e4df; border-radius: 12px; max-width: 480px; width: 100%; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); text-align: center; }
    h1 { font-size: 24px; margin: 0 0 12px; color: #111; }
    p { color: #555; font-size: 15px; line-height: 1.5; margin: 0 0 24px; }
    .btn { display: inline-block; background: #1a7f37; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 16px; transition: background 0.2s; }
    .btn:hover { background: #15692d; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Vecta-what</h1>
    <p>Make any small business's point-of-sale catalog usable by AI agents: one click, no code.</p>
    <a class="btn" href="${authorizeUrl}">Connect Clover</a>
  </div>
</body>
</html>`;
    res.send(html);
  };

  // Handler for A2, A3, A4: /oauth/callback
  const handleOAuthCallback = async (req: Request, res: Response) => {
    const adminToken = process.env.ADMIN_TOKEN || '';
    const state = req.query.state as string;
    const code = req.query.code as string;
    const mid = (req.query.merchant_id || req.query.merchantId) as string;

    // A2: Missing or invalid state -> redirect to authorize with fresh state, ignore legacy code
    if (!state || !validateOAuthState(state, adminToken, clock)) {
      const freshState = generateOAuthState(adminToken, clock);
      const authorizeHost = process.env.CLOVER_ENV === 'production'
        ? 'https://www.clover.com'
        : 'https://sandbox.dev.clover.com';
      const clientId = process.env.CLOVER_APP_ID || '';
      const redirectUri = `${process.env.PUBLIC_BASE_URL || ''}/oauth/callback`;
      const target = `${authorizeHost}/oauth/v2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${freshState}`;
      return res.redirect(302, target);
    }

    if (!code || !mid) {
      return res.status(400).send('Missing code or merchant_id');
    }

    try {
      // A3: Token exchange
      const tokens = await clover.exchangeCode(code);
      const now = clock.now();

      // Write grant to merchants/{mid} synchronously BEFORE responding
      await store.doc('merchants', mid).set({
        id: mid,
        status: 'CONNECTED',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessExpiresAt: tokens.access_token_expiration,
        refreshExpiresAt: tokens.refresh_token_expiration,
        connectedAt: now,
      });

      // A4: Write exactly ONE installed inbox event with NO tokens
      const tokenSuffix = tokens.access_token.slice(-12);
      await store.doc('inbox', `install_${mid}_${now}`).set({
        id: `install_${mid}_${now}`,
        type: 'installed',
        merchantId: mid,
        key: `install:${mid}:${tokenSuffix}`,
        body: { merchantId: mid },
        status: 'NEW',
        attempts: 0,
        createdAt: now,
      });

      // Render Connected page with link to signed review URL
      const reviewKey = getReviewKey(adminToken, mid);
      const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';
      const reviewUrl = `${publicBaseUrl}/review/${mid}?k=${reviewKey}`;

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Connected · Vecta-what</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f7f7f5; margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
    .card { background: #fff; border: 1px solid #e4e4df; border-radius: 12px; max-width: 480px; width: 100%; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); text-align: center; }
    h1 { font-size: 24px; margin: 0 0 12px; color: #1a7f37; }
    p { color: #555; font-size: 15px; line-height: 1.5; margin: 0 0 24px; }
    .btn { display: inline-block; background: #1a7f37; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Clover Connected!</h1>
    <p>Your menu catalog snapshot is syncing. You can now review suggestions drafted by Gemini.</p>
    <a class="btn" href="${reviewUrl}">Review Your Menu</a>
  </div>
</body>
</html>`;
      res.send(html);
    } catch (err: any) {
      console.error('[clover] OAuth exchange error:', err);
      res.status(500).send(`OAuth token exchange failed: ${err.message}`);
    }
  };

  // Handler for C1, C2, C3: /webhooks/clover
  const handleWebhook = async (req: Request, res: Response) => {
    // C1: Verification code handshake
    if (req.body && req.body.verificationCode) {
      console.log(`[clover] WEBHOOK VERIFICATION CODE = ${req.body.verificationCode}`);
      return res.status(200).json({ status: 'ok' });
    }

    // C2: Auth check
    const webhookSecret = process.env.CLOVER_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(401).send('Webhook secret unset');
    }

    const authHeader = req.headers['x-clover-auth'] as string;
    if (!authHeader) {
      return res.status(401).send('Missing X-Clover-Auth header');
    }

    try {
      const match = crypto.timingSafeEqual(
        Buffer.from(authHeader),
        Buffer.from(webhookSecret)
      );
      if (!match) {
        return res.status(401).send('Invalid auth header');
      }
    } catch {
      return res.status(401).send('Invalid auth header');
    }

    // C3: Write ONE inbox doc and respond fast (< 1s)
    const merchants = req.body?.merchants || {};
    const merchantIds = Object.keys(merchants);
    const mid = merchantIds[0] || 'unknown';
    const now = clock.now();
    const docId = `wh_${now}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      await store.doc('inbox', docId).set({
        id: docId,
        type: 'clover_webhook',
        merchantId: mid,
        key: `wh:${now}:${docId}`,
        body: req.body,
        status: 'NEW',
        attempts: 0,
        createdAt: now,
      });

      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error('[clover] Webhook inbox write error:', err);
      return res.status(500).json({ error: 'Failed to write inbox event' });
    }
  };

  // Handler for A8: /admin/dev-connect/:mid
  const handleDevConnect = async (req: Request, res: Response) => {
    if (process.env.CLOVER_ENV !== 'sandbox') {
      return res.status(403).json({ error: 'dev-connect allowed only in sandbox environment' });
    }

    const adminToken = process.env.ADMIN_TOKEN;
    const authHeader = req.headers['x-admin-token'];
    if (!adminToken || authHeader !== adminToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const mid = req.params.mid;
    const token = req.body?.token;
    if (!token) {
      return res.status(400).json({ error: 'Missing token in body' });
    }

    const now = clock.now();
    await store.doc('merchants', mid).set({
      id: mid,
      status: 'CONNECTED',
      accessToken: token,
      refreshToken: token,
      accessExpiresAt: clock.epochSeconds() + 86400 * 365,
      refreshExpiresAt: clock.epochSeconds() + 86400 * 365,
      connectedAt: now,
    });

    await store.doc('inbox', `dev_install_${mid}_${now}`).set({
      id: `dev_install_${mid}_${now}`,
      type: 'installed',
      merchantId: mid,
      key: `install:${mid}:dev`,
      body: { merchantId: mid },
      status: 'NEW',
      attempts: 0,
      createdAt: now,
    });

    const reviewKey = getReviewKey(adminToken, mid);
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';
    const reviewUrl = `${publicBaseUrl}/review/${mid}?k=${reviewKey}`;

    return res.status(200).json({
      connected: true,
      merchantId: mid,
      reviewUrl,
    });
  };

  router.get('/connect', handleConnect);
  router.get('/oauth/callback', handleOAuthCallback);
  router.post('/webhooks/clover', handleWebhook);
  router.post('/admin/dev-connect/:mid', handleDevConnect);

  // Attach methods directly to router for testing convenience
  (router as any).handleConnect = handleConnect;
  (router as any).handleOAuthCallback = handleOAuthCallback;
  (router as any).handleWebhook = handleWebhook;
  (router as any).handleDevConnect = handleDevConnect;

  return router;
}
