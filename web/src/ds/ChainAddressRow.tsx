import { CopyField } from './CopyField';
import { Facts } from './Facts';
import { Heading } from './Text';

/** Port of design/ds/components.js 0.50 ChainAddressRow. */
export function ChainAddressRow({ network, contractLabel, contract, minimumLabel, minimum,
  waitLabel, wait, address, copyLabel, onCopy }: {
  network: string; contractLabel: string; contract: string; minimumLabel: string;
  minimum: string; waitLabel: string; wait: string; address: string; copyLabel: string;
  onCopy: () => void;
}) {
  return <div className="ds-chain-address">
    <Heading level={3} variant="title-3">{network}</Heading>
    <Facts items={[{ label: contractLabel, value: contract }, { label: minimumLabel, value: minimum },
      { label: waitLabel, value: wait }]} />
    <CopyField value={address} mono label={`${network} address`} copyLabel={copyLabel} onCopy={onCopy} />
  </div>;
}
