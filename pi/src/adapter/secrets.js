/**
 * Pre-write secret scan — canonical implementation lives in host
 * (`host/src/core/secrets.js`); pi re-exports so the write-path scan and the
 * memory-write scan share one pattern set (dependency direction pi→host).
 */
export { scanForSecrets } from '../../../host/src/core/secrets.js';
