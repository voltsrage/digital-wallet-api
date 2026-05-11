/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */

// Role is required for admin route checks
export async function up(knex) {
    await knex.schema.table('users', (t) => {
        t.string('role', 20).notNullable().defaultTo('user');
    })
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex)  {
    await knex.schema.table('users', (t) => {
        t.dropColumn('role');
    })
};
