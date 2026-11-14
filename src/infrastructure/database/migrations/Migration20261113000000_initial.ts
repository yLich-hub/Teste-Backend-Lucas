import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias financeiras ficam NO BANCO, não só no código:
 *
 *  - unicidade:      1 wallet por (player_id, currency); idempotência por
 *                    (provider_id, idempotency_key) e (provider_id, external_transaction_id);
 *                    no máx. 1 lançamento por (wallet_id, transaction_id);
 *                    cada transação só pode ser revertida 1 vez (índice único parcial);
 *                    inbox com PK (consumer_name, message_id).
 *  - não-negatividade: CHECK (balance >= 0) e CHECKs nos valores do ledger.
 *  - imutabilidade: triggers bloqueiam UPDATE/DELETE/TRUNCATE no ledger e
 *                    qualquer mudança de uma transação em estado terminal.
 *  - consistência:   constraint trigger (verificada no COMMIT) garante que o
 *                    saldo da wallet == balance_after do último lançamento.
 */
export class Migration20261113000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   text not null,
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) not null check (balance >= 0),
        version     integer not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                                uuid primary key,
        provider_id                       text not null,
        external_transaction_id           text not null,
        idempotency_key                   text not null,
        payload_hash                      char(64) not null,
        wallet_id                         uuid not null references wallets(id),
        player_id                         text not null,
        round_id                          text not null,
        game_id                           text not null,
        kind                              text not null
          check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) not null check (amount >= 0),
        currency                          char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id          uuid references wager_transactions(id),
        status                            text not null
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        balance_after                     numeric(20,2) check (balance_after >= 0),
        reference_attempts                integer not null default 0,
        next_reference_check_at           timestamptz,
        created_at                        timestamptz not null,
        processed_at                      timestamptz,
        constraint wager_tx_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_tx_external_id_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_reversal_needs_reference
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_failure_code_when_rejected
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_pending_has_next_check
          check (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null)
      );
    `);
    // Uma transação só pode ser revertida (REFUND/ROLLBACK) uma única vez.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
    // Fila do worker de referências pendentes.
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        seq             bigserial not null unique, -- ordem de inserção: base do cursor de paginação
        id              uuid primary key,
        wallet_id       uuid not null references wallets(id),
        transaction_id  uuid not null references wager_transactions(id),
        direction       text not null check (direction in ('DEBIT','CREDIT')),
        amount          numeric(20,2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(20,2) not null check (balance_before >= 0),
        balance_after   numeric(20,2) not null check (balance_after >= 0),
        created_at      timestamptz not null,
        constraint ledger_one_entry_per_transaction unique (wallet_id, transaction_id),
        constraint ledger_entry_is_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);`);

    // Ledger append-only.
    this.addSql(`
      create function forbid_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% blocked)', tg_op
          using errcode = 'P0001';
      end $$;
    `);
    this.addSql(`
      create trigger ledger_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation();
    `);
    this.addSql(`
      create trigger ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation();
    `);

    // Transação terminal (PROCESSED/REJECTED/FAILED) não muda mais; nenhuma é apagada.
    this.addSql(`
      create function forbid_terminal_transaction_change() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions cannot be deleted';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status;
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger wager_tx_terminal_is_final
        before update or delete on wager_transactions
        for each row execute function forbid_terminal_transaction_change();
    `);

    // Saldo materializado == último balance_after do ledger, checado no COMMIT
    // (deferrable), quando wallet e lançamento já foram gravados.
    this.addSql(`
      create function check_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        last_balance numeric(20,2);
      begin
        select balance_after into last_balance
          from wallet_ledger_entries
         where wallet_id = new.id
         order by seq desc
         limit 1;
        if coalesce(last_balance, 0) <> new.balance then
          raise exception 'wallet % balance % does not match ledger %', new.id, new.balance, coalesce(last_balance, 0)
            using errcode = '23514';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`
      create constraint trigger wallet_balance_matches_ledger
        after insert or update of balance on wallets
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   char(64) not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     text not null,
        event_type       text not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz
      );
    `);
    this.addSql(`
      create index outbox_pending_idx on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
    this.addSql('drop function if exists check_wallet_matches_ledger();');
    this.addSql('drop function if exists forbid_terminal_transaction_change();');
    this.addSql('drop function if exists forbid_ledger_mutation();');
  }
}
