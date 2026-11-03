// The type rule of a data source's tools (`Adapter connect flow` › «a tool takes free text», ADR-024): only parameters
// that are numbers, whole numbers, yes/no, a pick from a list or a string of at most 64 characters can be ticked.
import { describe, expect, it } from 'vitest';
import { toolOf, toolsOf } from '../src/sources/types';

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
