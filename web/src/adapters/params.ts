import type { ToolParam, ToolView } from '../seams/worker-types';

// How a tool's parameters are worded under its description (`Adapter connect flow` › «address answered», `## Не из спеки` 7):
// «Takes: {param} ({type}), …» with the type in the player's words. A tool with no parameters has no line.

/** One parameter's type, as the player reads it. */
export function typeWord(param: ToolParam): string {
  switch (param.type) {
    case 'number':
      return 'number';
    case 'integer':
      return 'whole number';
    case 'boolean':
      return 'yes or no';
    case 'pick':
      return `one of ${(param.options ?? []).join(', ')}`;
    case 'text':
      return param.maxLength !== undefined ? `text, up to ${param.maxLength} characters` : 'text';
  }
}

/** «Takes: month (number), day (number).» — null for a tool with no parameters. */
export function takesLine(params: readonly ToolParam[]): string | null {
  if (params.length === 0) return null;
  return `Takes: ${params.map((p) => `${p.name} (${typeWord(p)})`).join(', ')}.`;
}

/** The server's `MAX_DESCRIPTION`: the model reads a tool's description cut to this, so the row shows no more of it.
 * A gateway's tool can carry pages of text (Pipeworx's polymarket_arbitrage, 2026-11-12). */
export const MAX_DESCRIPTION = 300;

/** The tool's description, cut as the model reads it, with its parameters after it, as the row shows them. */
export function toolDescription(tool: Pick<ToolView, 'description' | 'params'>): string {
  const chars = [...tool.description];
  const description = chars.length > MAX_DESCRIPTION ? `${chars.slice(0, MAX_DESCRIPTION).join('').trimEnd()}…` : tool.description;
  const takes = takesLine(tool.params);
  return takes ? `${description} ${takes}` : description;
}
