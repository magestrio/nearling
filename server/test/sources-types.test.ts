// The type rule of a data source's tools (`Adapter connect flow` › «a tool takes free text», ADR-024): only parameters
// that are numbers, whole numbers, yes/no, a pick from a list or a string of at most 64 characters can be ticked.
import { describe, expect, it } from 'vitest';
import { toolOf, toolsFor, toolsOf, type Tool } from '../src/sources/types';

const tool = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => toolOf({ name: 't', description: 'd', inputSchema: { type: 'object', properties, ...extra } })!;

describe('Adapter connect flow', () => {
  // spec: add-pet-errands › Adapter connect flow › a tool takes free text
  it('leaves an object, a list, oneOf and a long string unticked as free text', () => {
    for (const property of [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'array', items: { type: 'string' } },
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
      { anyOf: [{ type: 'string' }, { type: 'number' }] },
      { type: 'string', maxLength: 65 },
      { type: 'string', maxLength: 500 },
      { type: ['string', 'null'] },
      {},
    ]) {
      expect(tool({ p: property }), JSON.stringify(property)).toMatchObject({ tickable: false, reason: 'free_text', params: [] });
    }
    // one free parameter among tickable ones is enough
    expect(tool({ month: { type: 'number' }, query: { type: 'string', maxLength: 500 } })).toMatchObject({ tickable: false, reason: 'free_text' });
  });

  // spec: add-pet-errands › Adapter connect flow › a tool takes free text
  it('ticks a number, a whole number, a boolean, a pick and a string of at most 64 characters', () => {
    expect(tool({ n: { type: 'number' } }).params).toEqual([{ name: 'n', type: 'number', required: false }]);
    expect(tool({ n: { type: 'integer' } }).params).toEqual([{ name: 'n', type: 'integer', required: false }]);
    expect(tool({ b: { type: 'boolean' } }).params).toEqual([{ name: 'b', type: 'boolean', required: false }]);
    expect(tool({ c: { type: 'string', enum: ['north', 'south'] } }, { required: ['c'] }).params).toEqual([{ name: 'c', type: 'pick', options: ['north', 'south'], required: true }]);
    expect(tool({ s: { type: 'string' } }).params).toEqual([{ name: 's', type: 'text', required: false }]);
    expect(tool({ s: { type: 'string', maxLength: 64 } }).params).toEqual([{ name: 's', type: 'text', maxLength: 64, required: false }]);
    expect(tool({ s: { type: 'string', maxLength: 64 } }).tickable).toBe(true);
    // a tool with no schema or no parameters takes nothing and can be ticked
    expect(toolOf({ name: 't' })).toMatchObject({ tickable: true, params: [], description: '' });
    expect(tool({})).toMatchObject({ tickable: true, params: [] });
  });

  // spec: add-pet-errands › Adapter connect flow › a tool takes free text
  it('finds no tool left to tick when every tool takes free text, and keeps a name once', () => {
    const tools = toolsOf([
      { name: 'a', inputSchema: { type: 'object', properties: { q: { type: 'string', maxLength: 500 } } } },
      { name: 'b', inputSchema: { type: 'object', properties: { list: { type: 'array' } } } },
      { name: 'b', inputSchema: { type: 'object', properties: {} } },
      { description: 'no name' },
    ]);
    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(tools.some((t) => t.tickable)).toBe(false);
  });
});

// Bug: a gateway serves its whole catalogue at every path; Pipeworx's `/open-meteo/mcp` gave a weather skill ~50 tools,
// Polymarket among them (2026-11-12).
describe('the tools an address names', () => {
  const tool = (name: string): Tool => ({ name, description: '', params: [], tickable: true });
  const gateway = ['open_meteo_forecast', 'open_meteo_geocode', 'polymarket_arbitrage', 'ask_pipeworx', 'kalshi_weather_edge', 'search_coins'].map(tool);
  const names = (address: string, tools = gateway) => toolsFor(new URL(address), tools).map((t) => t.name);

  it('keeps only the tools that share a word with the path', () => {
    expect(names('https://gateway.pipeworx.io/open-meteo/mcp')).toEqual(['open_meteo_forecast', 'open_meteo_geocode']);
    // the first four letters are one subject: coingecko and search_coins
    expect(names('https://gateway.pipeworx.io/coingecko/mcp')).toEqual(['search_coins']);
  });

  it('keeps every tool when the path names nothing, or when no tool matches it', () => {
    expect(names('https://mcp-weather.example.com/mcp')).toHaveLength(gateway.length);
    expect(names('https://example.com/api/v1/sse')).toHaveLength(gateway.length);
    expect(names('https://example.com/zoology/mcp')).toHaveLength(gateway.length);
  });
});
