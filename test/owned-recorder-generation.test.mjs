import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {passiveObservationExpression} from '../tools/hybrid-diagnostic-adapter.mjs';
import {recorderCommandPage} from '../tools/passive-recorder-scenario.mjs';

test('actual generator Recorder transform parses with ownership and bridge dependencies, no build',()=>{
    const generator=fs.readFileSync('tools/build-density-comparison.mjs','utf8');
    const start=generator.indexOf("        source = replaceOnce(source, '    const phase5Tuning");
    const end=generator.indexOf("        source = replaceOnce(source, '            Boolean",start);
    assert.ok(start>0&&end>start);
    const recorder=fs.readFileSync('tools/density-comparison/recorder.js','utf8')+'\n'+
        ['owned-recorder.mjs','recorder-bridge.mjs'].map(n=>fs.readFileSync('tools/density-comparison/'+n,'utf8').replaceAll('export function ','function ')).join('\n');
    const context=vm.createContext({source:fs.readFileSync('src/youtube-chat.js','utf8'),recorder,
        identity:{candidate:'D',sourceSHA:'a'.repeat(40),commonBuildID:'b'.repeat(64),buildID:'c'.repeat(64)},config:{},selector:'return ()=>null;',
        replaceOnce(s,b,a){assert.equal(s.split(b).length,2);return s.replace(b,a);}});
    vm.runInContext(generator.slice(start,end),context);
    assert.doesNotThrow(()=>new vm.Script(context.source));
    assert.match(context.source,/const comparisonRecorder = createOwnedRecorder/);
    assert.match(context.source,/installRecorderBridge\(comparisonRecorder/);
    for(const file of ['owned-recorder.mjs','recorder-bridge.mjs'])assert.ok(generator.includes("'tools/density-comparison/"+file+"'"));
});
test('passive serialization includes private shared mapper and actual read helpers',()=>{
    const expected={prefix:'c'.repeat(12),sourceSHA:'a'.repeat(40),commonBuildID:'b'.repeat(64)};
    const expression=passiveObservationExpression({expected,before:{documentKey:'1'},operationId:'op',capability:'a'.repeat(32),durationMs:1});
    assert.doesNotThrow(()=>new vm.Script(expression));
    assert.match(expression,/function mapQualifiedDiagnostics/);assert.match(expression,/function mapPassiveDiagnostics/);
});
test('diagnostic request listener is released when posting fails',async()=>{
    const listeners=new Set(),timers=new Set();
    const c=vm.createContext({window:{addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),postMessage(){throw Error();}},
        location:{origin:'fixture'},performance:{timeOrigin:1},setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn)});
    const r=await vm.runInContext('('+recorderCommandPage+')({documentKey:"1"})',c);
    assert.equal(r.state,'CLEANUP_UNKNOWN');assert.equal(listeners.size,0);assert.equal(timers.size,0);
});
test('dev-only lifecycle modules contain no Product/network/playback/Seek calls',()=>{
    for(const f of ['tools/density-comparison/owned-recorder.mjs','tools/density-comparison/recorder-bridge.mjs','tools/passive-recorder-scenario.mjs']){
        const s=fs.readFileSync(f,'utf8');assert.doesNotMatch(s,/\b(fetch|XMLHttpRequest|startReadLoop|cleanupOverlay|authorizeReplayAuthority|dispatchReplay|queueReplayReanchor)\s*\(/);
        assert.doesNotMatch(s,/\.currentTime\s*=|\.play\(|\.pause\(|slider\.click/);
    }
});
