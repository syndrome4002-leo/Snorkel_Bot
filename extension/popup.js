const $ = (id) => document.getElementById(id);

function ask(message) {
  return chrome.runtime.sendMessage(message);
}

function renderStatus(res) {
  $('dot').className = 'dot ' + res.socket;
  $('state').textContent = res.busy ? `${res.socket} · running a task…` : res.socket;
  $('serverUrl').value = res.config.serverUrl;
  $('token').value = res.config.token;
  $('projectKey').value = res.config.projectKey;

  if (res.lastRun) {
    const when = new Date(res.lastRun.at).toLocaleTimeString();
    $('out').textContent = res.lastRun.ok
      ? `${when} — OK\n` + JSON.stringify(res.lastRun.task, null, 2)
      : `${when} — FAILED\n${res.lastRun.error}`;
  }
}

async function refresh() {
  renderStatus(await ask({ type: 'BG_STATUS' }));
}

$('save').addEventListener('click', async () => {
  await ask({
    type: 'BG_SAVE_CONFIG',
    config: {
      serverUrl: $('serverUrl').value.trim(),
      token: $('token').value.trim(),
      projectKey: $('projectKey').value.trim(),
    },
  });
  refresh();
});

$('run').addEventListener('click', async () => {
  $('out').textContent = 'Running…';
  const res = await ask({ type: 'BG_RUN_NOW', options: {} });
  $('out').textContent = res.ok
    ? JSON.stringify(res.task, null, 2)
    : `FAILED\n${res.error}`;
});

refresh();
setInterval(refresh, 2000);
