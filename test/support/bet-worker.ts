/**
 * Processo independente (outra "instância" da aplicação) usado no teste de
 * concorrência multi-processo. Recebe uma lista de apostas por argv, envia
 * todas em paralelo pelo mesmo use case e imprime os resultados em JSON.
 */
import { ProcessWagerService } from '../../src/application/process-wager.service';
import { parseWagerCommand } from '../../src/application/wager-command';
import { loadConfig } from '../../src/config';
import { Database } from '../../src/infrastructure/database/database';
import { JsonLogger } from '../../src/infrastructure/observability/logger';
import { Metrics } from '../../src/infrastructure/observability/metrics';

const bets = JSON.parse(process.argv[2]!) as any[];
const db = await Database.connect({ url: loadConfig().databaseUrl, poolMax: 10, lockTimeoutMs: 10_000 });
const service = new ProcessWagerService(db, new Metrics(), new JsonLogger('error'));

// embaralha para cada processo chegar numa ordem diferente
const shuffled = [...bets].sort(() => Math.random() - 0.5);
const results = await Promise.all(
  shuffled.map(async (b) => {
    const out = await service.execute(parseWagerCommand(b, `${b.providerId}:${b.externalTransactionId}`), {
      correlationId: `pid-${process.pid}`,
      source: 'http',
    });
    if (out.duplicateMessage) throw new Error('unexpected');
    return { transactionId: out.transactionId, status: out.status, idempotentReplay: out.idempotentReplay };
  }),
);
await db.close();
console.log(JSON.stringify(results));
