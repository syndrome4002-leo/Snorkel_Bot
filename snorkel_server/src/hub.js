/*
 * hub.js — the WebSocket side of the server.
 *
 * The Snorkel extension connects to /extension and identifies itself by role,
 * either as ?role=snorkel on the URL or in its "hello" frame. Uploading to
 * Dropbox is done by the server over HTTPS, so there is no browser role for it.
 *
 * Commands are request/response: each carries a requestId, and the promise
 * settles when a matching {type:"result"} frame comes back, or on timeout /
 * disconnect. One connection per role; a second one replaces the first.
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';

export const ROLES = ['snorkel'];

/** Older builds of the Snorkel extension only sent a client name. */
function roleFromHello(msg) {
  if (msg.role && ROLES.includes(msg.role)) return msg.role;
  if (typeof msg.client === 'string' && msg.client.includes('snorkel')) return 'snorkel';
  return null;
}

export class ExtensionHub {
  constructor() {
    this.clients = new Map(); // role -> { ws, info }
    this.pending = new Map(); // requestId -> { resolve, reject, timer, progress, role }
    this.listeners = new Set();
  }

  attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/extension' });

    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      if (config.botToken && url.searchParams.get('token') !== config.botToken) {
        console.warn('[hub] rejected a connection with a bad token');
        ws.close(4401, 'unauthorized');
        return;
      }

      // Provisional until "hello" confirms it; defaults to snorkel so an older
      // extension that declares neither still lands somewhere sensible.
      let role = url.searchParams.get('role');
      if (!ROLES.includes(role)) role = null;
      this.#register(role || 'snorkel', ws, null);
      if (!role) role = 'snorkel';

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return console.warn('[hub] ignoring non-JSON frame');
        }

        if (msg.type === 'hello') {
          const declared = roleFromHello(msg);
          if (declared && declared !== role) {
            this.#unregister(ws);
            role = declared;
          }
          this.#register(role, ws, msg);
          console.log(`[hub] hello from ${msg.client} v${msg.version} as "${role}"`);
          return;
        }

        this.#onMessage(msg, role);
      });

      ws.on('close', () => {
        const closedRole = this.#unregister(ws);
        if (closedRole) console.log(`[hub] "${closedRole}" extension disconnected`);
        this.#failPending((entry) => entry.role === closedRole, 'The extension disconnected.');
      });

      ws.on('error', (err) => console.warn('[hub] socket error:', err.message));
    });

    setInterval(() => {
      for (const role of this.clients.keys()) this.#send(role, { type: 'ping', at: Date.now() });
    }, 30000).unref();

    return wss;
  }

  #register(role, ws, info) {
    const existing = this.clients.get(role);
    if (existing && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) {
      console.warn(`[hub] a new "${role}" extension connected — dropping the previous one`);
      existing.ws.close(4409, 'replaced');
    }
    this.clients.set(role, {
      ws,
      info: info
        ? { ...info, connectedAt: new Date().toISOString() }
        : (existing && existing.ws === ws ? existing.info : null),
    });
    if (!info) console.log(`[hub] "${role}" extension connected`);
  }

  #unregister(ws) {
    for (const [role, entry] of this.clients) {
      if (entry.ws === ws) {
        this.clients.delete(role);
        return role;
      }
    }
    return null;
  }

  isConnected(role) {
    const entry = this.clients.get(role);
    return !!entry && entry.ws.readyState === entry.ws.OPEN;
  }

  status() {
    const roles = {};
    for (const role of ROLES) {
      const entry = this.clients.get(role);
      roles[role] = { connected: this.isConnected(role), extension: entry ? entry.info : null };
    }
    return { ...roles, pending: this.pending.size };
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Sends a command to one role and resolves with its result payload. */
  command(role, payload, timeoutMs = config.commandTimeoutMs) {
    if (!this.isConnected(role)) {
      return Promise.reject(new Error(`No "${role}" extension is connected.`));
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`The "${role}" extension did not finish within ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer, progress: [], role });
      this.#send(role, { ...payload, requestId });
      this.#emit({ type: 'command', role, requestId, command: payload.type });
      console.log(`[hub] -> ${role}: ${payload.type} ${requestId}`);
    });
  }

  startSentinel(options = {}) {
    return this.command('snorkel', { type: 'start_sentinel', options });
  }

  #send(role, payload) {
    const entry = this.clients.get(role);
    if (entry && entry.ws.readyState === entry.ws.OPEN) entry.ws.send(JSON.stringify(payload));
  }

  #emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a bad subscriber must not break the hub */
      }
    }
  }

  #onMessage(msg, role) {
    switch (msg.type) {
      case 'progress': {
        const entry = this.pending.get(msg.requestId);
        if (entry) entry.progress.push({ step: msg.step, message: msg.message, at: msg.at });
        console.log(`[hub]    (${role}) ${msg.step}${msg.message ? ': ' + msg.message : ''}`);
        this.#emit({ ...msg, role });
        break;
      }

      case 'result': {
        const entry = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        this.#emit({ ...msg, role });
        if (!entry) return;
        clearTimeout(entry.timer);
        if (msg.ok) {
          entry.resolve({ ...msg, progress: entry.progress });
        } else {
          const error = new Error(msg.error || 'The extension reported an unknown failure.');
          // e.g. START_UNAVAILABLE — the site handed out no task.
          if (msg.code) error.code = msg.code;
          entry.reject(error);
        }
        break;
      }

      case 'pong':
      case 'heartbeat':
        break;

      case 'revisions':
        // Not a reply to anything — the extension raises this on its own timer.
        this.#emit({ ...msg, role });
        if (this.onRevisions) this.onRevisions(msg);
        break;

      default:
        console.log(`[hub] unhandled frame from ${role}:`, msg.type);
    }
  }

  #failPending(predicate, reason) {
    for (const [id, entry] of this.pending) {
      if (!predicate(entry)) continue;
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
