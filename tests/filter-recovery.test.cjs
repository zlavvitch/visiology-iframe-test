const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const currentCode=fs.readFileSync(path.join(root,'visiology/filter-bridge.js'),'utf8');
// Keep the original regression fixture independent of the active dashboard config.
const code=currentCode.replace(/defaultFilterId: 'med_org'/, "defaultFilterId: 'hospitals'").replace(/        filters: \{[\s\S]*?\n    };/, `        filters: { dates: {guid: '49649e68eaaf4b37a20a88a9f33681b3', mode:'date',allowedValues:null,allowClear:true,useTime:false}, hospitals:{guid:'e2fed87a050646b4a405891db926f42a',mode:'multiple',allowedValues:['ГКБ 1','ГКБ 15'],allowClear:true} }
    };`);
const guids={dates:'49649e68eaaf4b37a20a88a9f33681b3',hospitals:'e2fed87a050646b4a405891db926f42a'};
const defaults=['2026-03-15T21:00:00.000Z','2026-10-12T20:59:59.999Z'];
function setup(options={}) {
 const output=[], calls=[], handlers=new Set(), scheduled=[];
 const actual={ [guids.dates]:[['2026-03-16T00:00:00.000Z','2026-10-12T00:00:00.000Z']], [guids.hospitals]:[['ГКБ 1'],['ГКБ 15']] };
 const host={postMessage:m=>output.push(m)};
 const win={location:{origin:'https://sc.emias.ru'},parent:host,addEventListener:(t,f)=>{if(t==='message')handlers.add(f)},removeEventListener:(t,f)=>{if(t==='message')handlers.delete(f)}};
 let context;
 const apply=(g,v)=> {actual[g]=v;};
 const api={getSelectedValues:g=>actual[g],onWidgetLoadedListener:(cfg,f)=>f(),setDateFilterSelectedValues:(g,v,useTime)=>{
   calls.push({g,v,useTime});
   if(options.rerender)vm.runInContext(code,context);
   if(!options.neverConfirm) scheduled.push(setTimeout(()=>apply(g,[v.map(d=>new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())).toISOString())]),5));
 },setFilterSelectedValues:(g,v,cb)=>{calls.push({g,v});apply(g,v);cb();}};
 context=vm.createContext({window:win,visApi:()=>api,Date,setTimeout,clearTimeout,setInterval,clearInterval});
 vm.runInContext(options.fastTimeout?code.replace('confirmationTimeoutMs: 10000','confirmationTimeoutMs: 30'):code,context);
 const send=(data,origin='https://visiology-iframe-test.vercel.app')=>{for(const fn of [...handlers])fn({origin,source:host,data:{channel:'visiology-filter-test-v1',session:'test-session',...data}})};
 send({type:'HELLO'});
 return {output,calls,send,actual,handlers,win,context,close:()=>{win.__visiologyReactFilterBridge.dispose();scheduled.forEach(clearTimeout)}};
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('reported UTC-midnight dates equal original Moscow calendar range without writes',()=>{
 const t=setup();try {t.send({type:'SET_FILTERS',requestId:'1',filters:{dates:defaults,hospitals:['ГКБ 1','ГКБ 15']}});assert.equal(t.output.at(-1).type,'RESULT');assert.equal(t.calls.length,0);}finally{t.close();}
});
test('widget rerender during async date update preserves command and permits next batch',async()=>{
 const t=setup({rerender:true});try {
 const id=t.output[0].instanceId;
 t.send({type:'SET_FILTERS',requestId:'1',filters:{dates:['2026-10-04T21:00:00.000Z'],hospitals:['ГКБ 1']}});
 await delay(250);
 assert.equal(t.output.at(-1).type,'RESULT');assert.equal(t.output.at(-1).instanceId,id);assert.equal(t.calls[0].useTime,false);assert.equal(t.handlers.size,1);
 t.send({type:'SET_FILTERS',requestId:'2',filters:{dates:defaults,hospitals:['ГКБ 15']}});
 await delay(250);assert.equal(t.output.at(-1).type,'RESULT');assert.equal(t.output.at(-1).requestId,'2');assert.equal(t.calls.length,4);
 }finally{t.close();}
});
test('wrong day is not accepted; timeout returns observed and next hospital command works',async()=>{
 const t=setup({neverConfirm:true,fastTimeout:true});try {
 t.send({type:'SET_FILTERS',requestId:'1',filters:{dates:['2026-10-04T21:00:00.000Z'],hospitals:['ГКБ 1']}});
 await delay(60);assert.equal(t.output.at(-1).type,'ERROR');assert.equal(t.output.at(-1).failedFilterId,'dates');assert.ok(t.output.at(-1).observed);assert.equal(t.calls.length,1);
 t.send({type:'SET_FILTERS',requestId:'2',filters:{hospitals:['ГКБ 1']}});assert.equal(t.output.at(-1).type,'RESULT');
 }finally{t.close();}
});
test('validation and origin guard prevent changes',()=>{
 const t=setup();try {
 t.send({type:'SET_FILTERS',requestId:'1',filters:{dates:defaults,hospitals:['unknown']}});assert.equal(t.output.at(-1).type,'ERROR');assert.equal(t.calls.length,0);
 const count=t.output.length;t.send({type:'SET_FILTERS',requestId:'2',filters:{hospitals:['ГКБ 1']}},'https://other.example');assert.equal(t.output.length,count);
 }finally{t.close();}
});
test('host heartbeat restores a restarted bridge without replaying SET_FILTERS',()=>{
 const main=fs.readFileSync(path.join(root,'src/main.jsx'),'utf8');
 const body=main.split('  useEffect(() => {')[1].split('  }, [frame]);')[0];
 const messages=[],logs=[],timers=[],cleared=[],state={};let receive;
 const oldSource={},newSource={};
 const env={frame:{origin:'https://sc.emias.ru',session:'s'},CHANNEL:'visiology-filter-test-v1',FILTERS:guids,MODES:{dates:'date',hospitals:'multiple'},
 iframeRef:{current:{contentWindow:{postMessage:m=>messages.push(m)}}},bridgeRef:{current:null},instanceRef:{current:null},pendingRef:{current:null},recoverRef:{current:null},
 inspectRecipient:()=> 'cross-origin',setReady:v=>state.ready=v,setBusy:v=>state.busy=v,setStatus:v=>state.status=v,log:v=>logs.push(v),
 window:{addEventListener:(t,f)=>receive=f,removeEventListener:()=>{}},setInterval:f=>{timers.push(f);return 1},clearInterval:()=>{},clearTimeout:v=>cleared.push(v)};
 const cleanup=vm.runInNewContext('(function(){'+body+'})()',env);
 const reply=(source,instanceId,extra={})=>receive({origin:env.frame.origin,source,data:{type:'READY',channel:env.CHANNEL,session:'s',instanceId,filters:{dates:{guid:guids.dates,mode:'date'},hospitals:{guid:guids.hospitals,mode:'multiple'}},...extra}});
 reply(oldSource,'old');assert.equal(state.ready,true);
 env.pendingRef.current={requestId:'r',timer:7};state.busy=true;
 timers[0]();assert.equal(messages.length,2);assert.equal(messages[1].type,'HELLO');
 reply(newSource,'new');assert.equal(state.busy,false);assert.equal(env.pendingRef.current,null);assert.equal(state.ready,true);assert.ok(cleared.includes(7));assert.equal(messages.filter(m=>m.type==='SET_FILTERS').length,0);
 const n=logs.length;reply(newSource,'new');assert.equal(logs.length,n);
 env.recoverRef.current();reply(newSource,'new');assert.equal(state.ready,true);cleanup();
});

test('current five-filter configuration applies defaults, clears MO and rejects multiple doctor values',()=>{
 const out=[], actual={}, calls=[], handlers=[];
 const host={postMessage:m=>out.push(m)};
 const win={location:{origin:'https://sc.emias.ru'},parent:host,addEventListener:(t,f)=>{if(t==='message')handlers.push(f)},removeEventListener:()=>{}};
 const api={getSelectedValues:g=>actual[g]||[],onWidgetLoadedListener:(c,f)=>f(),
 setFilterSelectedValues:(g,v,cb)=>{calls.push(g);actual[g]=v;cb();},
 setDateFilterSelectedValues:(g,v)=>{assert.notEqual(g,'470ae632a05c455ea79715236b4a195b');calls.push(g);actual[g]=[v.map(d=>new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())).toISOString())];}};
 vm.runInNewContext(currentCode,{window:win,visApi:()=>api,Date,setTimeout,clearTimeout,setInterval,clearInterval});
 const send=m=>handlers.forEach(f=>f({origin:'https://visiology-iframe-test.vercel.app',source:host,data:{channel:'visiology-filter-test-v1',session:'s',...m}}));
 try {
 send({type:'HELLO'});
 assert.deepEqual(Object.keys(out[0].filters),['med_org','doctors','positions','months','dates']);
 actual[out[0].filters.med_org.guid]=[['МО тест']];
 send({type:'SET_FILTERS',requestId:'1',filters:{med_org:[],doctors:['Абаева М. П.'],positions:['Врач-терапевт участковый'],months:['2026-09-01T00:00:00Z'],dates:['2026-07-31T21:00:00.000Z','2026-09-30T20:59:59.999Z']}});
 assert.equal(out.at(-1).type,'RESULT');assert.equal(calls.length,5);
 assert.equal(out[0].filters.months.mode,'single');
 assert.equal(JSON.stringify(actual[out[0].filters.months.guid]),'[["2026-09-01T00:00:00Z"]]');
 assert.equal(JSON.stringify(actual[out[0].filters.med_org.guid]),'[]');
 send({type:'SET_FILTERS',requestId:'2',filters:{doctors:['А','Б']}});
 assert.equal(out.at(-1).type,'ERROR');assert.equal(calls.length,5);
 } finally {win.__visiologyReactFilterBridge.dispose();}
});

test('receiver reports missing load events without declaring READY',()=>{
 const out=[], handlers=[], loaded=[];
 const host={postMessage:m=>out.push(m)};
 const win={location:{origin:'https://sc.emias.ru'},parent:host,addEventListener:(t,f)=>{if(t==='message')handlers.push(f)},removeEventListener:()=>{}};
 const api={getSelectedValues:()=>[],onWidgetLoadedListener:(c,f)=>loaded.push(f)};
 vm.runInNewContext(currentCode,{window:win,visApi:()=>api,Date,setTimeout,clearTimeout,setInterval,clearInterval});
 const hello=()=>handlers.forEach(f=>f({origin:'https://visiology-iframe-test.vercel.app',source:host,data:{channel:'visiology-filter-test-v1',session:'s',type:'HELLO'}}));
 try {
 hello();assert.equal(out.at(-1).type,'WAITING');assert.equal(out.at(-1).waitingFor.length,5);
 loaded[0]();assert.equal(out.at(-1).waitingFor.length,4);
 loaded.slice(1).forEach(f=>f());assert.equal(out.at(-1).type,'READY');
 } finally {win.__visiologyReactFilterBridge.dispose();}
});
