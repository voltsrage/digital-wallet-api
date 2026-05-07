/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    await knex.schema.createTable('outbox_events', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.string('event_type', 100).notNullable();
        t.jsonb('payload').notNullable();
        t.boolean('processed').notNullable().defaultTo(false);
        t.timestamp('created_at', {useTz: true}).notNullable().defaultTo(knex.fn.now());
    });  

    // Partial index: only indexes rows where processed = false.
    // After processing, rows are effectively invisible to this index — it never grows
    // with historical processed events. The poller query hits only pending rows.
    await knex.schema.raw('CREATE INDEX idx_outbox_unprocessed ON outbox_events (processed, created_at) WHERE processed = false')
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    await knex.schema.dropTable('outbox_events');
};
