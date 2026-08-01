'use client';

function Pill({ label, state, title }) {
  return (
    <span className="pill" title={title || ''}>
      <span className={`dot ${state}`} />
      {label}
    </span>
  );
}

function staleness(updatedAt) {
  if (!updatedAt) return null;
  const seconds = Math.round((Date.now() - new Date(updatedAt).getTime()) / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Everything here comes from /server/status in the Realtime Database, which the
 * server rewrites every 10 seconds. `online` is maintained by Firebase's own
 * onDisconnect, so it flips even if the server is killed rather than stopped.
 */
export default function StatusPills({ status }) {
  if (!status) {
    return (
      <div className="pills">
        <Pill label="server never seen" state="bad" title="Nothing has been published to /server/status yet." />
      </div>
    );
  }

  const age = staleness(status.updated_at);
  // The heartbeat is every 10s; a minute of silence means something is wrong
  // even if onDisconnect has not fired.
  const online = status.online && (age === null || age < 60);

  return (
    <div className="pills">
      <Pill
        label={online ? 'server' : 'server offline'}
        state={online ? 'ok' : 'bad'}
        title={age === null ? '' : `last heartbeat ${age}s ago`}
      />
      <Pill
        label={status.extension_connected ? 'extension' : 'extension offline'}
        state={status.extension_connected ? 'ok' : 'bad'}
        title={
          status.extension_connected
            ? 'The Snorkel extension is connected to the server.'
            : 'Load snorkel_extension/ in Chrome on the machine running the server.'
        }
      />
      <Pill label="firebase" state={status.firebase_ready ? 'ok' : 'bad'} />
      <Pill
        label="dropbox"
        state={status.dropbox_configured ? 'ok' : 'bad'}
        title={status.dropbox_configured ? '' : 'No Dropbox credentials on the server.'}
      />
      {status.pending_tasks ? (
        <Pill
          label={`${status.pending_tasks} queued`}
          state="warn"
          title="Tasks that could not reach Firestore on the server."
        />
      ) : null}
    </div>
  );
}
