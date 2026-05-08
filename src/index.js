import 'dotenv/config';
import {app} from './app.js';
import {knex} from './db/knex.js';
import {connectMongo} from './db/mongo.js';
import {redis} from './db/redis.js';
import { logger } from './utils/logger.js';

const PORT =  process.env.PORT || 3095;

async function start() {
    await knew.raw('SELECT 1');
    await connectMongo();

    app.listen(PORT, () => logger.info({port: PORT}, 'Server started'));
}

start().catch(err => {
    logger.error(err, 'Failed to start server');
    process.exit(1);
});