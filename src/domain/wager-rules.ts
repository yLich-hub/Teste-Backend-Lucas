import { FailureCode } from './errors';
import { WagerTransaction, WagerTransactionStatus } from './wager-transaction';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';

/** O que fazer com a transação. Função pura: não toca em banco nem altera nada. */
export type WagerDecision =
  | { type: 'apply'; direction: LedgerDirection } // move saldo + 1 lançamento
  | { type: 'record' } // LOSS: PROCESSED sem mover saldo
  | { type: 'reject'; code: FailureCode }
  | { type: 'wait-reference' }; // referência ainda não chegou

export interface WagerRulesInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** transação referenciada, buscada por (providerId, referenceExternalTransactionId) */
  reference?: WagerTransaction;
  /** a referência já foi revertida (REFUND/ROLLBACK PROCESSED) por outra transação? */
  referenceAlreadyReversed: boolean;
}

/**
 * Regras de negócio da seção 7 do README, em ordem de verificação.
 * Fica no domínio para ser testada em unidade, sem banco.
 */
export function decideWager(input: WagerRulesInput): WagerDecision {
  const { wallet, transaction: tx, reference, referenceAlreadyReversed } = input;

  // 1. A operação precisa ser da mesma moeda e do mesmo jogador da wallet.
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerMismatch);

  // 2. Validação da referência (quando existe).
  if (tx.referenceExternalTransactionId) {
    if (!reference) return { type: 'wait-reference' };

    const sameContext =
      reference.walletId === tx.walletId &&
      reference.playerId === tx.playerId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameContext) return reject(FailureCode.ReferenceMismatch);

    if (!tx.allowedReferenceKinds().includes(reference.kind)) {
      return reject(FailureCode.InvalidReferenceKind);
    }

    // A referência também pode estar esperando a dela (cadeia fora de ordem).
    if (
      reference.status === WagerTransactionStatus.PendingReference ||
      reference.status === WagerTransactionStatus.Pending
    ) {
      return { type: 'wait-reference' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }

    if (tx.isReversal()) {
      if (!tx.money.equals(reference.money)) return reject(FailureCode.AmountMismatch);
      if (referenceAlreadyReversed) return reject(FailureCode.AlreadyReversed);
    }
  }

  // 3. LOSS: registra sem mexer no saldo.
  const direction = tx.ledgerDirectionFor(reference);
  if (!direction) return { type: 'record' };

  // 4. Débito não pode deixar saldo negativo. Aposta e reversão têm códigos distintos.
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
    return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }

  return { type: 'apply', direction };
}

function reject(code: FailureCode): WagerDecision {
  return { type: 'reject', code };
}
