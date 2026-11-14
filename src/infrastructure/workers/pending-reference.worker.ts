import { ProcessWagerService } from '../../application/process-wager.service';
import { Database, isTransientDbError } from '../database/database';
import { errorInfo, JsonLogger } from '../observability/logger';

/**
 * Worker agendado que re-tenta transações PENDING_REFERENCE cuja próxima
 * checagem venceu (backoff exponencial calculado no domínio).
 * Várias instâncias podem rodar: cada tentativa trava a wallet e relê o
 * status, então a mesma transação nunca é aplicada duas vezes.
 */
export class PendingReferenceWorker {
  constructor(
    private readonly db: Database,
    private readonly processWager: ProcessWagerService,
    private readonly logger: JsonLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Devolve true se o lote veio cheio (provavelmente há mais trabalho). */
  async runOnce(batchSize = 50): Promise<boolean> {
    const ids = await this.db.transactions.findDuePendingReference(this.clock(), batchSize);
    for (const id of ids) {
      try {
        await this.processWager.retryPendingReference(id);
      } catch (err) {
        if (isTransientDbError(err)) {
          this.logger.warn('pending reference retry failed (transient)', { transactionId: id, ...errorInfo(err) });
          continue; // tenta no próximo ciclo
        }
        // Erro inesperado e permanente: FAILED (terminal, fica auditável).
        this.logger.error('pending reference retry failed (permanent)', { transactionId: id, ...errorInfo(err) });
        await this.processWager.failPending(id);
      }
    }
    return ids.length === batchSize;
  }
}
