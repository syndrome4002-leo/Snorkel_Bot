const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);

function render(res) {
  $('dot').className = 'dot ' + res.socket;
  $('state').textContent = res.busy ? `${res.socket} · uploading…` : res.socket;
  $('serverUrl').value = res.config.serverUrl;
  $('token').value = res.config.token;
  $('folder').value = res.config.folder;

  if (res.lastRun) {
    const when = new Date(res.lastRun.at).toLocaleTimeString();
    $('out').textContent = res.lastRun.ok
      ? `${when} — uploaded\n` +
        `${res.lastRun.dropbox_name}\n${res.lastRun.bytes} bytes` +
        (res.lastRun.renamed ? '\n(Dropbox renamed it — a file of that name was already there)' : '')
      : `${when} — FAILED\n${res.lastRun.error}`;
  }
}

async function refresh() {
  render(await ask({ type: 'BG_STATUS' }));
}

$('save').addEventListener('click', async () => {
  await ask({
    type: 'BG_SAVE_CONFIG',
    config: {
      serverUrl: $('serverUrl').value.trim(),
      token: $('token').value.trim(),
      folder: $('folder').value.trim(),
    },
  });
  refresh();
});

refresh();
setInterval(refresh, 2000);
