import Database from 'better-sqlite3';
import fs from 'fs';

// SQLite's OS lock is released on process exit (including SIGKILL). Use one
// canonical sidecar path for the running bridge and offline recovery CLI.
export function acquireOwnership(dbPath: string): () => void {
    const canonical = fs.realpathSync(dbPath);
    const lock = new Database(`${canonical}.bridge-lock`, {timeout: 0});
    try {
        lock.pragma('busy_timeout = 0');
        lock.pragma('journal_mode = DELETE');
        lock.exec('BEGIN EXCLUSIVE');
    } catch {
        lock.close();
        throw new Error('Database is owned by another bridge or recovery process');
    }
    return () => {
        try { lock.exec('ROLLBACK'); } finally { lock.close(); }
    };
}
