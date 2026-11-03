// How a skill's code declares the functions the pet may call (`Skill code data` › «functions declared», ADR-025):
// `export const functions = { openerFor: { description: "…", params: { month: "number" } } }`. The wrapper hands the
// declaration over as JSON; it is read here by the type rule of data sources (`sources/types.ts`), so a function is
// ticked on the same terms as a tool. Pure.
import { MAX_VALUE_CHARS, type Tool, type ToolParam } from '../sources/types';
import { MAX_DESCRIPTION } from '../sources/limits';

/** A description is cut here, as a catalog entry's tool description is (`design.md` › The catalog). */
export { MAX_DESCRIPTION } from '../sources/limits';

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One parameter by its declared type: `number`, `integer`, `boolean`, `symbol` (the value rule's characters, ≤ 64), a pick
 * `["a", "b"]`, or `text`. Anything else is read as `text`. */
function paramOf(name: string, declared: unknown): ToolParam {
  if (Array.isArray(declared)) {
    const picks = declared.filter((v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean').map(String);
    if (picks.length === declared.length && picks.length > 0) return { name, type: 'pick', options: picks, required: true };
    return { name, type: 'text', required: true };
  }
  switch (declared) {
    case 'number':
      return { name, type: 'number', required: true };
    case 'integer':
      return { name, type: 'integer', required: true };
    case 'boolean':
      return { name, type: 'boolean', required: true };
    case 'symbol':
      return { name, type: 'text', maxLength: MAX_VALUE_CHARS, required: true };
    default:
      return { name, type: 'text', required: true };
  }
}

const freeText = (p: ToolParam): boolean => p.type === 'text' && (p.maxLength === undefined || p.maxLength > MAX_VALUE_CHARS);

const declaredParams = (entry: Record<string, unknown>): ToolParam[] =>
  isObject(entry.params) ? Object.entries(entry.params).map(([p, type]) => paramOf(p, type)) : [];

/** The parameters a function declares, free text included: a test run types its sample values by them. */
export function paramsOf(declaration: unknown, name: string): ToolParam[] {
  if (!isObject(declaration) || !Object.hasOwn(declaration, name)) return [];
  const entry = declaration[name];
  return isObject(entry) ? declaredParams(entry) : [];
}

/** The functions of a declaration as tools. A function that takes `text` is listed but never tickable, with
 * the line that it can't be used. `null` when the declaration is not an object. */
export function declaredTools(declaration: unknown): Tool[] | null {
  if (!isObject(declaration)) return null;
  const tools: Tool[] = [];
  for (const [name, entry] of Object.entries(declaration)) {
    if (!NAME.test(name) || !isObject(entry)) continue;
    const description = typeof entry.description === 'string' ? entry.description.slice(0, MAX_DESCRIPTION) : '';
    const params = declaredParams(entry);
    // the frame lists a free-text function's parameters too («Takes: query (text).») beside the line that it can't be ticked
    if (params.some(freeText)) tools.push({ name, description, params, tickable: false, reason: 'free_text' });
    else tools.push({ name, description, params, tickable: true });
  }
  return tools;
}

/** The sample values of a test run, typed by the declaration and in its order (the code's functions take them as
 * arguments, in the order `params` declares): the field's text is split at commas and each piece goes to the parameter
 * in its place. A piece that doesn't fit its type goes as the text it is, for the code to meet. */
export function typedValues(params: ToolParam[], field: string): unknown[] {
  const pieces = field.trim() === '' ? [] : field.split(',').map((piece) => piece.trim());
  const values: unknown[] = [];
  params.forEach((param, i) => {
    const piece = pieces[i];
    if (piece === undefined) return;
    switch (param.type) {
      case 'number':
      case 'integer': {
        const n = Number(piece);
        values[i] = piece !== '' && Number.isFinite(n) && (param.type === 'number' || Number.isInteger(n)) ? n : piece;
        break;
      }
      case 'boolean': {
        const word = piece.toLowerCase();
        values[i] = word === 'true' || word === 'yes' ? true : word === 'false' || word === 'no' ? false : piece;
        break;
      }
      default:
        values[i] = piece;
    }
  });
  return Array.from(values, (v) => v ?? null);
}
