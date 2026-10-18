import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type StoredMessage = {
  msg_id: string;
  project: string;
  [key: string]: unknown;
};

/** Minimal durable journal for hub message state. Agent/SSE presence remains ephemeral. */
export class ComsNetStore {
  private readonly db: Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coms_messages (
        project TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (project, msg_id)
      );
    `);
  }

  load(project: string): StoredMessage[] {
    const rows = this.db.query('SELECT payload FROM coms_messages WHERE project = ?').all(project) as Array<{ payload: string }>;
    return rows.flatMap((row) => {
      try {
        const item = JSON.parse(row.payload) as StoredMessage;
        return item.msg_id && item.project === project ? [item] : [];
      } catch {
        return [];
      }
    });
  }

  save(message: StoredMessage): void {
    const payload = JSON.stringify(message);
    this.db.run(
      'INSERT INTO coms_messages (project, msg_id, payload) VALUES (?, ?, ?) ON CONFLICT(project, msg_id) DO UPDATE SET payload = excluded.payload',
      [message.project, message.msg_id, payload],
    );
  }

  remove(project: string, msgId: string): void {
    this.db.run('DELETE FROM coms_messages WHERE project = ? AND msg_id = ?', [project, msgId]);
  }
}
