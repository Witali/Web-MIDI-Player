// Shared view: no device access or sound starts before an explicit button click.
export function renderMidiDevices(container, live, { onError=()=>{} }={}) {
  const document=container.ownerDocument,ports=live.ports;
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  container.replaceChildren();container.classList.add('midi-devices');
  const status=el('p');status.setAttribute('role','status');
  const note=el('p','Выберите вход для клавиатуры и выход для внешнего синтезатора. Звук входа и MIDI Thru включаются отдельно. Доступ к устройствам работает через HTTPS или localhost.');
  const buttons=el('div'),connect=el('button','Разрешить MIDI'),audio=el('button','Включить звук входа'),panic=el('button','Выключить все ноты');
  buttons.className='midi-device-buttons';for(const b of[connect,audio,panic]){b.type='button';b.className='secondary-button';buttons.append(b);}
  const label=(title,input)=>{const node=el('label',title+' ');input.setAttribute('aria-label',title);node.append(input);return node;};
  const sysex=el('input'),software=el('input'),thru=el('input');for(const i of[sysex,software,thru])i.type='checkbox';
  const input=el('select'),output=el('select'),volume=el('input');volume.type='range';volume.min=0;volume.max=1;volume.step=.01;volume.value=live.volume;
  const raw=el('input');raw.type='text';raw.placeholder='90 3C 64';raw.autocomplete='off';
  const send=el('button','Отправить на выход'),test=el('button','Пробная нота на выход');send.type=test.type='button';send.className=test.className='secondary-button';
  const count=el('p','Вход: 0 сообщений'),last=el('code');let received=0,disposed=false,frame=null,lastData;
  last.setAttribute('aria-label','Последнее входное сообщение');
  container.append(note,label('Разрешить SysEx',sysex),label('Показывать программные MIDI-устройства',software),buttons,label('MIDI-вход',input),label('MIDI-выход',output),label('MIDI Thru: вход → выход',thru),label('Громкость звука входа',volume),label('MIDI-команда в hex',raw),send,test,count,last,status);
  const fail=error=>{if(disposed)return;status.textContent=error.message;onError(error);};
  const action=async fn=>{try{await fn();if(!disposed)status.textContent='Готово';}catch(error){fail(error);}finally{if(!disposed)update();}};
  const populate=(select,rows,chosen)=>{
    select.replaceChildren();const empty=el('option','Не подключён');empty.value='';select.append(empty);
    for(const row of rows.filter(p=>p.state==='connected')){const option=el('option',[row.manufacturer,row.name||row.id].filter(Boolean).join(' · '));option.value=row.id;select.append(option);}
    select.value=chosen?.id??'';
  };
  const update=()=>{
    const all=ports.ports,selection=ports.selection;
    populate(input,all.inputs,selection.input);populate(output,all.outputs,selection.output);
    input.disabled=output.disabled=ports.state!=='ready';connect.disabled=!ports.supported||ports.state==='requesting';
    connect.textContent=ports.state==='requesting'?'Запрос доступа…':ports.access?'Обновить разрешения MIDI':'Разрешить MIDI';
    audio.disabled=live.state==='starting';audio.textContent=live.state==='starting'?'Загрузка звука…':live.state==='running'?'Выключить звук входа':'Включить звук входа';
    thru.checked=ports.thru;send.disabled=test.disabled=!selection.output;panic.disabled=live.state!=='running'&&!selection.output;
    if(!ports.supported)status.textContent='В этом браузере Web MIDI недоступен. Используйте поддерживающий браузер через HTTPS или localhost.';
  };
  connect.onclick=()=>action(()=>ports.request({sysex:sysex.checked,software:software.checked}));
  input.onchange=()=>action(()=>ports.selectInput(input.value));output.onchange=()=>action(()=>ports.selectOutput(output.value));
  thru.onchange=()=>{ports.thru=thru.checked;};volume.oninput=()=>{live.volume=Number(volume.value);};
  audio.onclick=()=>action(()=>live.state==='running'?live.stop():live.start());
  panic.onclick=()=>action(async()=>{ports.panic();await live.panic();});
  send.onclick=()=>action(()=>{
    const text=raw.value.trim();if(!/^(?:[a-f0-9]{2})(?:\s+[a-f0-9]{2})*$/i.test(text))throw new TypeError('Введите MIDI-байты в hex через пробел: 90 3C 64.');
    ports.send(text.split(/\s+/).map(s=>parseInt(s,16)));
  });
  test.onclick=()=>action(()=>{ports.send([0x90,60,90]);ports.send([0x80,60,0],performance.now()+300);});
  const showMessage=()=>{
    frame=null;if(disposed)return;count.textContent='Вход: '+received+' сообщений';
    const bytes=lastData;last.textContent=Array.from(bytes.subarray(0,128),b=>b.toString(16).padStart(2,'0')).join(' ').toUpperCase()+(bytes.length>128?' … ('+bytes.length+' байт)':'');
  };
  const message=event=>{received++;lastData=event.detail.data;if(globalThis.requestAnimationFrame){if(frame===null)frame=requestAnimationFrame(showMessage);}else showMessage();};
  const error=event=>fail(event.detail),bindings=[[ports,'portschange',update],[ports,'inputchange',update],[ports,'outputchange',update],[ports,'statechange',update],[ports,'midimessage',message],[ports,'error',error],[live,'statechange',update],[live,'error',error]];
  for(const[target,type,handler]of bindings)target.addEventListener(type,handler);update();
  return()=>{disposed=true;if(frame!==null)globalThis.cancelAnimationFrame?.(frame);for(const[target,type,handler]of bindings)target.removeEventListener(type,handler);for(const n of[connect,audio,panic,input,output,thru,volume,send,test])n.onclick=n.onchange=n.oninput=null;};
}
