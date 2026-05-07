import 'dotenv/config';
import Knex from 'knex';

/*
    The application imports `knex` from here. 
    The `knexfile.js` is only for the CLI. They share the same config values — 
    if they diverge, migrations and application queries run against 
    different pool settings.
*/

const config = {
    client: 'pg',
    connection: process.env.POSTGRES_URL,
    pool: { min: 2, max: 20}
}

export const knex = Knex(config);