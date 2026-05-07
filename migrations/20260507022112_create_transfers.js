/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    await knex.schema.createTable('transfers', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('from_account_id').notNullable().references('id').inTable('accounts').onDelete('RESTRICT');
        t.uuid('to_account_id').notNullable().references('id').inTable('accounts').onDelete('RESTRICT');
        t.decimal('amount', 18, 8).notNullable();
        t.string('currency', 3).notNullable();
        t.string('description', 500).defaultTo(null);
        t.string('status', 20).notNullable().defaultTo('pending'); // pending | completed | failed | reversed
        t.string('idempotency_key', 255).notNullable();
        t.timestamp('created_at', {useTz: true}).notNullable().defaultTo(knex.fn.now());
    })  

    // Unique on idempotency_key: the database enforces that no two transfers share a key,
    // even if two concurrent requests race past the application-level check.
    await knex.schema.raw('CREATE UNIQUE INDEX idx_transfers_idempotency ON transfers (idempotency_key)');

    // Compound index on (from_account_id, created_at DESC): satisfies the ledger history
    // query exactly — filter by account, sort by time, no additional sort step needed.
    await knex.schema.raw('CREATE INDEX idx_transfers_from_acct ON transfers(from_account_id, created_at DESC)');
    await knex.schema.raw('CREATE INDEX idx_transfers_to_acct ON transfers (to_account_id, created_at DESC)');
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    await knex.schema.dropTable('transfers');
};
