import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMidiDevices}from'../devices-view.js';
import {WebMidiPorts}from'../web-midi.js';
class Element{
 constructor(tag,document){this.tag=tag;this.ownerDocument=document;this.children=[];this.attributes={};this.classList={add(){}};this._text='';}
 set textContent(v){this._text=v;this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 setAttribute(k,v){this.attributes[k]=v;}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];this._text='';}
}
const walk=n=>[n,...n.children.flatMap(walk)];
class Port extends EventTarget{constructor(id,type){super();Object.assign(this,{id,type,name:'<img src=x onerror=alert(1)>',state:'connected',connection:'closed',sent:[]});}async open(){this.connection='open';return this;}async close(){this.connection='closed';return this;}clear(){}send(data,time=0){this.sent.push({data:[...data],time});}}
class Live extends EventTarget{constructor(ports){super();this.ports=ports;this.volume=.55;this.state='stopped';this.starts=0;}async start(){this.starts++;this.state='running';this.dispatchEvent(new CustomEvent('statechange'));}async stop(){this.state='stopped';this.dispatchEvent(new CustomEvent('statechange'));}async panic(){this.panics=(this.panics||0)+1;}}
test('shared device view requests no access on mount and routes explicit selection, Thru, raw output and stop',async()=>{
 const document={createElement:tag=>new Element(tag,document)},container=new Element('div',document),a=new Port('in','input'),b=new Port('out','output'),access=new EventTarget();Object.assign(access,{inputs:new Map([['in',a]]),outputs:new Map([['out',b]]),sysexEnabled:false});let requests=0,options;
 const ports=new WebMidiPorts({navigator:{requestMIDIAccess:async o=>{requests++;options=o;return access;}}}),live=new Live(ports),cleanup=renderMidiDevices(container,live);
 const byText=text=>walk(container).find(n=>n.tag==='button'&&n.textContent===text),byLabel=text=>walk(container).find(n=>n.attributes['aria-label']===text);
 assert.equal(requests,0);assert.equal(live.starts,0);byLabel('Разрешить SysEx').checked=true;await byText('Разрешить MIDI').onclick();assert.equal(requests,1);assert.equal(options.sysex,true);assert.equal(ports.input,null);assert.equal(ports.output,null);
 const input=byLabel('MIDI-вход'),output=byLabel('MIDI-выход');assert.equal(input.children[1].textContent,a.name);assert.equal(walk(container).some(n=>n.tag==='img'),false);
 input.value='in';await input.onchange();output.value='out';await output.onchange();assert.equal(ports.input,a);assert.equal(ports.output,b);
 const thru=byLabel('MIDI Thru: вход → выход');thru.checked=true;thru.onchange();assert.equal(ports.thru,true);
 const raw=byLabel('MIDI-команда в hex');raw.value='90 3C 64';await byText('Отправить на выход').onclick();assert.deepEqual(b.sent[0].data,[0x90,60,100]);raw.value='bad';await byText('Отправить на выход').onclick();assert.match(container.textContent,/Введите MIDI-байты/);
 await byText('Включить звук входа').onclick();assert.equal(live.state,'running');await byText('Выключить все ноты').onclick();assert.equal(live.panics,1);
 ports.dispatchEvent(new CustomEvent('midimessage',{detail:{data:Uint8Array.of(0xf8)}}));assert.match(container.textContent,/Вход: 1 сообщений/);assert.match(container.textContent,/F8/);
 await byText('Выключить звук входа').onclick();assert.equal(live.state,'stopped');cleanup();const before=container.textContent;ports.dispatchEvent(new CustomEvent('midimessage',{detail:{data:Uint8Array.of(0xfe)}}));assert.equal(container.textContent,before);await ports.dispose();
});
test('device view explains unsupported Web MIDI and disables the request button',()=>{
 const document={createElement:tag=>new Element(tag,document)},container=new Element('div',document),ports=new WebMidiPorts({navigator:{}}),live=new Live(ports),cleanup=renderMidiDevices(container,live);
 assert.match(container.textContent,/Web MIDI недоступен/);assert.equal(walk(container).find(n=>n.tag==='button'&&n.textContent==='Разрешить MIDI').disabled,true);cleanup();
});
