/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    await knex.schema.createTable('ledger_entries', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('account_id').notNullable().references('id').inTable('accounts').onDelete('RESTRICT');
        t.uuid('transfer_id').notNullable().references('id').inTable('transfers').onDelete('RESTRICT');
        t.string('type', 10).notNullable(); // debit | credit
        t.decimal('amount', 18, 8).notNullable();
        // balance_after: snapshot of the account balance immediately after this entry.
        // Storing this avoids summing the entire ledger to reconstruct point-in-time balances.
        // The reconciliation job verifies this snapshot stays in sync with the running sum.
        t.decimal('balance_after', 18, 8).notNullable();
        t.timestamp('created_at', {useTz: true}).notNullable().defaultTo(knex.fn.now());
    });
    
    // Primary query pattern: all entries for an account ordered by time (ledger history page).
    await knex.schema.raw('CREATE INDEX idx_ledger_account_time ON ledger_entries (account_id, created_at DESC)');
    await knex.schema.raw('CREATE INDEX idx_ledger_transfer ON ledger_entries (transfer_id)')
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    await knex.schema.dropTable('ledger_entries');  
};
