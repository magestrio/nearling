import type { ThoughtPointer, PointerCall } from './checkMachine';

const forms = { read: 'Read this', find: 'Find out', check: 'Is it true?' } as const;
const labels = { search: 'Web search', data: 'Looking up data', report: 'Report', reask: 'Quick re-ask' } as const;

export function errandForm(thought: ThoughtPointer): string | null {
  return thought.kind === 'errand' && thought.form ? forms[thought.form] : null;
}

export function errandTime(thought: ThoughtPointer): string | null {
  const form = errandForm(thought);
  if (!form) return null;
  return thought.form === 'read' ? form : `${form} · ${thought.searches ?? 0} searches`;
}

export function errandCallTitle(call: PointerCall): string | null {
  return call.label && call.label in labels ? labels[call.label as keyof typeof labels] : null;
}

export function stoppedSearch(call: PointerCall): boolean {
  return call.label === 'search' && Boolean(call.cut) && !call.signature;
}

export function reportCall(thought: ThoughtPointer, call: PointerCall): boolean {
  return thought.kind !== 'errand' || call.label === 'report';
}
