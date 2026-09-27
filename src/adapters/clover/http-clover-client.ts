import {
  CloverClient,
  CloverItem,
  CloverListOptions,
  CloverMerchantContext,
  CloverTokens,
} from '../../core/ports/clover.js';

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.current++;
  }

  release(): void {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}

export interface HttpCloverClientOptions {
  appId: string;
  appSecret: string;
  env?: 'sandbox' | 'production';
  publicBaseUrl?: string;
}

export class HttpCloverClient implements CloverClient {
  public readonly appId: string;
  public readonly appSecret: string;
  public readonly env: 'sandbox' | 'production';
  public readonly authorizeHost: string;
  public readonly apiHost: string;
  public readonly publicBaseUrl: string;

  public readonly limits = {
    merchantConcurrency: 4,
    appConcurrency: 8,
  };
  public readonly maxAttempts = 8;

  private appSemaphore = new Semaphore(8);
  private merchantSemaphores = new Map<string, Semaphore>();

  constructor(options: HttpCloverClientOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.env = options.env || (process.env.CLOVER_ENV === 'production' ? 'production' : 'sandbox');
    this.publicBaseUrl = options.publicBaseUrl || process.env.PUBLIC_BASE_URL || '';

    if (this.env === 'production') {
      this.authorizeHost = 'https://www.clover.com';
      this.apiHost = 'https://api.clover.com';
    } else {
      this.authorizeHost = 'https://sandbox.dev.clover.com';
      this.apiHost = 'https://apisandbox.dev.clover.com';
    }
  }

  private getMerchantSemaphore(merchantId: string): Semaphore {
    if (!this.merchantSemaphores.has(merchantId)) {
      this.merchantSemaphores.set(merchantId, new Semaphore(4));
    }
    return this.merchantSemaphores.get(merchantId)!;
  }

  getAuthorizeUrl(state: string): string {
    const redirectUri = `${this.publicBaseUrl}/oauth/callback`;
    return `${this.authorizeHost}/oauth/v2/authorize?client_id=${this.appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  }

  buildHeaders(accessToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'VectaWhat / 0.1 (Berkeley DeepMind Hackathon)',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return headers;
  }

  computeBackoffMs(attempt: number, responseHeaders: Record<string, string | undefined>): number {
    const retryAfter = responseHeaders['retry-after'];
    if (retryAfter) {
      const sec = parseFloat(retryAfter);
      if (!isNaN(sec) && sec > 0) {
        return Math.max(1000, Math.ceil(sec * 1000));
      }
    }
    // 1s * 2^attempt + random(0-1s)
    const exp = 1000 * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * 1000);
    return Math.max(1000, exp + jitter);
  }

  async fetchWithRetry(
    merchantId: string,
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const merchantSem = this.getMerchantSemaphore(merchantId);

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      await this.appSemaphore.acquire();
      await merchantSem.acquire();

      try {
        const res = await fetch(url, options);

        if (res.status === 401 || res.status === 403) {
          const err: any = new Error(`Clover Auth Failure HTTP ${res.status}`);
          err.status = res.status;
          err.fatal = true;
          // Check for recovery header
          const recoveryHdr = res.headers.get('x-clover-recovery-available');
          if (recoveryHdr === 'true') {
            err.headers = { 'x-clover-recovery-available': 'true' };
          }
          throw err;
        }

        if (res.status === 429 || res.status >= 500) {
          const rateLimitHdrs: string[] = [];
          res.headers.forEach((val, key) => {
            if (key.toLowerCase().startsWith('x-ratelimit-')) {
              rateLimitHdrs.push(`${key}=${val}`);
            }
          });
          if (rateLimitHdrs.length > 0) {
            console.warn(`[metric] clover_429 HTTP ${res.status} [${rateLimitHdrs.join(', ')}]`);
          }

          if (attempt === this.maxAttempts - 1) {
            const err: any = new Error(`Clover request failed after ${this.maxAttempts} attempts with status ${res.status}`);
            err.status = res.status;
            throw err;
          }

          const hdrs: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            hdrs[k.toLowerCase()] = v;
          });
          const backoff = this.computeBackoffMs(attempt, hdrs);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        return res;
      } catch (err: any) {
        if (err.fatal) throw err;
        if (attempt === this.maxAttempts - 1) throw err;
        const backoff = this.computeBackoffMs(attempt, {});
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        merchantSem.release();
        this.appSemaphore.release();
      }
    }

    throw new Error('Clover request exhausted retry attempts');
  }

  async exchangeCode(code: string): Promise<CloverTokens> {
    const url = `${this.apiHost}/oauth/v2/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        client_id: this.appId,
        client_secret: this.appSecret,
        code,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const err: any = new Error(`Failed to exchange code: HTTP ${res.status} ${body}`);
      err.status = res.status;
      throw err;
    }

    return (await res.json()) as CloverTokens;
  }

  async refreshToken(refreshToken: string): Promise<CloverTokens> {
    const url = `${this.apiHost}/oauth/v2/refresh`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        client_id: this.appId,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const err: any = new Error(`Failed to refresh token: HTTP ${res.status}`);
      err.status = res.status;
      if (res.headers.get('x-clover-recovery-available') === 'true') {
        err.headers = { 'x-clover-recovery-available': 'true' };
      }
      throw err;
    }

    return (await res.json()) as CloverTokens;
  }

  async recoverToken(recoveryToken: string): Promise<CloverTokens> {
    const url = `${this.apiHost}/oauth/v2/recovery`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        client_id: this.appId,
        client_secret: this.appSecret,
        recovery_token: recoveryToken,
      }),
    });

    if (!res.ok) {
      const err: any = new Error(`Failed to recover token: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return (await res.json()) as CloverTokens;
  }

  async getMerchant(merchantId: string, accessToken?: string): Promise<CloverMerchantContext> {
    const url = `${this.apiHost}/v3/merchants/${merchantId}?expand=address`;
    const res = await this.fetchWithRetry(merchantId, url, {
      method: 'GET',
      headers: this.buildHeaders(accessToken),
    });

    const data = await res.json();
    return {
      id: data.id || merchantId,
      name: data.name || 'Clover Merchant',
      address: data.address
        ? {
            city: data.address.city,
            state: data.address.state,
            country: data.address.country,
          }
        : undefined,
    };
  }

  async listItems(
    merchantId: string,
    options: CloverListOptions = {},
    accessToken?: string
  ): Promise<{ elements: CloverItem[]; total?: number }> {
    const limit = options.limit ?? 1000;
    const offset = options.offset ?? 0;
    let url = `${this.apiHost}/v3/merchants/${merchantId}/items?expand=categories,tags,itemStock&limit=${limit}&offset=${offset}`;

    if (options.modifiedSince) {
      url += `&filter=modifiedTime>=${options.modifiedSince}`;
    }

    const res = await this.fetchWithRetry(merchantId, url, {
      method: 'GET',
      headers: this.buildHeaders(accessToken),
    });

    const data = await res.json();
    return {
      elements: data.elements || [],
      total: data.total,
    };
  }

  async getItem(merchantId: string, itemId: string, accessToken?: string): Promise<CloverItem> {
    const url = `${this.apiHost}/v3/merchants/${merchantId}/items/${itemId}?expand=categories,tags,itemStock`;
    const res = await this.fetchWithRetry(merchantId, url, {
      method: 'GET',
      headers: this.buildHeaders(accessToken),
    });

    if (res.status === 404) {
      const err: any = new Error(`Item ${itemId} not found`);
      err.status = 404;
      throw err;
    }

    return (await res.json()) as CloverItem;
  }
}
