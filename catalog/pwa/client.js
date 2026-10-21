// Local files stay in memory; this module never uploads or stores their bytes.
export function setupPwa({ openFile, notify }) {
  const input = document.getElementById('local-file');
  const open = document.getElementById('open-local');
  const install = document.getElementById('install-app');
  const offline = document.getElementById('offline-app');
  const status = document.getElementById('pwa-status');
  let prompt, dragDepth = 0;
  async function receive(file) {
    if (!file) return;
    try {
      if (await openFile(file)) notify('Файл открыт. Нажмите ▶ для воспроизведения.');
    } catch (error) { notify(error.message); }
  }
  open.disabled = false;
  open.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0]; input.value = ''; await receive(file);
  };
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault(); input.click();
    }
  });
  const filesDragged = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', event => {
    if (filesDragged(event)) { event.preventDefault(); dragDepth++; document.body.classList.add('file-drag'); }
  });
  document.addEventListener('dragover', event => {
    if (filesDragged(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
  });
  document.addEventListener('dragleave', event => {
    if (filesDragged(event) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('file-drag'); }
  });
  document.addEventListener('drop', event => {
    if (!filesDragged(event)) return;
    event.preventDefault(); dragDepth = 0; document.body.classList.remove('file-drag');
    receive(event.dataTransfer.files[0]);
  });
  if (typeof window.launchQueue?.setConsumer === 'function') {
    window.launchQueue.setConsumer(async launch => {
      try { if (launch.files?.length) await receive(await launch.files[0].getFile()); }
      catch (error) { notify('Не удалось открыть файл: ' + error.message); }
    });
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); prompt = event; install.hidden = false;
  });
  install.onclick = async () => {
    if (!prompt) return;
    const request = prompt; prompt = null; install.hidden = true;
    try { await request.prompt(); await request.userChoice; } catch (error) { notify(error.message); }
  };
  window.addEventListener('appinstalled', () => { prompt = null; install.hidden = true; });
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const base = new URL('./', location.href);
  navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.href, updateViaCache: 'none' })
    .then(() => navigator.serviceWorker.ready).then(registration => {
      const request = (type, onMessage) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => {
          onMessage(event.data);
          if (event.data.done || event.data.error) channel.port1.close();
        };
        registration.active.postMessage({ type }, [channel.port2]);
      };
      const finished = message => {
        offline.disabled = false;
        offline.textContent = message.ready ? 'Офлайн готов' : 'Скачать для офлайн';
        status.textContent = message.ready ? 'Плеер и банк сохранены для работы без интернета.' : '';
      };
      request('OFFLINE_STATUS', finished);
      offline.onclick = () => {
        offline.disabled = true; status.textContent = 'Сохраняю плеер и банк звуков…';
        request('CACHE_OFFLINE', message => {
          if (message.error) { finished({ ready: false }); notify('Не удалось сохранить офлайн: ' + message.error); }
          else if (message.done) finished(message);
          else status.textContent = 'Загрузка для офлайн: ' + Math.round(message.completed / message.total * 100) + '%';
        });
      };
    }).catch(() => { status.textContent = 'Офлайн-режим пока недоступен. Файлы можно открывать при подключении к сети.'; });
}
