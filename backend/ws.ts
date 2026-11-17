import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ActorContext, UserRole } from '../shared/types/domain';
import {
  AuthVerificationError,
  resolveActorFromFirebaseToken,
  resolveDemoActor,
} from './middleware/auth';
import { isDemoAuthAllowed } from './security/config';

interface ClientMeta {
  ws: WebSocket;
  userId: string;
  role: UserRole;
  tenantId: string;
  assignedOutletIds: string[];
}

class RealtimeHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientMeta>();

  public attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', async (ws, req) => {
      let registeredMeta: ClientMeta | null = null;

      const registerAuthenticatedActor = (actor: ActorContext) => {
        if (registeredMeta) return;
        registeredMeta = {
          ws,
          userId: actor.userId,
          role: actor.role,
          tenantId: actor.tenantId,
          assignedOutletIds: actor.assignedOutletIds,
        };
        this.clients.add(registeredMeta);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'connection:ready',
              payload: {
                connectedAt: new Date().toISOString(),
                tenantId: actor.tenantId,
                role: actor.role,
              },
            })
          );
        }
      };

      const failAndClose = (code: number, reason: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'auth:error', error: reason }));
          ws.close(code, reason.slice(0, 120));
        }
      };

      // Option 1: Authorization: Bearer <Firebase_ID_Token> header on upgrade request
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const actor = await resolveActorFromFirebaseToken(authHeader.slice(7).trim());
          registerAuthenticatedActor(actor);
        } catch (err) {
          const msg = err instanceof AuthVerificationError ? err.message : 'Invalid token.';
          failAndClose(4401, msg);
          return;
        }
      }

      // Option 2: First-frame authentication handshake (never trust URL query params!)
      const authTimeout = setTimeout(() => {
        if (!registeredMeta) {
          failAndClose(4401, 'WebSocket authentication timeout.');
        }
      }, 5000);

      ws.on('message', async (rawData) => {
        if (registeredMeta) return;
        try {
          const parsed = JSON.parse(rawData.toString('utf8')) as {
            type?: string;
            token?: string;
            demoUserId?: string;
          };
          if (parsed.type !== 'auth') {
            clearTimeout(authTimeout);
            failAndClose(4401, 'WebSocket requires authentication handshake first.');
            return;
          }

          if (parsed.token) {
            const actor = await resolveActorFromFirebaseToken(parsed.token);
            clearTimeout(authTimeout);
            registerAuthenticatedActor(actor);
            return;
          }

          if (parsed.demoUserId && isDemoAuthAllowed()) {
            const actor = resolveDemoActor(parsed.demoUserId);
            clearTimeout(authTimeout);
            registerAuthenticatedActor(actor);
            return;
          }

          clearTimeout(authTimeout);
          failAndClose(4401, 'Valid Firebase ID token is required for WebSocket access.');
        } catch (err) {
          clearTimeout(authTimeout);
          const msg =
            err instanceof AuthVerificationError
              ? err.message
              : 'WebSocket authentication failed.';
          failAndClose(4401, msg);
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        if (registeredMeta) {
          this.clients.delete(registeredMeta);
        }
      });

      ws.on('error', () => {
        clearTimeout(authTimeout);
        if (registeredMeta) {
          this.clients.delete(registeredMeta);
        }
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
