/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    await knex.schema.createTable('users', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.string('email', 255).notNullable();
        t.string('password_hash', 255).notNullable();
        t.string('display_name', 100).defaultTo(null);
        t.string('status', 20).notNullable().defaultTo('active');  // active | locked | suspended
        t.integer('failed_login_count').notNullable().defaultTo(0);
        t.timestamp('locked_until', {useTz: true}).defaultTo(null);
        t.timestamp('created_at', {useTz: true}).notNullable().defaultTo(knex.fn.now());
        t.timestamp('updated_at',{useTz: true}).notNullable().defaultTo(knex.fn.now());
    });

    await knex.schema.raw('CREATE UNIQUE INDEX idx_users_email ON users (email)');
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    await knex.schema.dropTable('users');
};
