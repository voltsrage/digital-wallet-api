import 'dotenv/config';
import {app} from './app.js';
import {knex} from './db/knex.js';
import {connectMongo} from './db/mongo.js';
import {redis} from './db/redis.js';
import { logger } from './utils/logger.js';
import {startOutboxPoller} from './services/outboxPoller.js';


const PORT =  process.env.PORT || 3095;

async function start() {
    await knex.raw('SELECT 1');
    await connectMongo();

    if(process.env.NODE_ENV !== 'test'){
        startOutboxPoller();
    }

    app.listen(PORT, () => logger.info({port: PORT}, 'Server started'));
}

start().catch(err => {
    logger.fatal(err, 'Failed to start server');
    process.exit(1);
});