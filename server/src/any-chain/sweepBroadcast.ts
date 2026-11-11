import { gasWallet } from './gasWallet';
import { nativePrice, ORIGINS, QuoteUnavailable, type Origin } from './quote';
import { sourceRpc, solanaCreateAtaMessage, solanaFundMessage, sourceBalance } from './sweepRpc';
import { signedBaseGasTransfer, signedPetSource, signedSolanaGasTransaction, type SourceSigned } from './sweepSigning';
import { providerStatus, readDeliveries } from './status';
import { verifiedSource } from './source';
import { PROJECT_CAP_MICROS, recordExpense, recordFinalNearExpense, routeProjectUsd } from './cost';
import { recordAnyChainEvent, recordCreditEvents, usdcFee } from './events';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface SweepFlight {
  route_id: string; deposit_id: string; token_id: string; chain: Origin; amount_units: string;
  provider_wallet: string; destination: string; refund_recipient: string;
  quote_json: string;
  payload_hex: string; source_meta_json: string; mpc_response: string | null;
  sponsor_cap_micros: number; estimated_gas_micros: number; estimated_rent_micros: number;
  native_funding_units: string; native_gas_units: string; native_rent_units: string;
  gas_wallet_address: string; creation_message: string | null;
  state: string; funding_tx_hash: string | null; funding_signed_tx: string | null;
  near_tx_hash: string | null;
  creation_tx_hash: string | null; creation_signed_tx: string | null;
  source_tx_hash: string | null; source_signed_tx: string | null;
}

function micros(chain: Origin, units: bigint, price: number): number {
  const value = Math.ceil(Number(units) / (chain === 'base' ? 1e18 : 1e9) * price * 1e6);
  if (!Number.isSafeInteger(value) || value < 0) throw new QuoteUnavailable('source_unavailable');
  return value;
}

async function budget(env: Env, route: SweepFlight, extraMicros: number): Promise<boolean> {
  const spent = await env.DB.prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM project_spend')
    .first<{ total: number }>();
  const reserved = await env.DB.prepare(`SELECT COALESCE(SUM(estimated_gas_micros + estimated_rent_micros + near_signer_reserve_micros), 0) AS total
    FROM any_chain_sweeps WHERE route_id <> ? AND expiry_ms > ? AND state IN
    ('quoted', 'signing', 'sign_unknown', 'signed', 'awaiting_gas', 'broadcasting')`)
    .bind(route.route_id, Date.now()).first<{ total: number }>();
  return (spent?.total ?? 0) + (reserved?.total ?? 0) + extraMicros <= PROJECT_CAP_MICROS;
}

/** Raise a reservation atomically before a live source price or rent can increase project spend. */
async function reserveLive(env: Env, row: SweepFlight, gasMicros: number, rentMicros: number): Promise<boolean> {
  const updated = await env.DB.prepare(`UPDATE any_chain_sweeps SET estimated_gas_micros = ?,
    estimated_rent_micros = ? WHERE route_id = ? AND state IN ('signed', 'awaiting_gas', 'broadcasting')
    AND (SELECT COALESCE(SUM(usd_micros), 0) FROM project_spend) +
      (SELECT COALESCE(SUM(estimated_gas_micros + estimated_rent_micros + near_signer_reserve_micros), 0) FROM any_chain_sweeps
        WHERE route_id <> ? AND expiry_ms > ? AND state IN
        ('quoted', 'signing', 'sign_unknown', 'signed', 'awaiting_gas', 'broadcasting')) + ? + ? <= ?`)
    .bind(gasMicros, rentMicros, row.route_id, row.route_id, Date.now(), gasMicros, rentMicros,
      PROJECT_CAP_MICROS).run();
  if (updated.meta.changes === 1) {
    row.estimated_gas_micros = gasMicros;
    row.estimated_rent_micros = rentMicros;
  }
  return updated.meta.changes === 1;
}

async function baseFinal(hash: string): Promise<'pending' | 'ok' | 'failed'> {
  const receipt = await sourceRpc<{ status?: string; blockNumber?: string } | null>('base', 'eth_getTransactionReceipt', [hash]);
  if (!receipt?.blockNumber) return 'pending';
  const block = await sourceRpc<{ number?: string }>('base', 'eth_getBlockByNumber', ['finalized', false]);
  if (!block?.number || BigInt(receipt.blockNumber) > BigInt(block.number)) return 'pending';
  return receipt.status === '0x1' ? 'ok' : 'failed';
}

async function solanaFinal(hash: string): Promise<'pending' | 'ok' | 'failed'> {
  const result = await sourceRpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>(
    'solana', 'getSignatureStatuses', [[hash], { searchTransactionHistory: true }]);
  const status = result.value?.[0];
  if (!status || status.confirmationStatus !== 'finalized') return 'pending';
  return status.err === null ? 'ok' : 'failed';
}

async function final(chain: Origin, hash: string): Promise<'pending' | 'ok' | 'failed'> {
  return chain === 'base' ? baseFinal(hash) : solanaFinal(hash);
}

async function broadcast(chain: Origin, signed: SourceSigned): Promise<void> {
  try {
    const result = chain === 'base'
      ? await sourceRpc<string>('base', 'eth_sendRawTransaction', [signed.encoded])
      : await sourceRpc<string>('solana', 'sendTransaction', [signed.encoded,
        { encoding: 'base64', skipPreflight: false, maxRetries: 0 }]);
    if (result.toLowerCase() !== signed.hash.toLowerCase()) throw new QuoteUnavailable('source_unavailable');
  } catch { /* The known signed hash is queried before any other transaction is created. */ }
}

async function saveTransaction(db: D1Database, routeId: string, prefix: 'creation' | 'funding' | 'source',
  signed: SourceSigned): Promise<void> {
  const updated = await db.prepare(`UPDATE any_chain_sweeps SET ${prefix}_tx_hash = ?, ${prefix}_signed_tx = ?,
    state = 'broadcasting', updated_at = ? WHERE route_id = ? AND ${prefix}_tx_hash IS NULL`)
    .bind(signed.hash, signed.encoded, Date.now(), routeId).run();
  if (updated.meta.changes !== 1) throw new QuoteUnavailable('source_unavailable');
}

async function expense(env: Env, route: SweepFlight, kind: string, hash: string, units: bigint, price: number): Promise<void> {
  const id = `${route.chain}:${kind}:${hash}`;
  const amount = micros(route.chain, units, price);
  if (amount === 0) return;
  await recordExpense(env, { id, routeId: route.route_id,
    kind: kind as 'source_gas' | 'source_account_rent', usdMicros: amount });
}

async function baseGas(env: Env, row: SweepFlight, price: number): Promise<'ready' | 'pending' | 'unavailable'> {
  const wallet = gasWallet(env, 'base');
  if (wallet.address.toLowerCase() !== row.gas_wallet_address.toLowerCase()) return 'unavailable';
  const balanceRaw = await sourceRpc<string>('base', 'eth_getBalance', [row.refund_recipient, 'latest']);
  const balance = BigInt(balanceRaw);
  const needed = BigInt(row.native_funding_units) > balance ? BigInt(row.native_funding_units) - balance : 0n;
  if (row.funding_tx_hash) {
    const state = await final('base', row.funding_tx_hash);
    if (state === 'pending') {
      if (row.funding_signed_tx) await broadcast('base', { hash: row.funding_tx_hash, encoded: row.funding_signed_tx });
      return 'pending';
    }
    const receipt = await sourceRpc<{ gasUsed: string; effectiveGasPrice: string }>('base', 'eth_getTransactionReceipt', [row.funding_tx_hash]);
    await expense(env, row, 'source_gas', row.funding_tx_hash,
      BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), price);
    if (state === 'failed') return 'unavailable';
    return 'ready';
  }
  if (needed === 0n) return 'ready';
  const [nonceRaw, walletBalanceRaw] = await Promise.all([
    sourceRpc<string>('base', 'eth_getTransactionCount', [wallet.address, 'pending']),
    sourceRpc<string>('base', 'eth_getBalance', [wallet.address, 'latest']),
  ]);
  const meta = JSON.parse(row.source_meta_json) as Record<string, string>;
  const maxFee = BigInt(meta.maxFee!);
  if (BigInt(walletBalanceRaw) < needed + 21_000n * maxFee) return 'unavailable';
  if (micros('base', BigInt(row.native_gas_units), price) > row.sponsor_cap_micros ||
    !await budget(env, row, row.estimated_gas_micros + row.estimated_rent_micros)) return 'unavailable';
  const signed = signedBaseGasTransfer(wallet.secret, BigInt(nonceRaw), row.refund_recipient,
    needed, BigInt(meta.priority!), maxFee);
  await saveTransaction(env.DB, row.route_id, 'funding', signed);
  await broadcast('base', signed);
  return 'pending';
}

async function solanaBalance(address: string): Promise<bigint> {
  const answer = await sourceRpc<{ value: number }>('solana', 'getBalance', [address, { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(answer.value) || answer.value < 0) throw new QuoteUnavailable('source_unavailable');
  return BigInt(answer.value);
}

async function freshBlockhash(): Promise<string> {
  const result = await sourceRpc<{ value: { blockhash: string } }>('solana', 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  if (!result.value?.blockhash) throw new QuoteUnavailable('source_unavailable');
  return result.value.blockhash;
}

async function solanaGas(env: Env, row: SweepFlight, price: number): Promise<'ready' | 'pending' | 'unavailable'> {
  const wallet = gasWallet(env, 'solana');
  if (wallet.address !== row.gas_wallet_address) return 'unavailable';
  const account = await sourceRpc<{ value: { owner: string; lamports: number; space: number } | null }>('solana',
    'getAccountInfo', [row.destination, { encoding: 'base64', commitment: 'confirmed' }]);
  if (account.value && (account.value.owner !== TOKEN_PROGRAM || account.value.space !== 165)) return 'unavailable';
  if (!account.value) {
    if (row.creation_tx_hash) {
      const state = await final('solana', row.creation_tx_hash);
      if (state === 'pending') {
        if (row.creation_signed_tx) await broadcast('solana', { hash: row.creation_tx_hash, encoded: row.creation_signed_tx });
        return 'pending';
      }
      if (state === 'failed') {
        const receipt = await sourceRpc<{ meta?: { fee?: number } } | null>('solana', 'getTransaction',
          [row.creation_tx_hash, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
        if (receipt?.meta?.fee !== undefined)
          await expense(env, row, 'source_gas', row.creation_tx_hash, BigInt(receipt.meta.fee), price);
        return 'unavailable';
      }
      // A finalized create must reveal the promised token account before proceeding.
      return 'pending';
    }
    if (!row.creation_message || BigInt(row.native_rent_units) === 0n) return 'unavailable';
    const message = solanaCreateAtaMessage(wallet.address, row.provider_wallet, row.destination,
      await freshBlockhash());
    const [rent, creationFee] = await Promise.all([
      sourceRpc<number>('solana', 'getMinimumBalanceForRentExemption', [165, { commitment: 'confirmed' }]),
      sourceRpc<{ value: number | null }>('solana', 'getFeeForMessage',
        [btoa(String.fromCharCode(...message)), { commitment: 'confirmed' }]),
    ]);
    if (!Number.isSafeInteger(rent) || rent <= 0 || !Number.isSafeInteger(creationFee.value) ||
      !creationFee.value || creationFee.value <= 0) return 'unavailable';
    const liveRent = BigInt(rent) + BigInt(creationFee.value);
    if (await solanaBalance(wallet.address) < liveRent ||
      !await reserveLive(env, row, row.estimated_gas_micros,
        micros('solana', liveRent, price))) return 'unavailable';
    const signed = signedSolanaGasTransaction(wallet.secret, message);
    await saveTransaction(env.DB, row.route_id, 'creation', signed);
    await broadcast('solana', signed);
    return 'pending';
  }
  if (row.creation_tx_hash) {
    const receipt = await sourceRpc<{ meta?: { fee?: number; preBalances?: number[]; postBalances?: number[] } } | null>('solana', 'getTransaction',
      [row.creation_tx_hash, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    const before = receipt?.meta?.preBalances?.[0];
    const after = receipt?.meta?.postBalances?.[0];
    if (before !== undefined && after !== undefined && Number.isSafeInteger(before) &&
      Number.isSafeInteger(after) && before > after) {
      await expense(env, row, 'source_account_rent', row.creation_tx_hash, BigInt(before - after), price);
      await env.DB.prepare('UPDATE any_chain_sweeps SET estimated_rent_micros = 0 WHERE route_id = ?')
        .bind(row.route_id).run();
      row.estimated_rent_micros = 0;
    } else return 'unavailable';
  }
  const balance = await solanaBalance(row.refund_recipient);
  const needed = BigInt(row.native_funding_units) > balance ? BigInt(row.native_funding_units) - balance : 0n;
  if (row.funding_tx_hash) {
    const state = await final('solana', row.funding_tx_hash);
    if (state === 'pending') {
      if (row.funding_signed_tx) await broadcast('solana', { hash: row.funding_tx_hash, encoded: row.funding_signed_tx });
      return 'pending';
    }
    const receipt = await sourceRpc<{ meta?: { fee?: number } } | null>('solana', 'getTransaction',
      [row.funding_tx_hash, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    if (receipt?.meta?.fee !== undefined)
      await expense(env, row, 'source_gas', row.funding_tx_hash, BigInt(receipt.meta.fee), price);
    if (state === 'failed') return 'unavailable';
    return 'ready';
  }
  if (needed === 0n) return 'ready';
  const message = solanaFundMessage(wallet.address, row.refund_recipient, needed, await freshBlockhash());
  const fee = await sourceRpc<{ value: number | null }>('solana', 'getFeeForMessage',
    [btoa(String.fromCharCode(...message)), { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(fee.value) || !fee.value || fee.value <= 0 ||
    await solanaBalance(wallet.address) < needed + BigInt(fee.value) ||
    micros('solana', BigInt(row.native_funding_units) + BigInt(fee.value), price) > row.sponsor_cap_micros ||
    !await budget(env, row, row.estimated_gas_micros + row.estimated_rent_micros)) return 'unavailable';
  const signed = signedSolanaGasTransaction(wallet.secret, message);
  await saveTransaction(env.DB, row.route_id, 'funding', signed);
  await broadcast('solana', signed);
  return 'pending';
}

/** Idempotent progression: every signed transaction is recorded before broadcast and retried by its original hash. */
export async function advanceSweep(env: Env, routeId: string): Promise<'signed' | 'awaiting_gas' | 'broadcasting' | 'sent' | 'failed'> {
  const row = await env.DB.prepare('SELECT * FROM any_chain_sweeps WHERE route_id = ?').bind(routeId).first<SweepFlight>();
  if (!row) throw new QuoteUnavailable('quote_missing');
  if (row.near_tx_hash && await recordFinalNearExpense(env, { id: `near:signer:${row.near_tx_hash}`,
    routeId, kind: 'near_signer_gas', txHash: row.near_tx_hash, signer: env.SERVER_ACCOUNT_ID }))
    await env.DB.prepare('UPDATE any_chain_sweeps SET near_signer_reserve_micros = 0 WHERE route_id = ?').bind(routeId).run();
  if (row.state === 'sent' || row.state === 'failed') return row.state;
  if (!['signed', 'awaiting_gas', 'broadcasting'].includes(row.state) || !row.mpc_response)
    return 'signed';
  const price = await nativePrice(row.chain);
  if (row.source_tx_hash) {
    const state = await final(row.chain, row.source_tx_hash);
    if (state === 'pending') {
      if (row.source_signed_tx) await broadcast(row.chain, { hash: row.source_tx_hash, encoded: row.source_signed_tx });
      return 'broadcasting';
    }
    if (row.chain === 'base') {
      const receipt = await sourceRpc<{ gasUsed: string; effectiveGasPrice: string }>('base',
        'eth_getTransactionReceipt', [row.source_tx_hash]);
      await expense(env, row, 'source_gas', row.source_tx_hash,
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), price);
    } else {
      const receipt = await sourceRpc<{ meta?: { fee?: number } } | null>('solana', 'getTransaction',
        [row.source_tx_hash, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      if (receipt?.meta?.fee !== undefined)
        await expense(env, row, 'source_gas', row.source_tx_hash, BigInt(receipt.meta.fee), price);
    }
    if (state === 'failed') {
      await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'failed', updated_at = ? WHERE route_id = ?")
        .bind(Date.now(), routeId).run();
      await recordAnyChainEvent(env, { name: 'cross_chain_feed_stalled', key: `${routeId}:source_failed`,
        routeId, tokenId: row.token_id, fields: { route: 'pet_address', reason: 'source_failed',
          projectUsd: await routeProjectUsd(env.DB, routeId) } });
      return 'failed';
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE any_chain_sweeps SET state = 'sent', updated_at = ? WHERE route_id = ?")
        .bind(Date.now(), routeId),
      env.DB.prepare("UPDATE any_chain_deposits SET state = 'converting' WHERE id = ? AND state IN ('waiting', 'below_minimum')")
        .bind(row.deposit_id),
    ]);
    return 'sent';
  }
  const liveGasMicros = micros(row.chain, BigInt(row.native_gas_units), price);
  const liveRentMicros = row.estimated_rent_micros === 0 ? 0 : micros(row.chain, BigInt(row.native_rent_units), price);
  if (liveGasMicros > row.sponsor_cap_micros ||
    !await reserveLive(env, row, liveGasMicros, liveRentMicros)) {
    await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'awaiting_gas' WHERE route_id = ? AND state <> 'broadcasting'")
      .bind(routeId).run();
    await recordAnyChainEvent(env, { name: 'cross_chain_feed_stalled', key: `${routeId}:source_gas_cap`,
      routeId, tokenId: row.token_id, fields: { route: 'pet_address', reason: 'source_gas_cap',
        projectUsd: await routeProjectUsd(env.DB, routeId) } });
    return 'awaiting_gas';
  }
  if (row.chain === 'solana') {
    const meta = JSON.parse(row.source_meta_json) as { blockhash?: string };
    const valid = await sourceRpc<{ value: boolean }>('solana', 'isBlockhashValid',
      [meta.blockhash, { commitment: 'confirmed' }]);
    if (!valid.value) {
      await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'failed', updated_at = ? WHERE route_id = ? AND source_tx_hash IS NULL")
        .bind(Date.now(), routeId).run();
      return 'failed';
    }
  }
  const gas = row.chain === 'base' ? await baseGas(env, row, price) : await solanaGas(env, row, price);
  if (gas === 'unavailable') {
    await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'awaiting_gas' WHERE route_id = ? AND source_tx_hash IS NULL")
      .bind(routeId).run();
    await recordAnyChainEvent(env, { name: 'cross_chain_feed_stalled', key: `${routeId}:source_gas_unavailable`,
      routeId, tokenId: row.token_id, fields: { route: 'pet_address', reason: 'source_gas_unavailable',
        projectUsd: await routeProjectUsd(env.DB, routeId) } });
    return 'awaiting_gas';
  }
  if (gas === 'pending') return 'broadcasting';
  if (!row.source_tx_hash) {
    if (await sourceBalance(row.chain, row.refund_recipient) < BigInt(row.amount_units)) {
      await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'failed' WHERE route_id = ? AND source_tx_hash IS NULL")
        .bind(routeId).run();
      return 'failed';
    }
    const signed = signedPetSource(row.chain, row.payload_hex, row.mpc_response,
      row.refund_recipient, row.destination, BigInt(row.amount_units), row.source_meta_json);
    await saveTransaction(env.DB, routeId, 'source', signed);
    await broadcast(row.chain, signed);
    return 'broadcasting';
  }
  return 'broadcasting';
}

/** A provider result is a lead only; an origin refund or NEAR food needs its own finalized transfer proof. */
export async function reconcileSweepProvider(env: Env, routeId: string): Promise<'sent' | 'refunded' | 'food'> {
  const row = await env.DB.prepare('SELECT * FROM any_chain_sweeps WHERE route_id = ?').bind(routeId).first<SweepFlight>();
  if (!row || !['sent', 'refunded', 'food'].includes(row.state) || !row.source_tx_hash) return 'sent';
  if (row.near_tx_hash && await recordFinalNearExpense(env, { id: `near:signer:${row.near_tx_hash}`,
    routeId, kind: 'near_signer_gas', txHash: row.near_tx_hash, signer: env.SERVER_ACCOUNT_ID }))
    await env.DB.prepare('UPDATE any_chain_sweeps SET near_signer_reserve_micros = 0 WHERE route_id = ?').bind(routeId).run();
  if (row.state === 'food') {
    const credit = await env.DB.prepare('SELECT credit_id FROM any_chain_delivery_evidence WHERE route_id = ? AND credit_id IS NOT NULL LIMIT 1')
      .bind(routeId).first<{ credit_id: number }>();
    if (credit) await recordCreditEvents(env, routeId, credit.credit_id);
    return 'food';
  }
  if (row.state === 'refunded') {
    const quote = JSON.parse(row.quote_json) as { quote?: { refundFee?: string } };
    await recordAnyChainEvent(env, { name: 'cross_chain_feed_refunded', key: routeId, routeId,
      tokenId: row.token_id, fields: { route: 'pet_address', feeUsd: usdcFee(quote.quote?.refundFee) } });
    return 'refunded';
  }
  let memo: string | null = null;
  try { memo = (JSON.parse(row.quote_json) as { quote?: { depositMemo?: string } }).quote?.depositMemo ?? null; }
  catch { return 'sent'; }
  const status = await providerStatus(row.provider_wallet, memo);
  const echo = status.quoteResponse?.quoteRequest;
  if (!echo || echo.originAsset !== ORIGINS[row.chain] || echo.destinationAsset !== 'nep141:wrap.near' ||
    echo.refundTo !== row.refund_recipient || echo.recipient !== env.CONTRACT_ID ||
    echo.customRecipientMsg !== JSON.stringify({ token_id: row.token_id, route: routeId, kind: 'pet_address' }) ||
    !status.swapDetails?.originChainTxHashes?.some((item) => item.hash === row.source_tx_hash)) return 'sent';
  const nearHashes = [...new Set([...(status.swapDetails.nearTxHashes ?? []),
    ...(status.swapDetails.destinationChainTxHashes ?? []).map((item) => item.hash)])];
  const deliveries = (await readDeliveries(env, nearHashes)).filter((item) =>
    item.routeId === routeId && item.tokenId === row.token_id && item.credited && item.creditId !== null);
  if (deliveries.length) {
    const first = deliveries[0]!;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO any_chain_delivery_evidence
        (receipt_id, route_id, token_id, near_tx_hash, amount_yocto, kind, credit_id, unwrap_failed,
         held_id, held_reason, recorded_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, ?)`)
        .bind(first.receiptId, routeId, row.token_id, first.nearTxHash, first.amount, first.creditId, Date.now()),
      env.DB.prepare(`INSERT OR IGNORE INTO any_chain_credit_evidence
        (credit_id, near_tx_hash, amount_yocto, recorded_at, was_asleep)
        VALUES (?, ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM pets WHERE token_id = ? AND slept_at IS NOT NULL) THEN 1 ELSE 0 END)`)
        .bind(first.creditId, first.nearTxHash, first.amount, Date.now(), row.token_id),
      env.DB.prepare("UPDATE any_chain_sweeps SET state = 'food', updated_at = ? WHERE route_id = ? AND state = 'sent'")
        .bind(Date.now(), routeId),
      env.DB.prepare("UPDATE any_chain_deposits SET state = 'food', near_credit_tx = ?, resolved_at = ? WHERE id = ?")
        .bind(first.nearTxHash, Date.now(), row.deposit_id),
    ]);
    await recordCreditEvents(env, routeId, first.creditId!);
    return 'food';
  }
  const refunded = status.swapDetails.refundedAmount;
  if (!refunded || !/^\d+$/.test(refunded) || BigInt(refunded) === 0n) return 'sent';
  for (const candidate of status.swapDetails.originChainTxHashes ?? []) {
    if (candidate.hash === row.source_tx_hash) continue;
    let proof;
    try { proof = await verifiedSource(row.chain, candidate.hash, row.refund_recipient, refunded); }
    catch { continue; }
    if (!proof || proof.recipient.toLowerCase() !== row.refund_recipient.toLowerCase()) continue;
    await env.DB.batch([
      env.DB.prepare("UPDATE any_chain_sweeps SET state = 'refunded', updated_at = ? WHERE route_id = ? AND state = 'sent'")
        .bind(Date.now(), routeId),
      env.DB.prepare("UPDATE any_chain_deposits SET state = 'refunded', source_refund_tx = ?, resolved_at = ? WHERE id = ?")
        .bind(candidate.hash, Date.now(), row.deposit_id),
    ]);
    const quote = JSON.parse(row.quote_json) as { quote?: { refundFee?: string } };
    await recordAnyChainEvent(env, { name: 'cross_chain_feed_refunded', key: routeId, routeId,
      tokenId: row.token_id, fields: { route: 'pet_address', feeUsd: usdcFee(quote.quote?.refundFee) } });
    return 'refunded';
  }
  return 'sent';
}
