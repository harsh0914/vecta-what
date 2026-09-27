import {
  CloverClient,
  CloverItem,
  CloverListOptions,
  CloverMerchantContext,
  CloverTokens,
} from '../../core/ports/clover.js';

export class FakeCloverClient implements CloverClient {
  private catalogs = new Map<string, CloverItem[]>();
  private merchants = new Map<string, CloverMerchantContext>();
  private injectedErrors = new Map<string, { statusCode: number; count: number }>();
  public callLogs: Array<{ method: string; args: any[] }> = [];

  constructor() {
    this.seedDemoBistro();
  }

  injectErrorOnce(method: string, statusCode: number): void {
    this.injectedErrors.set(method, { statusCode, count: 1 });
  }

  private checkInjectedError(method: string): void {
    const errorConfig = this.injectedErrors.get(method);
    if (errorConfig && errorConfig.count > 0) {
      errorConfig.count--;
      if (errorConfig.count === 0) {
        this.injectedErrors.delete(method);
      }
      const err: any = new Error(`Clover API Error ${errorConfig.statusCode}`);
      err.status = errorConfig.statusCode;
      throw err;
    }
  }

  getAuthorizeUrl(state: string): string {
    return `https://sandbox.dev.clover.com/oauth/v2/authorize?client_id=TEST_CLIENT_ID&redirect_uri=https://example.com/oauth/callback&state=${state}`;
  }

  async exchangeCode(code: string): Promise<CloverTokens> {
    this.callLogs.push({ method: 'exchangeCode', args: [code] });
    this.checkInjectedError('exchangeCode');
    if (code === 'invalid_code') {
      const err: any = new Error('Invalid code');
      err.status = 400;
      throw err;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      access_token: `clover_access_${code}`,
      access_token_expiration: nowSec + 3600,
      refresh_token: `clover_refresh_${code}`,
      refresh_token_expiration: nowSec + 86400 * 30,
    };
  }

  async refreshToken(refreshToken: string): Promise<CloverTokens> {
    this.callLogs.push({ method: 'refreshToken', args: [refreshToken] });
    this.checkInjectedError('refreshToken');
    if (refreshToken.includes('fail_refresh')) {
      const err: any = new Error('Unauthorized');
      err.status = 401;
      err.headers = { 'x-clover-recovery-available': 'true' };
      throw err;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      access_token: `clover_access_refreshed_${Date.now()}`,
      access_token_expiration: nowSec + 3600,
      refresh_token: `clover_refresh_rotated_${Date.now()}`,
      refresh_token_expiration: nowSec + 86400 * 30,
    };
  }

  async recoverToken(refreshToken: string): Promise<CloverTokens> {
    this.callLogs.push({ method: 'recoverToken', args: [refreshToken] });
    this.checkInjectedError('recoverToken');
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      access_token: `clover_access_recovered_${Date.now()}`,
      access_token_expiration: nowSec + 3600,
      refresh_token: `clover_refresh_recovered_${Date.now()}`,
      refresh_token_expiration: nowSec + 86400 * 30,
    };
  }

  async getMerchant(merchantId: string, accessToken?: string): Promise<CloverMerchantContext> {
    this.callLogs.push({ method: 'getMerchant', args: [merchantId, accessToken] });
    this.checkInjectedError('getMerchant');
    const m = this.merchants.get(merchantId);
    if (!m) {
      return {
        id: merchantId,
        name: 'Demo Merchant',
        address: { city: 'Berkeley', state: 'CA', country: 'US' },
      };
    }
    return m;
  }

  async listItems(
    merchantId: string,
    options?: CloverListOptions,
    accessToken?: string
  ): Promise<{ elements: CloverItem[]; total?: number }> {
    this.callLogs.push({ method: 'listItems', args: [merchantId, options, accessToken] });
    this.checkInjectedError('listItems');

    const all = this.catalogs.get(merchantId) ?? [];
    let filtered = all;

    if (options?.modifiedSince) {
      filtered = filtered.filter((i) => (i.modifiedTime ?? 0) >= options.modifiedSince!);
    }

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 1000;
    const page = filtered.slice(offset, offset + limit);

    return {
      elements: JSON.parse(JSON.stringify(page)),
      total: filtered.length,
    };
  }

  async getItem(merchantId: string, itemId: string, accessToken?: string): Promise<CloverItem> {
    this.callLogs.push({ method: 'getItem', args: [merchantId, itemId, accessToken] });
    this.checkInjectedError('getItem');

    const all = this.catalogs.get(merchantId) ?? [];
    const item = all.find((i) => i.id === itemId);
    if (!item || item.deleted) {
      const err: any = new Error(`Item ${itemId} not found`);
      err.status = 404;
      throw err;
    }
    return JSON.parse(JSON.stringify(item));
  }

  setCatalog(merchantId: string, items: CloverItem[]): void {
    this.catalogs.set(merchantId, items);
  }

  updateItem(merchantId: string, itemId: string, patch: Partial<CloverItem>): void {
    const all = this.catalogs.get(merchantId) ?? [];
    const item = all.find((i) => i.id === itemId);
    if (item) {
      Object.assign(item, patch);
    }
  }

  seedDemoBistro(): void {
    const mid = 'PWXW6VQTEWJ11';
    this.merchants.set(mid, {
      id: mid,
      name: 'Vecta Demo Bistro',
      address: { city: 'Berkeley', state: 'CA', country: 'US' },
    });

    const demoItems: CloverItem[] = [
      { id: 'item_1', name: 'Samosa Chaat', price: 950, categories: { elements: [{ id: 'c1', name: 'Small Plates' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: { quantity: 40 }, available: true, autoManage: true },
      { id: 'item_2', name: 'Chicken 65', price: 1250, categories: { elements: [{ id: 'c1', name: 'Small Plates' }] }, tags: { elements: [{ id: 't2', name: 'Spicy' }] }, itemStock: { quantity: 30 }, available: true, autoManage: true },
      { id: 'item_3', name: 'Truffle Fries', price: 900, categories: { elements: [{ id: 'c1', name: 'Small Plates' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_4', name: 'Crispy Calamari', price: 1400, categories: { elements: [{ id: 'c1', name: 'Small Plates' }] }, tags: { elements: [] }, itemStock: { quantity: 20 }, available: true, autoManage: true },
      { id: 'item_5', name: 'Burrata & Heirloom Tomato', price: 1600, categories: { elements: [{ id: 'c1', name: 'Small Plates' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }, { id: 't3', name: 'GF' }] }, itemStock: { quantity: 12 }, available: true, autoManage: true },
      { id: 'item_6', name: 'Tom Kha Soup', price: 1100, categories: { elements: [{ id: 'c2', name: 'Soups & Salads' }] }, tags: { elements: [{ id: 't3', name: 'GF' }] }, itemStock: { quantity: 25 }, available: true, autoManage: true },
      { id: 'item_7', name: 'Kale Caesar', price: 1300, categories: { elements: [{ id: 'c2', name: 'Soups & Salads' }] }, tags: { elements: [] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_8', name: 'Quinoa Power Bowl', price: 1450, categories: { elements: [{ id: 'c2', name: 'Soups & Salads' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }, { id: 't3', name: 'GF' }] }, itemStock: { quantity: 18 }, available: true, autoManage: true },
      { id: 'item_9', name: 'Butter Chicken', price: 1950, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't5', name: 'Chef Special' }] }, itemStock: { quantity: 25 }, available: true, autoManage: true },
      { id: 'item_10', name: 'Paneer Tikka Masala', price: 1750, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: { quantity: 20 }, available: true, autoManage: true },
      { id: 'item_11', name: 'Chana Masala', price: 1500, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }] }, itemStock: { quantity: 30 }, available: true, autoManage: true },
      { id: 'item_12', name: 'Lamb Vindaloo', price: 2300, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't2', name: 'Spicy' }] }, itemStock: { quantity: 10 }, available: true, autoManage: true },
      { id: 'item_13', name: 'Smash Burger', price: 1700, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [] }, itemStock: { quantity: 35 }, available: true, autoManage: true },
      { id: 'item_14', name: 'Impossible Burger', price: 1800, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }] }, itemStock: { quantity: 15 }, available: true, autoManage: true },
      { id: 'item_15', name: 'Grilled Salmon, Lemon Herb', price: 2600, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't3', name: 'GF' }] }, itemStock: { quantity: 8 }, available: true, autoManage: true },
      { id: 'item_16', name: 'Mushroom Risotto', price: 2100, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }, { id: 't3', name: 'GF' }] }, itemStock: { quantity: 14 }, available: true, autoManage: true },
      { id: 'item_17', name: 'Pad Thai Tofu', price: 1650, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }] }, itemStock: { quantity: 22 }, available: true, autoManage: true },
      { id: 'item_18', name: 'Korean Fried Chicken Sandwich', price: 1600, categories: { elements: [{ id: 'c3', name: 'Mains' }] }, tags: { elements: [{ id: 't2', name: 'Spicy' }] }, itemStock: {}, available: false, autoManage: false },
      { id: 'item_19', name: 'Garlic Naan', price: 400, categories: { elements: [{ id: 'c4', name: 'Breads & Sides' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_20', name: 'Tawa Roti', price: 350, categories: { elements: [{ id: 'c4', name: 'Breads & Sides' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }] }, itemStock: { quantity: 0 }, available: true, autoManage: false },
      { id: 'item_21', name: 'Jeera Rice', price: 500, categories: { elements: [{ id: 'c4', name: 'Breads & Sides' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }, { id: 't3', name: 'GF' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_22', name: 'Cucumber Raita', price: 450, categories: { elements: [{ id: 'c4', name: 'Breads & Sides' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }, { id: 't3', name: 'GF' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_23', name: 'Mac & Cheese', price: 800, categories: { elements: [{ id: 'c4', name: 'Breads & Sides' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_24', name: 'Gulab Jamun', price: 700, categories: { elements: [{ id: 'c5', name: 'Desserts' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: { quantity: 30 }, available: true, autoManage: true },
      { id: 'item_25', name: 'Molten Chocolate Cake', price: 1100, categories: { elements: [{ id: 'c5', name: 'Desserts' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: { quantity: 12 }, available: true, autoManage: true },
      { id: 'item_26', name: 'Mango Sorbet', price: 800, categories: { elements: [{ id: 'c5', name: 'Desserts' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }, { id: 't3', name: 'GF' }] }, itemStock: { quantity: 20 }, available: true, autoManage: true },
      { id: 'item_27', name: 'Mango Lassi', price: 600, categories: { elements: [{ id: 'c6', name: 'Drinks' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_28', name: 'Masala Chai', price: 450, categories: { elements: [{ id: 'c6', name: 'Drinks' }] }, tags: { elements: [{ id: 't1', name: 'Vegetarian' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_29', name: 'Cold Brew', price: 550, categories: { elements: [{ id: 'c6', name: 'Drinks' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_30', name: 'Spicy Margarita', price: 1400, categories: { elements: [{ id: 'c6', name: 'Drinks' }] }, tags: { elements: [{ id: 't6', name: '21+' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_31', name: 'Hazy IPA', price: 900, categories: { elements: [{ id: 'c6', name: 'Drinks' }] }, tags: { elements: [{ id: 't6', name: '21+' }] }, itemStock: {}, available: true, autoManage: false },
      { id: 'item_32', name: 'Sparkling Yuzu Lemonade', price: 650, categories: { elements: [{ id: 'c6', name: 'Drinks' }] }, tags: { elements: [{ id: 't4', name: 'Vegan' }] }, itemStock: {}, available: true, autoManage: false },
    ];

    this.catalogs.set(mid, demoItems);
  }
}
