/** Public pointer fields shared by the Worker response and the browser's chain check. */
export interface PointerCall {
  n: number; req_sha256: string; res_sha256: string; signature: string;
  sig_kind: string; signer: string; tokens_in: number; tokens_out: number;
  tokens_reasoning: number; cut: number | boolean; label?: string | null;
  completion_id?: string | null;
}

export interface ThoughtPointer {
  id: string; tokenId: string; payingTokenId: string | null;
  kind?: string;
  status: string; debitTxHash: string | null; at: number;
  model: string; priceYocto: string; nearUsdRate: string | null;
  workerTokenId: string | null; skilled: boolean; adapterUsed: boolean;
  erased: boolean; calls: PointerCall[];
  form?: 'read' | 'find' | 'check' | null; searches?: number | null; dataLabels?: string[] | null;
  fee?: { fee_yocto: string; fee_usd_micros: number } | null;
  privateCalls?: Array<{ n: number; requestBase64: string | null; replyBase64: string | null }>;
}
