/**
 * Publica uma mensagem de exemplo na fila wager-transactions.fifo (demo).
 * Uso: bun run scripts/send-wager-message.ts <walletId> <playerId> [BET|WIN|LOSS] [amount]
 * Rode duas vezes com o mesmo MESSAGE_ID=... para ver o inbox deduplicar.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { SqsGateway } from '../src/infrastructure/messaging/sqs-gateway';

const [walletId, playerId, kind = 'BET', amount = '10.00'] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('uso: bun run scripts/send-wager-message.ts <walletId> <playerId> [kind] [amount]');
  process.exit(1);
}
const config = loadConfig();
const sqs = new SqsGateway(config.aws);
const externalTransactionId = process.env.EXTERNAL_ID ?? `tx-${randomUUID()}`;
const messageId = process.env.MESSAGE_ID ?? `msg-${randomUUID()}`;

await sqs.send(
  config.queues.wager,
  JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId,
      walletId,
      roundId: 'round-demo',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
    },
  }),
  { groupId: walletId, deduplicationId: randomUUID() },
);
console.log(JSON.stringify({ sent: true, messageId, externalTransactionId }));
sqs.close();
