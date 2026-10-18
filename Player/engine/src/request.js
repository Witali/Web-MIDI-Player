// Binary transport only. Musical analysis, allocation, quantization and ROM/HEX
// construction belong to C; importers keep their common seconds-based timeline.
export function encodeRequest(score,bank,players,options) {
  if(options.packDecoder!==undefined&&typeof options.packDecoder!=='boolean')throw new Error('Некорректная настройка компоновки декодера.');
  if(!Number.isInteger(Number(options.voices??4))||!Number.isInteger(Number(options.transpose??0)))throw new Error('Проверьте голоса, транспозицию и границы фрагмента (минимум 0,25 мс).');
  for(const part of options.parts??[])if(part.enabled&&part.volume>0&&typeof part.volume!=='number')throw new Error('Некорректные настройки партии.');
  const quality=options.quality??'basic';
  const basicCapacity=options.basicCapacity??false;
  if(typeof basicCapacity!=='boolean'||(basicCapacity&&quality!=='basic'))throw new Error('Компактный спектр доступен только для простых сэмплов.');
  const extra=quality==='extra512'||quality==='extra1024',points=quality==='extra1024'?1024:512;
  if(extra&&!players.extra?.players?.[points]?.[Number(options.voices??4)===6?6:4]?.[options.mode])throw new Error('Загрузите проигрыватель увеличенных сэмплов.');
  const fractional=options.pdmProfile==='fractional2';
  if(fractional&&options.pdmRate!==undefined&&options.pdmRate!==128000)throw new Error('Дробный PDM второго порядка требует 128 кГц.');
  const pdmOrder=options.pdmOrder??(fractional?2:1);
  if(![1,2].includes(pdmOrder))throw new Error('Неизвестный порядок PDM.');
  const second=pdmOrder===2&&!fractional;
  const fixed=options.pdmProfile==='fixed2'||fractional;
  if(options.pdmProfile!==undefined&&!fixed)throw new Error('Неизвестный профиль PDM.');
  if(fixed&&(second||(fractional&&pdmOrder!==2)||options.mode!=='pdm'||Number(options.voices??4)>2||quality!=='natural'||options.compactSamples||!(fractional?players.fractional2:players.fixed2)))throw new Error(fractional?'Дробный PDM второго порядка требует 1–2 голоса, Natural и отдельный объект fractional2.':'Экспериментальный Q8 требует 1–2 голоса, Natural, PDM и отдельный объект fixed2.');
  const naturalSecond=second&&quality==='natural';
  const releaseTails=options.releaseTails??false;
  if(typeof releaseTails!=='boolean')throw new Error('Некорректная настройка хвостов нот.');
  const hasDrums=[...bank.values()].some(s=>s.pcm),extended=releaseTails||hasDrums;
  if(!hasDrums&&score.parts.some(p=>p.percussion)){
    const percussion=new Set(score.parts.filter(p=>p.percussion).map(p=>p.id));
    if(options.parts?.some(p=>percussion.has(p.id)&&p.enabled&&p.volume>0))throw new Error('Для ударных загрузите PCM-банк и выберите сэмплы ударных.');
    // Old settings omitted channel 10. Rebuild those same melodic requests
    // without adding silent drum notes, controller tails or protocol changes.
    score={...score,parts:score.parts.filter(p=>!p.percussion),notes:score.notes.filter(n=>!percussion.has(n.part))};
  }
  const pdmRate=options.pdmRate??80000,weighted=second&&pdmRate===96000;
  if(second&&![80000,96000].includes(pdmRate))throw new Error('Частота второго порядка PDM: 80 или 96 кГц.');
  if(second&&(options.mode!=='pdm'||Number(options.voices??4)!==4||!['basic','natural'].includes(quality)))throw new Error('Второй порядок PDM доступен для четырёх голосов, простых или улучшенных сэмплов.');
  if(second&&!players.sigma_delta2)throw new Error('Загрузите объект проигрывателя PDM второго порядка.');
  if(weighted&&!players.sigma_delta2_96)throw new Error('Загрузите объект проигрывателя PDM второго порядка 96 кГц.');
  const six=Number(options.voices??4)===6;
  const adaptive=options.adaptiveSamples??false;
  if(typeof adaptive!=='boolean'||(adaptive&&(options.mode!=='r2r'||(!extra&&(!six||!['natural','detailed'].includes(quality)))||(extra&&six))))throw new Error('Общие громкости доступны для R2R: шесть голосов Natural/Detailed или 1–4 голоса Экстра.');
  const sharedPlayer=adaptive?players.shared?.players?.[extra?points:256]?.[six?6:4]?.[options.mode]:null;
  if(adaptive&&!sharedPlayer)throw new Error('Загрузите дополнительные проигрыватели с общими громкостями.');
  const compact=extra?false:options.compactSamples??false;
  if(typeof compact!=='boolean')throw new Error('Некорректная настройка экономии сэмплов.');
  if(compact&&(six||second))throw new Error('Выбор хранения сэмплов доступен для 1–4 голосов и первого порядка PDM/R2R.');
  if(compact&&quality==='basic'&&!players.compact4?.players?.[options.mode])throw new Error('Загрузите объект простого проигрывателя с общими громкостями.');
  if(compact&&options.mode==='r2r'&&!players.compact4?.baked_players?.r2r)throw new Error('Загрузите объект R2R с непрерывной фазой при повторе.');
  const pcmTransport=hasDrums||compact||extra||naturalSecond||fixed||basicCapacity||adaptive,complete=extended||compact||extra||naturalSecond||fixed||basicCapacity||adaptive;
  const profiles=['loudest','balanced','melody-bass','stable'],profile=profiles.indexOf(options.allocationProfile===undefined?'loudest':options.allocationProfile);
  if(profile<0)throw new Error('Неизвестный профиль распределения голосов.');
  const substitute=options.substituteInstruments===undefined?false:options.substituteInstruments,maxInstruments=options.maxInstruments===undefined?0:options.maxInstruments;
  if(typeof substitute!=='boolean')throw new Error('Некорректная настройка замены инструментов.');
  const limited=options.maxInstruments!==undefined||substitute||profile>0;
  if(limited&&(!Number.isInteger(maxInstruments)||maxInstruments<0||maxInstruments>256))throw new Error('Максимум инструментов должен быть от 0 до 256.');
  if(options.trimLeadingSilence!==undefined&&typeof options.trimLeadingSilence!=='boolean')throw new Error('Некорректная настройка начальной тишины.');
  if(!['basic','natural','detailed','extra512','extra1024'].includes(quality))throw new Error('Неизвестное качество сэмплов.');
  if(quality!=='basic'&&(bank.quality?.tier!==quality||bank.quality.mode!==(six?'pdm':options.mode)))throw new Error(six?'Для шести голосов загрузите банк выбранного качества с полосой 3,5 кГц (PDM).':'Загрузите банк выбранного качества и типа выхода.');
  if(six&&!players.poly6?.players?.[options.mode])throw new Error('Загрузите объекты шестиголосого проигрывателя.');
  const chunks=[];let size=0;
  const append=bytes=>{chunks.push(bytes);size+=bytes.length;if(size>64*1024*1024)throw new Error('Запрос компилятора больше 64 МБ.');};
  const u32=value=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,value,true);append(b);};
  const f64=value=>{const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,Number(value),true);append(b);};
  const decode=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  const ids=new Map(score.parts.map((p,i)=>[p.id,i])),samples=[...bank.values()],sampleIds=new Map(samples.map((s,i)=>[s.id,i]));
  const drumParts=new Set(score.parts.filter(p=>p.percussion).map(p=>p.id));
  u32(0x3143465a);u32(adaptive?(extra?19:18):basicCapacity?17:fractional?16:fixed?15:naturalSecond?14:extra?13:compact?12:hasDrums?11:releaseTails?10:weighted?9:second?8:profile?7:substitute?6:limited?5:six?4:options.trimLeadingSilence?3:quality==='basic'?1:2);u32(options.mode==='pdm'?0:options.mode==='r2r'?1:0xffffffff);u32(Number(options.voices??4));u32(Number(options.transpose??0));
  f64(score.duration);f64(options.start??0);f64(options.end??score.duration);u32(score.parts.length);u32(samples.length);u32(score.notes.length);u32(options.parts?.length??0);
  const player=extra?players.extra.players[points][six?6:4][options.mode]:six?players.poly6.players[options.mode]:compact&&options.mode==='r2r'?players.compact4.baked_players.r2r:players.players[options.mode]??players.players.pdm,code=decode(player.code);u32(code.length);append(code);u32(player.pattern_base);u32(player.relocation_high_bytes.length);player.relocation_high_bytes.forEach(u32);
  for(const s of samples){const name=new TextEncoder().encode(s.id);u32(name.length);append(name);u32(s.first_note);u32(s.last_note);f64(s.cycles);const data=s.bytes??decode(s.tables);u32(data.length);append(data);}
  for(const p of options.parts??[]){u32(ids.get(p.id)??0xffffffff);u32(sampleIds.get(p.sample)??0xffffffff);u32(p.enabled?1:0);f64(p.volume);}
  for(const n of score.notes){const levels=releaseTails||(hasDrums&&drumParts.has(n.part))?n.levels:n.levels.filter(e=>e.time<=n.end);u32(n.id);u32(ids.get(n.part)??0xffffffff);u32(n.pitch);f64(n.start);f64(n.end);u32(levels.length);for(const e of levels){f64(e.time);f64(e.gain);}}
  if(complete||second||limited||six||options.trimLeadingSilence){u32(options.trimLeadingSilence?1:0);u32(quality==='basic'?0:1);}
  if(quality!=='basic'){
    u32(quality==='natural'?1:quality==='detailed'?2:quality==='extra512'?3:4);
    if(extra&&!six&&options.mode==='pdm')player.handlers.forEach(u32);
    if(!six&&!extra){const p=bank.quality.player,object=decode(p.code);u32(object.length);append(object);u32(p.pattern_base);u32(p.relocation_high_bytes.length);p.relocation_high_bytes.forEach(u32);p.handlers.forEach(u32);}
    for(const s of samples){u32(s.family);u32(s.frames);u32(s.rich.length);if(extra){if(s.grainPoints?.length!==s.last_note-s.first_note+1)throw new Error('Некорректные размеры сэмплов.');s.grainPoints.forEach(u32);}append(s.rich);}
  }
  if(complete||second||limited)u32(maxInstruments);
  if(complete||second||substitute||profile)u32(substitute?1:0);
  if(complete||second||profile)u32(profile);
  if(complete)u32(fractional?1:pdmOrder); // The v16 object below owns its second-order layout.
  if(second){const p=weighted?players.sigma_delta2_96:players.sigma_delta2,object=decode(p.code);if(!complete)u32(2);if(complete||weighted)u32(pdmRate);u32(object.length);append(object);u32(p.pattern_base);u32(p.relocation_high_bytes.length);p.relocation_high_bytes.forEach(u32);if(weighted)u32(p.timer_done);}
  if(pcmTransport){
    u32(releaseTails?1:0);
    for(const s of samples){u32(s.pcm?s.pcm.length/2:0);if(s.pcm){u32(s.pcm_rate_hz);append(s.pcm);}}
    score.parts.forEach(p=>u32(p.percussion?1:0));
  }
  if(complete){u32(score.notes.length);for(const n of score.notes){f64(n.keyOff??n.end);f64(n.hardEnd??-1);}}
  if(compact||basicCapacity){
    u32(compact?1:0);
    if(compact&&quality==='basic'){
      const p=players.compact4.players[options.mode],object=decode(p.code);
      u32(object.length);append(object);u32(p.pattern_base);u32(p.relocation_high_bytes.length);p.relocation_high_bytes.forEach(u32);p.handlers.forEach(u32);
    }
  }
  if(fixed){const p=fractional?players.fractional2:players.fixed2,object=decode(p.code);u32(object.length);append(object);u32(p.pattern_base);u32(p.relocation_high_bytes.length);p.relocation_high_bytes.forEach(u32);u32(fractional?1:p.new_count);u32(fractional?1:p.repeat_count);
    if(fractional){const row=decode(p.row_template);u32(p.quantum);u32(row.length);append(row);u32(p.row_sp_offset);u32(p.row_relocation_words.length);p.row_relocation_words.forEach(u32);}}
  if(adaptive){const p=sharedPlayer,object=decode(p.code);u32(1);u32(object.length);append(object);u32(p.pattern_base);u32(p.relocation_high_bytes.length);p.relocation_high_bytes.forEach(u32);}
  let result=new Uint8Array(size);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}
  if(options.packDecoder){const packed=new Uint8Array(size+4);packed.set(result.subarray(0,4));new DataView(packed.buffer).setUint32(4,20,true);packed.set(result.subarray(4),8);result=packed;}
  return result;
}
