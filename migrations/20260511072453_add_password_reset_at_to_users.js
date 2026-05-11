/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    await knex.schema.table('users', (t) => {
        t.timestamp('password_reset_at', {useTz: true}).defaultTo(null);
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex){
    await knex.schema.table('users', (t) => {
        t.dropColumn('password_reset_at');
    })
};
