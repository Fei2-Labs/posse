import { PtyBackend } from './pty-backend';

/**
 * A Connection pairs a PtyBackend (the live pty-daemon client) with identity
 * metadata. Today there is exactly ONE connection — the local one (`id: 'local'`).
 *
 * This is the seam that a later chunk will extend to hold remote connections
 * (SSH / Tailscale-backed PtyDaemonClient instances pointed at a remote
 * endpoint). Introducing it now — as a pure refactor with no behavior change —
 * lets that future chunk add remote hosts + per-window host binding without
 * touching the ~19 call sites that currently reach for a single global.
 */
export type ConnectionKind = 'local' | 'remote';

export interface Connection {
  id: string;
  label: string;
  kind: ConnectionKind;
  backend: PtyBackend;
  /** SSH host alias (from ~/.ssh/config) for bootstrapped remotes; enables re-bootstrap + ssh -L fallback. */
  sshHost?: string;
}

export const LOCAL_CONNECTION_ID = 'local';

/**
 * Holds the set of connections keyed by id and tracks which one is "active".
 *
 * "Active" maps to the currently-bound connection. With a single window today,
 * active == the local connection. A later chunk will map BrowserWindow ->
 * connection id so each window can bind to a different host (see the
 * window<->connection seam in index.ts).
 */
export class ConnectionRegistry {
  private connections = new Map<string, Connection>();
  private activeId: string | null = null;

  /** Register a connection. The first registered connection becomes active. */
  register(connection: Connection): Connection {
    this.connections.set(connection.id, connection);
    if (this.activeId === null) {
      this.activeId = connection.id;
    }
    return connection;
  }

  get(id: string): Connection | undefined {
    return this.connections.get(id);
  }

  list(): Connection[] {
    return Array.from(this.connections.values());
  }

  /** The active connection. Throws if the registry has not been populated yet. */
  getActive(): Connection {
    if (this.activeId === null) {
      throw new Error('ConnectionRegistry.getActive() called before any connection was registered');
    }
    const conn = this.connections.get(this.activeId);
    if (!conn) {
      throw new Error(`ConnectionRegistry active connection '${this.activeId}' is not registered`);
    }
    return conn;
  }

  setActive(id: string): void {
    if (!this.connections.has(id)) {
      throw new Error(`ConnectionRegistry.setActive('${id}') — no such connection`);
    }
    this.activeId = id;
  }

  /** The id of the currently-active connection (or null before any registration). */
  getActiveId(): string | null {
    return this.activeId;
  }

  /**
   * Remove a connection (e.g. a remote the user dropped). Never removes 'local'.
   * If the removed connection was active, falls back to 'local'. Returns the removed
   * connection so the caller can dispose its backend.
   */
  unregister(id: string): Connection | undefined {
    if (id === LOCAL_CONNECTION_ID) return undefined;
    const conn = this.connections.get(id);
    if (!conn) return undefined;
    this.connections.delete(id);
    if (this.activeId === id) {
      this.activeId = this.connections.has(LOCAL_CONNECTION_ID) ? LOCAL_CONNECTION_ID : (this.connections.keys().next().value ?? null);
    }
    return conn;
  }

  /** The always-present local connection. */
  local(): Connection {
    const conn = this.connections.get(LOCAL_CONNECTION_ID);
    if (!conn) {
      throw new Error('ConnectionRegistry has no local connection registered');
    }
    return conn;
  }
}
