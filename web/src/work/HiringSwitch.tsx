import { Cluster, Segmented, Stack, Text } from '../ds';
import type { SlotProps } from '../screens/pet/parts';
import { HIRING_LABEL, HIRING_OPTIONS, hiringLine } from './lines';

/** «Auto» / «Ask me first» and the line of the mode (`Hire mode rule`): the owner's awake pet only; without `hiring` (a guest, a
 *  visitor) it draws nothing. As the frames have it: a row under the desktop's input, stacked on the phone's card. */
export function HiringSwitch({ name, viewer, asleep, hiring, row }: SlotProps) {
  if (viewer !== 'owner' || asleep || !hiring) return null;
  const Box = row ? Cluster : Stack;
  return (
    <Box gap={row ? 3 : 2}>
      <Segmented
        label={HIRING_LABEL}
        role="trust"
        value={hiring.mode}
        options={HIRING_OPTIONS}
        onChange={(mode) => hiring.set(mode as 'auto' | 'manual')}
      />
      <Text variant="small" tone="secondary">
        {hiringLine(hiring.mode, name)}
      </Text>
    </Box>
  );
}
