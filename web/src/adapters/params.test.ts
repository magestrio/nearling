import { describe, expect, it } from 'vitest';
import type { ToolParam } from '../seams/worker-types';
import { MAX_DESCRIPTION, takesLine, toolDescription, typeWord } from './params';

const param = (p: Partial<ToolParam> & Pick<ToolParam, 'name' | 'type'>): ToolParam => ({ required: true, ...p });

describe('how a tool\'s parameters are worded', () => {
  // spec: add-pet-errands › Adapter connect flow › address answered
  it('says «Takes: {param} ({type}), …» with each type in the player\'s words', () => {
    expect(takesLine([param({ name: 'month', type: 'number' }), param({ name: 'day', type: 'number' })])).toBe('Takes: month (number), day (number).');
    expect(typeWord(param({ name: 'n', type: 'integer' }))).toBe('whole number');
    expect(typeWord(param({ name: 'on', type: 'boolean' }))).toBe('yes or no');
    expect(typeWord(param({ name: 'unit', type: 'pick', options: ['metric', 'imperial'] }))).toBe('one of metric, imperial');
    expect(typeWord(param({ name: 'q', type: 'text' }))).toBe('text');
    expect(takesLine([param({ name: 'query', type: 'text', maxLength: 500 })])).toBe('Takes: query (text, up to 500 characters).');
  });

  // spec: add-pet-errands › Adapter connect flow › address answered
  it('has no line for a tool with no parameters, and the description stands alone', () => {
    expect(takesLine([])).toBeNull();
    expect(toolDescription({ description: 'The moon today.', params: [] })).toBe('The moon today.');
  });

  // Bug: a gateway tool's description of pages stood whole in the row, though the model reads only its first 300 characters.
  it('cuts a long description to what the model reads, and keeps the parameters line after it', () => {
    const shown = toolDescription({ description: 'x'.repeat(MAX_DESCRIPTION + 50), params: [param({ name: 'day', type: 'number' })] });
    expect(shown).toBe(`${'x'.repeat(MAX_DESCRIPTION)}… Takes: day (number).`);
    expect(toolDescription({ description: 'y'.repeat(MAX_DESCRIPTION), params: [] })).toBe('y'.repeat(MAX_DESCRIPTION));
  });

  // spec: add-pet-errands › Adapter connect flow › address answered
  it('puts the line after the description, as the frames do', () => {
    expect(toolDescription({ description: 'Notable events on a month and day.', params: [param({ name: 'month', type: 'number' }), param({ name: 'day', type: 'number' })] })).toBe(
      'Notable events on a month and day. Takes: month (number), day (number).',
    );
  });
});
