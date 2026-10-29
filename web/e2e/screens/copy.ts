export interface ManifestFrame {
  id: string;
  req: string;
  state: string;
  copy?: string[];
  scroll?: 'top' | 'end';
  viewports?: Array<'desktop' | 'phone'>;
}

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

/** The viewports a frame keeps: both, unless its manifest entry limits them. */
export function viewportsOf(frame: ManifestFrame): ViewportName[] {
  const all = Object.keys(VIEWPORTS) as ViewportName[];
  return frame.viewports ? all.filter((v) => frame.viewports!.includes(v)) : all;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A frame's `copy` line as a pattern: a `{name}`-style placeholder stands for any text. */
export function copyPattern(copy: string): RegExp {
  const parts = copy.trim().split(/\{[^}]+\}/).map((p) => escapeRegExp(p.trim()).replace(/\s+/g, '\\s+'));
  return new RegExp(parts.join('.+?'));
}
