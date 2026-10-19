import type { Snapshot } from '../shared/types.ts';
import { diffSnapshot } from '../shared/snapshot-patch.ts';
import { visibleChatHistory } from '../shared/chat-history.ts';

interface SnapshotClient {
  write(frame: string): unknown;
  end(): unknown;
  once(event: 'drain' | 'close', listener: () => void): unknown;
}
interface Connection {
  tokenHash: string;
  incremental: boolean;
  bootstrapChat: boolean;
  previous?: { scope: string; snapshot: Snapshot };
  blocked: boolean;
  dirty: boolean;
}
type Frames = { tenants: Map<string, Snapshot>; users: Map<string, { snapshot: Snapshot; full?: string }> };
const emptyFrames = (): Frames => ({ tenants: new Map(), users: new Map() });

export class SnapshotEvents {
  private clients = new Map<SnapshotClient, Connection>();

  constructor(
    private getSession: (tokenHash: string) => { tenant: { id: string }; user?: { id: string } } | null,
    private snapshot: (tenantId: string) => Snapshot,
    private personalize?: (snapshot: Snapshot, tenantId: string, userId?: string) => Snapshot,
  ) {}

  connect(client: SnapshotClient, tokenHash: string, incremental = false, bootstrapChat = false) {
    const connection: Connection = { tokenHash, incremental, bootstrapChat, blocked: false, dirty: false };
    this.clients.set(client, connection);
    client.once('close', () => this.clients.delete(client));
    this.send(client, connection, emptyFrames());
  }

  publish() {
    // Cache only for this publish; every connection must still check its live session.
    const frames = emptyFrames();
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
    const tenantId = session.tenant.id;
    const scope = JSON.stringify([tenantId, session.user?.id || '']);
    try {
      let current = frames.users.get(scope);
      if (!current) {
        const shared = frames.tenants.get(tenantId) || this.snapshot(tenantId);
        frames.tenants.set(tenantId, shared);
        current = { snapshot: this.personalize?.(shared, tenantId, session.user?.id) || shared };
        frames.users.set(scope, current);
      }
      let frame: string;
      if (connection.incremental && connection.previous?.scope === scope) {
        const patch = diffSnapshot(connection.previous.snapshot, current.snapshot);
        if (!patch) return;
        frame = `event: patch\ndata: ${JSON.stringify(patch)}\n\n`;
      } else {
        // Initial connections, reconnects and workspace switches always get a full snapshot.
        frame = current.full ??= `data: ${JSON.stringify(current.snapshot)}\n\n`;
        if (connection.bootstrapChat && current.snapshot.chatHistory?.clearedAt) {
          // Restore the visible conversation before transferring retained Activity
          // history. Both events belong to one authorized snapshot and one write,
          // so backpressure and the subsequent patch baseline remain unchanged.
          const chat = { ...current.snapshot, ...visibleChatHistory(current.snapshot) };
          frame = `event: chat-bootstrap\ndata: ${JSON.stringify(chat)}\n\n${frame}`;
        }
      }
      this.write(client, connection, frame);
      if (connection.incremental) connection.previous = { scope, snapshot: current.snapshot };
    } catch {
      // A failed serialization must not poison other connections' cached frame.
      frames.users.delete(scope);
      frames.tenants.delete(tenantId);
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
      this.send(client, connection, emptyFrames());
    });
  }
}
