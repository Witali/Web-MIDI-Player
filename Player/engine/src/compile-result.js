// Format C-owned numeric results for either frontend. No note or ROM algorithm
// is duplicated here; even Intel HEX bytes come directly from the C library.
export function finishResult(score,options,result,bank=new Map()) {
  const profile=['loudest','balanced','melody-bass','stable'][result.numbers[34]??0],profileName={loudest:'По громкости',balanced:'Баланс партий','melody-bass':'Мелодия и бас',stable:'Устойчивые ноты'}[profile];
  const n=result.numbers,voices=Number(options.voices??4),chosen=options.parts.filter(p=>p.enabled&&p.volume>0),warnings=[...score.warnings];
  for(const part of chosen){const sample=bank.get(part.sample);if(sample?.approximation)warnings.push(`Ударные GM ${sample.key}: ${sample.approximation}`);}
  if(n[3])warnings.push(`Вне MIDI 24–104 после транспозиции: ${n[3]} нот, пропущены.`);
  if(n[1]<n[0]||n[2])warnings.push(`Полифония ${voices}: не прозвучали ${n[0]-n[1]} нот; прерывались ${n[2]}. `+(profile==='loudest'?'При совпадении выбираются более громкие ноты.':`Профиль «${profileName}». `)+(options.substituteInstruments?' Приоритет у исходных тембров; похожие заполняют свободные голоса.':''));
  if(n[18])warnings.push(`Убрана начальная тишина: ${n[18].toFixed(3)} с. Паузы внутри композиции сохранены.`);
  if(n[29]<n[28])warnings.push(`Лимит инструментов: выбрано ${n[29]} из ${n[28]} тембров по громкости всей композиции; пропущено ${n[31]} нот в этом фрагменте. Лимит одновременных голосов учитывается отдельно.`);
  if(options.pdmProfile==='fractional2')warnings.push('Экспериментальный дробный PDM второго порядка: 1–2 голоса, PCM 16 кГц, PDM 128 кГц. На отдельных тихих нотах и в полосе 8–20 кГц шум может быть выше прежнего режима.');
  else if(options.pdmOrder===2)warnings.push(`Экспериментальный PDM второго порядка: четыре голоса, ${n[15]===1?'улучшенные':'простые'} сэмплы, PCM строго 8 кГц, PDM ${n[25]/1000} кГц. Номинальное ослабление 70%; высокочастотный шум выше обычного PDM.`+(n[25]===96000?' Микшер 8 бит, взвешенная обратная связь, интервалы PDM 208/212 T.':''));
  // Legacy saved settings can rebuild with channel 10 removed by transport.
  // Its numeric part indices then address that same melodic-only part list.
  const samples=[...bank.values()],resultParts=samples.some(s=>s.pcm)?score.parts:score.parts.filter(p=>!p.percussion),raw=result.substitutions??new Uint8Array(),rows=[];
  if(Array.isArray(raw))rows.push(...raw);
  else {const data=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);for(let i=0;i+12<=data.byteLength;i+=12)rows.push([data.getUint32(i,true),data.getUint32(i+4,true),data.getUint32(i+8,true)]);}
  const substitutions=rows.map(([part,from,to])=>({part:resultParts[part].id,from:samples[from].id,to:samples[to].id}));
  for(const [part,from,to] of rows)warnings.push(`Замена инструмента партии ${part+1}: ${samples[from].name??samples[from].id} → ${samples[to].name??samples[to].id}. Звучит только при свободном голосе.`);
  const waveAddress=n[16]||0x1c00,planes=n[17]||3,quality=['basic','natural','detailed','extra512','extra1024'][n[15]||0],extra=n[15]>=3;
  const oscillators=n[26]||4;
  const fractionalStats=options.pdmProfile==='fractional2'?{pdmProfile:'fractional2',inputWordBits:16,pdmStateBits:16,pdmQuantum:12800,amplitudeScale:50}:{};
  const layout=result.decoderLayout;
  const descriptorAddress=layout?.descriptorAddress??0x1000,gainAddress=layout?.gainAddress??(oscillators===6?0x2800:0x2000);
  const descriptors=result.descriptors?Uint8Array.from(result.descriptors):result.rom.slice(descriptorAddress,descriptorAddress+oscillators*planes*256),waveBytes=result.waves??result.rom.slice(waveAddress,n[14]);
  return {...result,substitutions,descriptors,waves:Array.from({length:n[5]},(_,i)=>waveBytes.slice(i*256,(i+1)*256)),
    gains:result.gains??(planes===4?result.rom.slice(gainAddress,gainAddress+(quality==='basic'&&!options.basicCapacity?17:12)*256):new Uint8Array()),
    pattern:result.pattern??result.rom.slice(n[14],n[4]),patternAddress:n[14],settings:{...options,...(options.pdmProfile==='fractional2'?{pdmOrder:2,pdmRate:128000}:{}),...(n[21]?{end:n[19]}:{}),quality,allocationProfile:profile,releaseTails:!!n[36],parts:chosen,headroom:n[13]},warnings,
    stats:{eligible:n[0],heard:n[1],omitted:n[0]-n[1],interrupted:n[2],outOfRange:n[3],usedBytes:n[4],freeBytes:65536-n[4],wavePages:n[5],descriptors:oscillators===6?[...n.slice(6,10),n[22],n[23]]:n.slice(6,6+oscillators),...fractionalStats,...(options.pdmProfile==='fixed2'?{pdmProfile:'fixed2',inputPrecisionBits:16,inputFractionBits:8}:{}),...(n[39]?{compactSamples:true}:{}),...(options.compactSamples?{sampleStorage:planes===4?'shared-gain':'baked'}:{}),
      ...(options.basicCapacity?{basicCapacity:true,grainPolicy:'shared-used-octave',envelopePolicy:'natural'}:{}),
      ...(options.adaptiveSamples?{adaptiveSamples:true,sampleStorage:planes===4?'shared-gain':'baked'}:{}),
      ...(layout?{decoderPacking:{reservedCodeBytes:layout.reservedCodeBytes,codeBytes:layout.codeBytes,savedBytes:layout.reservedCodeBytes-layout.codeBytes,descriptorAddress,gainAddress}}:{}),
      sourceDuration:n[10],duration:n[11],durationError:n[11]-n[10],maxEventError:n[12],amplitudeSteps:n[15]||options.basicCapacity?12:16,controlRateHz:4000,sampleQuality:quality,spectralFrames:n[15]>=2?10:1,leadingSilenceRemoved:n[18]||0,
      ...(extra?{samplePointsMax:n[15]===3?512:1024,samplePointsPolicy:'expand-low-notes',expandedGrains:result.rom.slice(waveAddress-256,waveAddress).filter(value=>value===128||value===192).length}:{}),
      pcmRateHz:n[24],pdmRateHz:n[25]||null,oscillators,mixScale:n[27],amplitudeGridSeconds:n[15]||options.basicCapacity?(oscillators===6?.0075:.005):null,
      instruments:{limit:options.maxInstruments??0,candidates:n[28],selected:n[29],used:n[30],omittedNotes:n[31]},voiceAssignment:'dynamic',allocationProfile:profile,
      substitutedParts:n[32],substitutedNotes:n[33],releaseTails:!!n[36],releaseTailSeconds:n[35]||0,selectedDuration:n[10]-(n[35]||0),
      percussion:{eligible:n[37]||0,heard:n[38]||0,pcmRateHz:bank.drums?.rate??null},
      ...(n[21]?{capacityFit:{maximumEnd:n[19],limited:!!n[20],probes:n[21],resolutionSeconds:.001}}:{})}};
}
