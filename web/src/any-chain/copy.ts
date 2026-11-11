export const payCopy = {
  quoteAction: 'Get payment address',
  sourceChain: 'Pay from', sourceAsset: 'Pay with', sourceAmount: 'Amount to send',
  expectedFood: (name: string) => `Estimated food for ${name}`,
  minimumFood: 'Minimum food after exchange', usdEstimate: 'Estimated value in USD',
  refundFee: 'Fee if your payment is returned', networkFee: 'Network fee paid by your wallet',
  arrival: 'Estimated time to food', sendBefore: 'Send before',
  depositAddress: 'Send to this address', copyDepositAddress: 'Copy payment address',
  memo: 'Memo to include', copyMemo: 'Copy memo', inactiveTime: 'Address becomes inactive',
  deadline: 'Last time to send', refundAddress: 'Return address',
  refundInput: 'Return address',
  sourceGas: 'Your wallet sends the payment and pays its network fee. We use public network services to check its progress.',
  swapFees: 'Exchange and transfer fees',
  walletNotice: 'Your wallet sends the payment and pays its network fee. We use public network services to check its progress.',
  publicNotice: 'Your transfer and any food added on NEAR will be public. Your wallet address and amount may be visible to anyone.',
  copyFailed: 'Select and copy the details by hand.',
} as const;

export const statusCopy = {
  title: 'Payment status', back: (name: string) => `Back to ${name}`,
  amount: 'Amount sent', route: 'Payment path', source: (chain: string) => `View transfer on ${chain}`,
  provider: 'View exchange status', sourceStage: 'Transfer seen', swapStage: 'Exchange in progress',
  held: 'Payment held — no food added', nearEvidence: 'View NEAR delivery',
  heldReasons: {
    wrong_sender: 'The NEAR delivery came from an unexpected sender.',
    unknown_pet: 'The delivery did not name a pet we can find.',
    invalid_route: 'The delivery did not include a valid payment reference.',
    storage_unavailable: 'There was no space to record a new food payment.',
    capacity: 'Too many food payments were waiting to finish.',
    below_minimum: 'Too little to become food. This amount is held while we check its return.',
  },
  sourceVerified: 'Source payment verified', sourceUnverified: 'Source payment could not be verified yet',
  returnWait: 'A return can take about 2 hours. This amount is not food and has not been returned yet.',
  returnFee: 'Exchange fee', transferFee: 'Transfer fee', returnAddress: 'USDC return address',
  receivedAt: 'USDC received at', original: 'Original payment', refundProof: 'View confirmed return',
  nearRelease: 'View NEAR release to the return service',
} as const;

export const chainCopy = {
  network: 'Network',
  contract: 'Supported USDC token',
  minimum: 'Minimum to become food now',
  wait: 'Estimated time to food',
  warning: 'This address and its deposits are public. Send only the USDC shown on the matching network. Other tokens or a transfer on the wrong network may not become food and have no automatic return. Food appears only after conversion and NEAR confirmation.',
  transferId: 'Your transfer ID',
  statusLink: 'Link to this deposit’s status',
  petLink: (name: string) => `View ${name}`,
  petAddress: (chain: string, name: string) => `${chain} address for ${name}`,
} as const;

export const depositCopy = {
  statusEntry: 'View deposit status',
  eligibleAmount: 'eligible amount', balanceRemaining: 'balance remaining',
  window: 'one-hour sweep window', destination: 'destination',
  refundRecipient: 'pet-address refund recipient', fees: 'fees',
  minimumFood: 'minimum food at 1% slippage',
} as const;
