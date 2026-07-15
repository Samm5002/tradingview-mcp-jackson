/**
 * @file FuturesUniverseDiscovery.ts
 * @layer Runner â€” Universe
 * @purpose Discover the top-N most liquid USDT perpetual futures contracts on BingX.
 *
 * Uses the public 24-hour ticker endpoint (no auth required):
 *   GET https://open-api.bingx.com/openApi/swap/v2/quote/ticker
 *
 * Filtering:
 *   - Only USDT-margined symbols (symbol ends with "-USDT")
 *   - Excludes all NC* synthetic instruments (NCFX forex, NCCO commodities, NCSK stocks, NCSI indices)
 *   - Only contracts with quoteVolume > 0 (inactive/delisted symbols have zero volume)
 *
 * Ranking: descending 24h quote volume (USDT notional traded).
 */

import https from 'node:https';

const TICKER_URL = 'https://open-api.bingx.com/openApi/swap/v2/quote/ticker';
const REQUEST_TIMEOUT_MS = 15_000;

interface BingXTickerEntry {
  symbol: string;
  quoteVolume: string;
}

interface BingXTickerResponse {
  code: number;
  data: BingXTickerEntry[];
}

function isBingXTickerResponse(v: unknown): v is BingXTickerResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['code'] === 'number' && Array.isArray(r['data']);
}

function isBingXTickerEntry(v: unknown): v is BingXTickerEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e['symbol'] === 'string' && typeof e['quoteVolume'] === 'string';
}

export type HttpGetFn = (url: string) => Promise<unknown>;

function defaultHttpGet(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;

    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        if (settled) return;
        clearTimeout(deadline);
        settled = true;
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON parse failed: ${body.slice(0, 120)}`)); }
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      clearTimeout(deadline);
      settled = true;
      reject(err);
    });

    deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`BingX ticker request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
  });
}

export class FuturesUniverseDiscovery {
  constructor(private readonly httpGet: HttpGetFn = defaultHttpGet) {}

  /**
   * Return the top `topN` USDT perpetual futures symbols ranked by 24h quote volume.
   * Throws if the BingX API returns a non-zero code or an unexpected response shape.
   */
  async discover(topN = 100): Promise<ReadonlyArray<string>> {
    const raw = await this.httpGet(TICKER_URL);

    if (!isBingXTickerResponse(raw)) {
      throw new Error('FuturesUniverseDiscovery: unexpected ticker response shape');
    }
    if (raw.code !== 0) {
      throw new Error(`FuturesUniverseDiscovery: BingX API error code ${raw.code}`);
    }

    return raw.data
      .filter(isBingXTickerEntry)
      .filter(e => e.symbol.endsWith('-USDT') && !e.symbol.startsWith('NC') && parseFloat(e.quoteVolume) > 0)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, topN)
      .map(e => e.symbol);
  }
}

