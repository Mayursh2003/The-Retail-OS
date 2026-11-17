import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { UserRole } from '../shared/types/domain';

interface ClientMeta {
  ws: WebSocket;
  role: UserRole;
  tenantId: string;
  assignedOutletIds: string[];
}

class RealtimeHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientMeta>();

  public attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/ws', 'http://localhost');
      const role = (url.searchParams.get('role') as UserRole) || 'WORKER';
      const tenantId = url.searchParams.get('tenantId') || '';
      const outletsRaw = url.searchParams.get('outlets') || '';
      const assignedOutletIds = outletsRaw ? outletsRaw.split(',').filter(Boolean) : [];

      const meta: ClientMeta = { ws, role, tenantId, assignedOutletIds };
      this.clients.add(meta);

      ws.send(
        JSON.stringify({
          type: 'connection:ready',
          payload: { connectedAt: new Date().toISOString(), tenantId, role },
        })
      );

      ws.on('close', () => {
        this.clients.delete(meta);
      });

      ws.on('error', () => {
        this.clients.delete(meta);
      });
    });
  }

  public getClientCount(): number {
    return this.clients.size;
  }

  public broadcastScoped(
    tenantId: string,
    outletId: string | null,
    type: string,
    payload: unknown
  ): void {
    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      if (client.role === 'DEVELOPER') {
        client.ws.send(message);
        continue;
      }

      if (client.tenantId !== tenantId) continue;

      if (client.role === 'CLIENT_OWNER') {
        client.ws.send(message);
        continue;
      }

      if (
        client.role === 'WORKER' &&
        (!outletId || client.assignedOutletIds.includes(outletId))
      ) {
        client.ws.send(message);
      }
    }
  }
}

export const realtimeHub = new RealtimeHub();
