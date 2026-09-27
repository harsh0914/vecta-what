export interface CloverTokens {
  access_token: string;
  access_token_expiration: number; // epoch seconds
  refresh_token: string;
  refresh_token_expiration: number; // epoch seconds
}

export interface CloverMerchantContext {
  id: string;
  name: string;
  address?: {
    city?: string;
    state?: string;
    country?: string;
  };
}

export interface CloverItemStock {
  quantity?: number;
}

export interface CloverCategory {
  id: string;
  name: string;
}

export interface CloverTag {
  id: string;
  name: string;
}

export interface CloverItem {
  id: string;
  name: string;
  alternateName?: string;
  price?: number; // cents
  priceType?: string;
  categories?: { elements: CloverCategory[] };
  tags?: { elements: CloverTag[] };
  itemStock?: CloverItemStock;
  available?: boolean;
  hidden?: boolean;
  autoManage?: boolean;
  deleted?: boolean;
  modifiedTime?: number; // epoch ms
}

export interface CloverListOptions {
  limit?: number;
  offset?: number;
  modifiedSince?: number; // epoch ms
}

export interface CloverClient {
  getAuthorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<CloverTokens>;
  refreshToken(refreshToken: string): Promise<CloverTokens>;
  recoverToken(refreshToken: string): Promise<CloverTokens>;
  getMerchant(merchantId: string, accessToken?: string): Promise<CloverMerchantContext>;
  listItems(
    merchantId: string,
    options?: CloverListOptions,
    accessToken?: string
  ): Promise<{ elements: CloverItem[]; total?: number }>;
  getItem(merchantId: string, itemId: string, accessToken?: string): Promise<CloverItem>;
}
