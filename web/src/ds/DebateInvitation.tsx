import type { ReactNode } from 'react';
import { DebatePair, type DebatePet } from './DebatePair';
import { Actions, Cluster, Stack, Surface } from './layout';
import { Note } from './Note';
import { Heading, Text } from './Text';
import { Button } from './Button';

// DS 0.51 · design/ds/components.js › DebateInvitation.
export function DebateInvitation({ first, second, ordered, title = 'Debate invitation', topic, estimate, notice, status, tone, actions, onClose }: {
  first: DebatePet;
  second: DebatePet;
  ordered?: boolean;
  title?: string;
  topic: string;
  estimate: string;
  notice?: string;
  status?: string;
  tone?: 'hint' | 'plain' | 'error' | 'status';
  actions?: ReactNode;
  onClose?: () => void;
}) {
  return <li className="ds-debate-invitation"><Surface><Stack gap={3}>
    <Cluster gap={2} align="center" justify="space-between"><Heading level={2} variant="title-3">{title}</Heading>
      {onClose ? <Button icon="close" variant="ghost" size="compact" onClick={onClose}>Close</Button> : null}</Cluster>
    <DebatePair first={first} second={second} ordered={ordered} />
    <Text>{topic}</Text>
    <Text variant="small" tabular>{estimate}</Text>
    {notice ? <Note>{notice}</Note> : null}
    {status ? <Note tone={tone ?? 'status'}>{status}</Note> : null}
    {actions ? <Actions>{actions}</Actions> : null}
  </Stack></Surface></li>;
}
