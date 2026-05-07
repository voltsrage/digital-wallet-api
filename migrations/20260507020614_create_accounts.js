/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up (knex) {
    await knex.schema.createTable('accounts', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
        t.string('account_number', 20).notNullable();
        t.string('currency', 3).notNullable().defaultTo('USD');
        // DECIMAL(18,8): 18 total digits, 8 decimal places. Never FLOAT.
        // 0.1 + 0.2 in IEEE 754 floating point = 0.30000000000000004.
        // On millions of transactions, rounding errors accumulate into real money.
        t.decimal('balance', 18, 8).notNullable().defaultTo(0);
        t.string('status', 20).notNullable().defaultTo('active'); // active | frozen | closed
        t.decimal('daily_limit', 18, 8).notNullable().defaultTo(10000);
        // Optimistic lock counter: incremented on every balance update.
        // Used to detect concurrent writes without holding a lock.
        t.integer('version').notNullable().defaultTo(0);
        t.timestamp('created_at',{useTz: true}).notNullable().defaultTo(knex.fn.now());
        t.timestamp('updated_at', {useTz: true}).notNullable().defaultTo(knex.fn.now());
    });

    await knex.schema.raw('CREATE UNIQUE INDEX idx_accounts_number ON accounts (account_number)');
    await knex.schema.raw('CREATE INDEX idx_account_user_id ON accounts (user_id)');
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    await knex.schema.dropTable('accounts');  
};
