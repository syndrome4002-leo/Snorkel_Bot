/*
 * hub.js — the WebSocket side of the server.
 *
 * Keeps the (single) extension connection and turns "start a sentinel task"
 * into a request/response round-trip: the command carries a requestId, and the
 * promise settles when a matching {type:"result"} frame comes back, or on
 * timeout / disconnect.
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';

export class ExtensionHub {
  constructor() {
    this.socket = null;         // the currently connected extension
    this.info = null;           // its "hello" payload
    this.pending = new Map();   // requestId -> {resolve, reject, timer, progress}
    this.listeners = new Set(); // progress subscribers (used by the SSE endpoint)
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

      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        console.warn('[hub] a new extension connected — dropping the previous one');
        this.socket.close(4409, 'replaced');
      }

      this.socket = ws;
      console.log('[hub] extension connected');

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return console.warn('[hub] ignoring non-JSON frame');
        }
        this.#onMessage(msg);
      });

      ws.on('close', () => {
        if (this.socket === ws) {
          this.socket = null;
          this.info = null;
        }
        console.log('[hub] extension disconnected');
        this.#failAllPending('The extension disconnected.');
      });

      ws.on('error', (err) => console.warn('[hub] socket error:', err.message));
    });

    // Liveness ping so dead sockets are noticed rather than lingering.
    setInterval(() => {
      if (this.isConnected()) this.#send({ type: 'ping', at: Date.now() });
    }, 30000).unref();

    return wss;
  }

  isConnected() {
    return !!this.socket && this.socket.readyState === this.socket.OPEN;
  }

  status() {
    return {
      connected: this.isConnected(),
      extension: this.info,
      pending: this.pending.size,
    };
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Sends start_sentinel and resolves with {task, meta, progress} when it finishes. */
  startSentinel(options = {}, timeoutMs = config.commandTimeoutMs) {
    if (!this.isConnected()) {
      return Promise.reject(new Error('No extension is connected.'));
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`The extension did not finish within ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer, progress: [] });
      this.#send({ type: 'start_sentinel', requestId, options });
      this.#emit({ type: 'command', requestId, options });
      console.log(`[hub] -> start_sentinel ${requestId}`);
    });
  }

  #send(payload) {
    if (this.isConnected()) this.socket.send(JSON.stringify(payload));
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

  #onMessage(msg) {
    switch (msg.type) {
      case 'hello':
        this.info = { ...msg, connectedAt: new Date().toISOString() };
        console.log(`[hub] hello from ${msg.client} v${msg.version}`);
        break;

      case 'progress': {
        const entry = this.pending.get(msg.requestId);
        if (entry) entry.progress.push({ step: msg.step, message: msg.message, at: msg.at });
        console.log(`[hub]    ${msg.step}${msg.message ? ': ' + msg.message : ''}`);
        this.#emit(msg);
        break;
      }

      case 'result': {
        const entry = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        this.#emit(msg);
        if (!entry) return;
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve({ task: msg.task, meta: msg.meta, progress: entry.progress });
        else entry.reject(new Error(msg.error || 'The extension reported an unknown failure.'));
        break;
      }

      case 'pong':
      case 'heartbeat':
        break;

      default:
        console.log('[hub] unhandled frame:', msg.type);
    }
  }

  #failAllPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
