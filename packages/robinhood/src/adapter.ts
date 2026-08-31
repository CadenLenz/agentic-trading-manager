import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { BrokerAccountSnapshot, BrokerOrderRequest, BrokerOrderResult, McpCapability } from '../../core/src/types.js';
import type { CodexRunner } from '../../agents/src/codex-runner.js';

const execFileAsync = promisify(execFile);
const jsonObjectSchema = { type: 'object', additionalProperties: true } as const;
const discoveryValidator = z.object({ connected: z.boolean(), authenticated: z.boolean(), capabilities: z.array(z.object({ name: z.string(), description: z.string(), category: z.enum(['READ', 'PREVIEW', 'TRADE', 'CANCEL', 'MARKET_DATA', 'UNKNOWN']) })), limitation: z.string() });
const accountValidator = z.object({
  buyingPower: z.number(), cash: z.number(), equity: z.number(), asOf: z.string().datetime(),
  positions: z.array(z.object({ symbol: z.string(), quantity: z.number(), averageCost: z.number(), assetType: z.enum(['EQUITY', 'ETF', 'OPTION', 'CRYPTO']), sector: z.string() })),
  openOrders: z.array(z.object({ brokerOrderId: z.string(), symbol: z.string(), side: z.enum(['BUY', 'SELL']), quantity: z.number(), filledQuantity: z.number(), status: z.string() })),
});
const orderValidator = z.object({ brokerOrderId: z.string().min(1), status: z.enum(['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN']), submittedAt: z.string().datetime(), raw: z.record(z.string(), z.unknown()) });

export interface RobinhoodStatus { configured: boolean; connected: boolean; authenticated: boolean; capabilities: McpCapability[]; limitation: string }

export class RobinhoodMcpAdapter {
  private statusCache: RobinhoodStatus | null = null;
  constructor(private readonly runner: CodexRunner, private readonly workingDirectory: string, private readonly binary = process.env.CODEX_BIN ?? 'codex') {}

  async discoverCapabilities(force = false): Promise<RobinhoodStatus> {
    if (this.statusCache && !force) return this.statusCache;
    const configured = await this.isConfigured();
    if (!configured) {
      this.statusCache = { configured: false, connected: false, authenticated: false, capabilities: [], limitation: 'The robinhood-trading MCP server is not configured in Codex.' };
      return this.statusCache;
    }
    const schema = {
      type: 'object', additionalProperties: false, required: ['connected', 'authenticated', 'capabilities', 'limitation'],
      properties: {
        connected: { type: 'boolean' }, authenticated: { type: 'boolean' }, limitation: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'description', 'category'], properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string', enum: ['READ', 'PREVIEW', 'TRADE', 'CANCEL', 'MARKET_DATA', 'UNKNOWN'] } } } },
      },
    };
    try {
      const result = await this.runner.run({ agent: 'ROBINHOOD CAPABILITY AUDITOR', workingDirectory: this.workingDirectory, schema, validate: (value) => discoveryValidator.parse(value), prompt: 'Inspect the currently available tools from the robinhood-trading MCP server. Do not place, preview, or cancel any order. Return exact tool names and conservative capability categories. Test authentication only with a harmless read if necessary.' });
      this.statusCache = { configured: true, ...result.value };
    } catch (error) {
      this.statusCache = { configured: true, connected: false, authenticated: false, capabilities: [], limitation: error instanceof Error ? error.message : String(error) };
    }
    return this.statusCache;
  }

  async getAccountSnapshot(): Promise<BrokerAccountSnapshot> {
    const status = await this.discoverCapabilities();
    if (!status.authenticated) throw new Error(`Robinhood MCP is not authenticated: ${status.limitation}`);
    const schema = {
      type: 'object', additionalProperties: false, required: ['buyingPower', 'cash', 'equity', 'positions', 'openOrders', 'asOf'],
      properties: {
        buyingPower: { type: 'number' }, cash: { type: 'number' }, equity: { type: 'number' }, asOf: { type: 'string', format: 'date-time' },
        positions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['symbol', 'quantity', 'averageCost', 'assetType', 'sector'], properties: { symbol: { type: 'string' }, quantity: { type: 'number' }, averageCost: { type: 'number' }, assetType: { type: 'string', enum: ['EQUITY', 'ETF', 'OPTION', 'CRYPTO'] }, sector: { type: 'string' } } } },
        openOrders: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['brokerOrderId', 'symbol', 'side', 'quantity', 'filledQuantity', 'status'], properties: { brokerOrderId: { type: 'string' }, symbol: { type: 'string' }, side: { type: 'string', enum: ['BUY', 'SELL'] }, quantity: { type: 'number' }, filledQuantity: { type: 'number' }, status: { type: 'string' } } } },
      },
    };
    const result = await this.runner.run({ agent: 'ROBINHOOD READ ADAPTER', workingDirectory: this.workingDirectory, schema, validate: (value) => accountValidator.parse(value), prompt: 'Using only official robinhood-trading MCP read tools, obtain the Agentic Account cash, buying power, equity, positions, and open orders. Do not place, preview, modify, or cancel any order. Use the Agentic Account, not another Robinhood account.' });
    return result.value;
  }

  async previewOrder(order: BrokerOrderRequest): Promise<Record<string, unknown>> {
    const status = await this.discoverCapabilities();
    if (!status.authenticated || !status.capabilities.some((capability) => capability.category === 'PREVIEW')) return { supported: false, reason: 'No authenticated official preview capability was discovered.' };
    const result = await this.runner.run({ agent: 'ROBINHOOD ORDER PREVIEW ADAPTER', workingDirectory: this.workingDirectory, schema: jsonObjectSchema, validate: (value) => z.record(z.string(), z.unknown()).parse(value), prompt: `Preview exactly this already-authorized order using the official robinhood-trading MCP preview tool. Do not place it. Order: ${JSON.stringify(order)}` });
    return result.value;
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const status = await this.discoverCapabilities();
    if (!status.authenticated || !status.capabilities.some((capability) => capability.category === 'TRADE')) throw new Error('No authenticated official Robinhood order-placement capability was discovered');
    const schema = { type: 'object', additionalProperties: false, required: ['brokerOrderId', 'status', 'submittedAt', 'raw'], properties: { brokerOrderId: { type: 'string' }, status: { type: 'string', enum: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'] }, submittedAt: { type: 'string', format: 'date-time' }, raw: jsonObjectSchema } };
    const result = await this.runner.run({ requestId: `broker-order:${order.clientOrderId}`, agent: 'ROBINHOOD EXECUTION ADAPTER', workingDirectory: this.workingDirectory, schema, validate: (value) => orderValidator.parse(value), prompt: `The AgenticManager has already passed all deterministic gates and authorizes exactly one order. Using only the official robinhood-trading MCP, place exactly this order in the Agentic Account and no other action: ${JSON.stringify(order)}. If the request outcome is uncertain, report status UNKNOWN with every broker identifier observed; never retry placement.` });
    return result.value;
  }

  async cancelOrder(brokerOrderId: string): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(brokerOrderId)) throw new Error('Invalid broker order identifier');
    const status = await this.discoverCapabilities();
    if (!status.authenticated || !status.capabilities.some((capability) => capability.category === 'CANCEL')) throw new Error('No authenticated official Robinhood cancellation capability was discovered');
    const result = await this.runner.run({ requestId: `broker-cancel:${brokerOrderId}`, agent: 'ROBINHOOD CANCEL ADAPTER', workingDirectory: this.workingDirectory, schema: jsonObjectSchema, validate: (value) => z.record(z.string(), z.unknown()).parse(value), prompt: `Cancel exactly Robinhood Agentic Account order ${brokerOrderId} using the official robinhood-trading MCP. Do not place or modify another order. Return the observed result.` });
    return result.value;
  }

  private async isConfigured(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(this.binary, ['mcp', 'list', '--json'], { timeout: 15_000, windowsHide: true, maxBuffer: 1_000_000 });
      const servers = z.array(z.object({ name: z.string(), enabled: z.boolean().optional() }).passthrough()).parse(JSON.parse(stdout));
      return servers.some((server) => server.name === 'robinhood-trading' && server.enabled !== false);
    } catch { return false; }
  }
}
