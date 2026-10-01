import { EventEmitter } from 'node:events';
import type { AppDatabase } from '../../database/src/database.js';
import type { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';

export interface MarketQuote { symbol: string; price: number; bid: number; ask: number; volume: number; previousClose: number; asOf: string; source: string }
export interface MarketBar { symbol: string; start: string; open: number; high: number; low: number; close: number; volume: number }
export interface MarketStatus { open: boolean; phase: 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'; asOf: string; source: string }
export interface ScannerCandidate { symbol: string; reason: string; score: number; metrics: Record<string, number>; asOf: string }

export interface MarketDataProvider {
  readonly name: string;
  readonly tradingEligible: boolean;
  getQuote(symbol: string): Promise<MarketQuote>;
  getQuotes(symbols: string[]): Promise<MarketQuote[]>;
  getBars(symbol: string, interval: string, limit: number): Promise<MarketBar[]>;
  getMarketStatus(): Promise<MarketStatus>;
  getScannerResults(criteria: Record<string, unknown>): Promise<ScannerCandidate[]>;
}

const STARTING_PRICES: Record<string, number> = { NVDA: 178.42, RKLB: 47.18, MSFT: 508.31, VTI: 323.72, TSLA: 364.80, AAPL: 231.44, SPY: 649.26 };

export class SimulationMarketDataProvider implements MarketDataProvider {
  readonly name = 'SIMULATION_DETERMINISTIC';
  readonly tradingEligible = false;
  private tick = 0;

  async getQuote(symbol: string): Promise<MarketQuote> {
    const normalized = symbol.toUpperCase();
    const base = STARTING_PRICES[normalized] ?? 50 + this.hash(normalized) % 200;
    const wave = Math.sin((this.tick++ + this.hash(normalized)) / 7) * 0.004;
    const price = this.money(base * (1 + wave));
    return { symbol: normalized, price, bid: this.money(price * 0.9995), ask: this.money(price * 1.0005), volume: 1_000_000 + this.hash(normalized) * 100, previousClose: base, asOf: new Date().toISOString(), source: this.name };
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> { return Promise.all(symbols.map((symbol) => this.getQuote(symbol))); }
  async getBars(symbol: string, _interval: string, limit: number): Promise<MarketBar[]> {
    const quote = await this.getQuote(symbol);
    return Array.from({ length: Math.min(limit, 100) }, (_, index) => {
      const start = new Date(Date.now() - (limit - index) * 60_000).toISOString();
      const close = this.money(quote.price * (1 + Math.sin(index / 4) * 0.003));
      return { symbol: quote.symbol, start, open: this.money(close * 0.999), high: this.money(close * 1.002), low: this.money(close * 0.998), close, volume: 10_000 + index * 731 };
    });
  }
  async getMarketStatus(): Promise<MarketStatus> { return { open: true, phase: 'REGULAR', asOf: new Date().toISOString(), source: this.name }; }
  async getScannerResults(_criteria: Record<string, unknown>): Promise<ScannerCandidate[]> {
    const symbols = ['NVDA', 'RKLB', 'MSFT', 'AAPL', 'TSLA'];
    const quotes = await this.getQuotes(symbols);
    return quotes.map((quote, index) => ({ symbol: quote.symbol, reason: index % 2 ? 'Relative volume expansion' : 'Price momentum threshold', score: 0.91 - index * 0.08, metrics: { price: quote.price, movePercent: ((quote.price / quote.previousClose) - 1) * 100, volume: quote.volume }, asOf: quote.asOf }));
  }
  private hash(value: string): number { return [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0); }
  private money(value: number): number { return Math.round(value * 100) / 100; }
}

export interface WatcherEvent { type: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; strategyId?: string; symbol?: string; payload: Record<string, unknown>; createdAt: string }

export class WatcherEngine extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private lastQuotes = new Map<string, MarketQuote>();
  constructor(private readonly provider: MarketDataProvider, private readonly database: AppDatabase, private readonly ledger: VirtualPortfolioLedger, private readonly intervalMs = 15_000) { super(); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async poll(): Promise<WatcherEvent[]> {
    if(this.database.getMode()!=='SIMULATION'&&!this.provider.tradingEligible)return [];
    const symbols = new Set(this.ledger.listPositions().map((position) => position.symbol));
    for (const row of this.database.raw.prepare('SELECT symbol FROM watchlists').all() as Array<{ symbol: string }>) symbols.add(row.symbol);
    if (!symbols.size) ['NVDA', 'RKLB', 'SPY'].forEach((symbol) => symbols.add(symbol));
    const quotes = await this.provider.getQuotes([...symbols]);
    this.ledger.markPrices(quotes);
    const events: WatcherEvent[] = [];
    for (const quote of quotes) {
      const previous = this.lastQuotes.get(quote.symbol);
      if (previous) {
        const movePercent = Math.abs((quote.price - previous.price) / previous.price) * 100;
        if (movePercent >= 1) events.push(this.publish({ type: 'RAPID_PRICE_MOVEMENT', severity: movePercent >= 3 ? 'WARNING' : 'INFO', symbol: quote.symbol, payload: { from: previous.price, to: quote.price, movePercent }, createdAt: quote.asOf }));
      }
      this.lastQuotes.set(quote.symbol, quote);
    }
    return events;
  }
  private publish(event: WatcherEvent): WatcherEvent { this.emit('event', event); return event; }
}
