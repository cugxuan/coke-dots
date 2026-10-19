import type { Snapshot } from '../shared/types.ts';
import { diffSnapshot } from '../shared/snapshot-patch.ts';

interface SnapshotClient {
  write(frame: string): unknown;
  end(): unknown;
  once(event: 'drain' | 'close', listener: () => void): unknown;
}
interface Connection {
  tokenHash: string;
  incremental: boolean;
  previous?: { tenantId: string; snapshot: Snapshot };
  blocked: boolean;
  dirty: boolean;
}
type Frames = Map<string, { snapshot: Snapshot; full?: string }>;

export class SnapshotEvents {
  private clients = new Map<SnapshotClient, Connection>();

  constructor(
    private getSession: (tokenHash: string) => { tenant: { id: string } } | null,
    private snapshot: (tenantId: string) => Snapshot,
  ) {}

  connect(client: SnapshotClient, tokenHash: string, incremental = false) {
    const connection: Connection = { tokenHash, incremental, blocked: false, dirty: false };
    this.clients.set(client, connection);
    client.once('close', () => this.clients.delete(client));
    this.send(client, connection, new Map());
  }

  publish() {
    // Cache only for this publish; every connection must still check its live session.
    const frames: Frames = new Map();
    for (const [client, connection] of this.clients) this.send(client, connection, frames);
  }

  heartbeat() {
    for (const [client, connection] of this.clients) {
      if (!this.getSession(connection.tokenHash)) this.disconnect(client);
      else if (!connection.blocked) {
        try { this.write(client, connection, ': keep-alive\n\n'); }
        catch { this.disconnect(client); }
      }
    }
  }

  close() { for (const client of this.clients.keys()) this.disconnect(client); }

  private disconnect(client: SnapshotClient) {
    this.clients.delete(client);
    client.end();
  }

  private send(client: SnapshotClient, connection: Connection, frames: Frames) {
    const session = this.getSession(connection.tokenHash);
    if (!session) { this.disconnect(client); return; }
    // A false write already accepted the frame. Keep just a dirty flag, then read
    // fresh authorized state on drain instead of queuing obsolete full snapshots.
    if (connection.blocked) { connection.dirty = true; return; }
    try {
      const tenantId = session.tenant.id;
      let current = frames.get(tenantId);
      if (!current) { current = { snapshot: this.snapshot(tenantId) }; frames.set(tenantId, current); }
      let frame: string;
      if (connection.incremental && connection.previous?.tenantId === tenantId) {
        const patch = diffSnapshot(connection.previous.snapshot, current.snapshot);
        if (!patch) return;
        frame = `event: patch\ndata: ${JSON.stringify(patch)}\n\n`;
      } else {
        // Initial connections, reconnects and workspace switches always get a full snapshot.
        frame = current.full ??= `data: ${JSON.stringify(current.snapshot)}\n\n`;
      }
      this.write(client, connection, frame);
      if (connection.incremental) connection.previous = { tenantId, snapshot: current.snapshot };
    } catch {
      // A failed serialization must not poison other connections' cached frame.
      frames.delete(session.tenant.id);
      this.disconnect(client);
    }
  }

  private write(client: SnapshotClient, connection: Connection, frame: string) {
    if (client.write(frame) !== false) return;
    connection.blocked = true;
    client.once('drain', () => {
      if (this.clients.get(client) !== connection) return;
      connection.blocked = false;
      if (!connection.dirty) return;
      connection.dirty = false;
      this.send(client, connection, new Map());
    });
  }
}
