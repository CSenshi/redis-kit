/**
 * Lua script for atomically acquiring a lock.
 * 
 * Sets the lock only if it doesn't exist with the specified TTL.
 * 
 * @param KEYS[1] - Lock key name
 * @param ARGV[1] - Token value to store
 * @param ARGV[2] - TTL in milliseconds
 * 
 * @returns 1 if lock was successfully acquired, 0 if lock already exists
 * 
 * @public
 */
export const ACQUIRE_SCRIPT = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
    return 1
else
    return 0
end
`.trim();

/**
 * Lua script for atomically releasing a lock.
 * 
 * Verifies token ownership before deleting the lock to prevent unauthorized releases. 
 * Only the process with the correct token can release the lock.
 * 
 * @param KEYS[1] - Lock key name
 * @param ARGV[1] - Expected token value for ownership verification
 * 
 * @returns 1 if lock was successfully released, 0 if token doesn't match or lock doesn't exist
 * 
 * @public
 */
export const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
`.trim();

/**
 * Lua script for atomically extending a lock's TTL.
 * 
 * Verifies token ownership before updating the expiration time.
 * Only the process with the correct token can extend the lock.
 * 
 * @param KEYS[1] - Lock key name
 * @param ARGV[1] - Expected token value for ownership verification
 * @param ARGV[2] - New TTL in milliseconds
 * 
 * @returns 1 if lock TTL was successfully updated, 0 if token doesn't match or lock doesn't exist
 * 
 * @public
 */
export const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
    return 0
end
`.trim();