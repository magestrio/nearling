// The type rule of a data source's tools (`Adapter connect flow`, `Data source call data`, ADR-024): a tool can be ticked
// when every parameter is a number, an integer, a boolean, a pick from a list, or a string no longer than 64
// characters. An object, a list of values, `oneOf`/`anyOf` and a string that may run past 64 characters are free
// text: the asker's words could ride in them, so the tool is never called. Pure; the same rule rules skill code
// (`code/runner.ts`, group 8).

/** A parameter as the sheet words it («Takes: month (number), day (number).»): the client builds the text from this. */
export type ParamType = 'number' | 'integer' | 'boolean' | 'pick' | 'text';

export interface ToolParam {
  name: string;
  type: ParamType;
  /** A `pick`: the values the tool accepts, as text. */
  options?: string[];
  /** A `text`: the longest value the tool takes, when its schema says (at most 64 for a tickable tool). */
  maxLength?: number;
  required: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** The parameters of a tickable tool. A tool that takes free text lists none: the sheet says only that it can't be used. */
  params: ToolParam[];
  tickable: boolean;
  /** Why a tool can't be ticked (`Takes free text …`). */
  reason?: 'free_text';
}

/** What a data source's `tools/list` gives for one tool. Its shape is the MCP spec's; nothing is trusted. */
export interface RawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

/** The longest value a call may send for a text parameter (`Data source call data`). */
export const MAX_VALUE_CHARS = 64;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One property of a schema as a parameter, or `null` when it is free text. */
function paramOf(name: string, schema: unknown, required: boolean): ToolParam | null {
  if (!isObject(schema)) return null;
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || schema.allOf !== undefined || schema.$ref !== undefined) return null;
  const options = schema.enum;
  // A pick from a list: the call can only send one of its values, whatever the declared type.
  if (Array.isArray(options)) {
    const picks = options.filter((v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean').map(String);
    return picks.length === options.length && picks.length > 0 ? { name, type: 'pick', options: picks, required } : null;
  }
  switch (schema.type) {
    case 'number':
      return { name, type: 'number', required };
    case 'integer':
      return { name, type: 'integer', required };
    case 'boolean':
      return { name, type: 'boolean', required };
    case 'string': {
      const max = schema.maxLength;
      if (max === undefined) return { name, type: 'text', required };
      return typeof max === 'number' && Number.isFinite(max) && max <= MAX_VALUE_CHARS ? { name, type: 'text', maxLength: max, required } : null;
    }
    default:
      // object, array, a list of types, null, or no type at all
      return null;
  }
}

/** A tool from a `tools/list` entry, judged by the type rule; `null` for an entry with no usable name. */
export function toolOf(raw: RawTool): Tool | null {
  if (typeof raw.name !== 'string' || raw.name === '') return null;
  const description = typeof raw.description === 'string' ? raw.description : '';
  const schema = raw.inputSchema;
  // A tool with no schema takes nothing.
  if (schema === undefined || schema === null) return { name: raw.name, description, params: [], tickable: true };
  if (!isObject(schema) || (schema.type !== undefined && schema.type !== 'object')) return { name: raw.name, description, params: [], tickable: false, reason: 'free_text' };
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || schema.allOf !== undefined || schema.$ref !== undefined) {
    return { name: raw.name, description, params: [], tickable: false, reason: 'free_text' };
  }
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [];
  const params: ToolParam[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const param = paramOf(name, property, required.includes(name));
    if (param === null) return { name: raw.name, description, params: [], tickable: false, reason: 'free_text' };
    params.push(param);
  }
  return { name: raw.name, description, params, tickable: true };
}

/** The tools of a source as the rule sees them. A name that repeats keeps its first entry. */
export function toolsOf(raws: RawTool[]): Tool[] {
  const seen = new Set<string>();
  const tools: Tool[] = [];
  for (const raw of raws) {
    const tool = toolOf(raw);
    if (tool === null || seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}
