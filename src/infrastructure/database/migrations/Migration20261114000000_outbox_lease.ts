import { Migration } from '@mikro-orm/migrations';

/**
 * Lease na outbox: em vez de segurar a transação aberta enquanto chama o SQS,
 * o publisher "aluga" um lote por alguns segundos (locked_by + locked_until),
 * commita, publica FORA da transação e depois marca published_at.
 * Se o processo morrer, o aluguel vence e outra instância pega o lote.
 */
export class Migration20261114000000_outbox_lease extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table outbox_messages
        add column locked_by    text,
        add column locked_until timestamptz,
        add constraint outbox_lease_complete check ((locked_by is null) = (locked_until is null));
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table outbox_messages
        drop constraint if exists outbox_lease_complete,
        drop column if exists locked_until,
        drop column if exists locked_by;
    `);
  }
}
