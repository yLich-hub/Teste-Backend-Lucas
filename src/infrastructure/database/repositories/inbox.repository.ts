import type { SqlRunner } from '../database';
import { InboxPayloadMismatchError } from '../../../application/errors';
import { InboxMessage } from '../../../domain/inbox-message';

export class InboxRepository {
  constructor(private readonly db: SqlRunner) {}

  /**
   * Tenta registrar a mensagem. Devolve `false` se ela já foi registrada
   * (duplicata). Funciona entre instâncias porque a PK (consumer_name, message_id)
   * é única: se duas instâncias inserirem ao mesmo tempo, a segunda espera a
   * primeira terminar e então cai no ON CONFLICT DO NOTHING.
   */
  async tryInsert(msg: InboxMessage): Promise<boolean> {
    const inserted = await this.db.query(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [msg.consumerName, msg.messageId, msg.payloadHash, msg.receivedAt, msg.processedAt ?? null],
    );
    if (inserted.length === 1) return true;

    const [existing] = await this.db.query(
      'select payload_hash from inbox_messages where consumer_name = ? and message_id = ?',
      [msg.consumerName, msg.messageId],
    );
    if (existing && existing.payload_hash !== msg.payloadHash) {
      throw new InboxPayloadMismatchError(msg.messageId);
    }
    return false;
  }
}
