const $ = id => document.getElementById(id);

async function load() {
  const cur = await chrome.storage.local.get(['port', 'token', 'newChatPerRequest']);
  $('port').value = cur.port || 39847;
  $('token').value = cur.token || '';
  $('newChat').checked = !!cur.newChatPerRequest;
}

async function save() {
  await chrome.storage.local.set({
    port: parseInt($('port').value, 10) || 39847,
    token: $('token').value.trim(),
    newChatPerRequest: $('newChat').checked,
  });
  $('status').textContent = 'Saved. Reload the bridge from chrome://extensions to apply.';
  setTimeout(() => { $('status').textContent = ''; }, 3000);
}

document.addEventListener('DOMContentLoaded', load);
$('save').addEventListener('click', save);
