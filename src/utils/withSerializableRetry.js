const MAX_RETRIES = 3;
const PG_SERIALIZATION_FAILURE= '40001';
const PG_UNIQUE_VIOLATION = '23505';

// Wraps async function in a retry loop for SERIALIZABLE conflicts
// Rethrows immediately on any other error

export async function withSerializableRetry(fn){
    let lastError;
    for(let attempt = 0; attempt < MAX_RETRIES; attempt++){
        try{
            return await fn();
        }catch(err){
            if(err.code === PG_SERIALIZATION_FAILURE){
                lastError = err;
                continue;
            }
            throw err;
        }
    }
    // Exhausted retries - the system us under heavy contention on this account pair.
    // Surface as a 503 so the client knows to retry, not a 500 (which implies a bug)

    const retryError = new Error('Transaction could not be completed due to high contention. Please retry');
    retryError.statusCode = 503;
    retryError.code = 'SERIALIZATION_FAILURE';
    throw retryError;
}

export {PG_UNIQUE_VIOLATION};