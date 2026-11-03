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

/** The tool's description with its parameters after it, as the row shows them. */
export function toolDescription(tool: Pick<ToolView, 'description' | 'params'>): string {
  const takes = takesLine(tool.params);
  return takes ? `${tool.description} ${takes}` : tool.description;
}
