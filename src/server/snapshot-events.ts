interface SnapshotClient {
  write(frame: string): unknown;
  end(): unknown;
}

export function publishSnapshots<Client extends SnapshotClient>(
  clients: Map<Client, string>,
  getSession: (tokenHash: string) => { tenant: { id: string } } | null,
  snapshot: (tenantId: string) => unknown,
) {
  // Reuse only within this synchronous publish. Every connection still checks
  // its current session, including revocation and workspace changes.
  const frames = new Map<string, string>();
  for (const [client, tokenHash] of clients) {
    const session = getSession(tokenHash);
    if (!session) { client.end(); clients.delete(client); continue; }
    try {
      let frame = frames.get(session.tenant.id);
      if (frame === undefined) {
        frame = `data: ${JSON.stringify(snapshot(session.tenant.id))}\n\n`;
        frames.set(session.tenant.id, frame);
      }
      client.write(frame);
    } catch { client.end(); clients.delete(client); }
  }
}
