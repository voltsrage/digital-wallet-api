import 'dotenv/config';
import { Connection } from 'pg';

export default {
    development: {
        client: 'pg',
        connection: process.env.POSTGRES_URL,
        migrations:{
            directory: './migrations',
            extension: 'js'
        },
        pool: {min: 2, max: 10}
    },
    production: {
        client: 'pg',
        connection: process.env.POSTGRES_URL,
        migrations:{
            directory: './migrations',
            extension: 'js'
        },
        pool: {min: 2, max: 20}
    }
};