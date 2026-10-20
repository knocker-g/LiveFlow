import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {prepareInvocation,invokePrepared,buildReadOnlyInvocation} from '../tools/prepare-readonly-invocation.mjs';
const expected={prefix:'2a5622665dc6',sourceSHA:'96a7b0dafdad3da7d22a0768fc9fc930792c21e5',commonBuildID:'96eecd1a5c3cb1bec56227a4aa1b49d833072adf532e532df9fb1e20629d6706'};
const packet='readonly_preflight_fixture';

test('actual adapter scope reproduces stageNames collision; corrected projection compiles separately',()=>{
    const source=fs.readFileSync('tools/hybrid-diagnostic-adapter.mjs','utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
    assert.throws(()=>new vm.Script(`(()=>{${source};const stageNames=[];})()`),SyntaxError);
    const built=buildReadOnlyInvocation({expected,packet});
    assert.doesNotThrow(()=>new vm.Script('('+built.code+')'));
    assert.doesNotThrow(()=>new vm.Script(built.expression));
    assert.match(built.expression,/initStageNames/);
    assert.doesNotMatch(built.code,/\bimport\s*\(/);
});

test('corrected import-free invocation executes one read-only evaluation with no action on missing identity',async()=>{
    const built=buildReadOnlyInvocation({expected,packet});
    let reads=0;
    const document={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],visibilityState:'visible'};
    const context=vm.createContext({window:{},document,performance:{timeOrigin:1},innerWidth:100,innerHeight:100,devicePixelRatio:1});
    const page={url:()=> 'https://www.youtube.com/watch?v=fixture',evaluate:async code=>{reads++;return vm.runInContext(code,context);}};
    const result=await vm.runInNewContext('('+built.code+')')(page);
    assert.equal(result.status,'BLOCKED_IDENTITY');assert.equal(result.recorderStart,0);assert.equal(reads,1);
    assert.equal(result.forbiddenActions,0);assert.equal(result.browserReleased,true);
});

test('failed generation, invalid files and authorization never reach host; valid exact bytes are sent once',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'liveflow-invocation-'));
    let calls=0;
    const invoke=async request=>{calls++;return request;};
    const authorization={packet,readOnly:true,foregroundExclusive:true};
    try{
        const filename=path.join(dir,'once.js');
        const failed=prepareInvocation({filename,packet,expected,build:()=>{throw Error('PRIVATE');}});
        assert.equal(failed.status,'OFFLINE_PREFLIGHT_FAILED');
        assert.equal((await invokePrepared(failed,{invoke,authorization})).status,'OFFLINE_PREFLIGHT_FAILED');
        assert.equal(fs.existsSync(filename),false);assert.equal(calls,0);
        const badSyntax=prepareInvocation({filename,packet,expected,build:()=>({code:'async(page)=>{const stageNames=[];const stageNames=[];}',expression:'1'})});
        assert.equal(badSyntax.status,'OFFLINE_PREFLIGHT_FAILED');assert.equal(fs.existsSync(filename),false);
        const badExpression=prepareInvocation({filename,packet,expected,build:()=>({code:'async()=>1',expression:'(()=>{const stageNames=[];const stageNames=[];})()'})});
        assert.equal(badExpression.status,'OFFLINE_PREFLIGHT_FAILED');assert.equal(fs.existsSync(filename),false);
        // A forged success receipt must not revive a failed or missing artifact.
        assert.equal((await invokePrepared({status:'READY',filename},{invoke,authorization})).status,'OFFLINE_PREFLIGHT_FAILED');
        for(const change of ['missing','empty','changed']){
            const target=path.join(dir,change+'.js'),ready=prepareInvocation({filename:target,packet,expected});
            assert.equal(ready.status,'READY');
            if(change==='missing')fs.unlinkSync(target);else fs.writeFileSync(target,change==='empty'?'':'async()=>42');
            assert.equal((await invokePrepared(ready,{invoke,authorization})).status,'OFFLINE_PREFLIGHT_FAILED');
        }
        assert.equal(calls,0);
        const ready=prepareInvocation({filename,packet,expected});
        assert.equal(ready.status,'READY');
        assert.equal((await invokePrepared(ready,{invoke,authorization:{...authorization,readOnly:false}})).status,'OFFLINE_PREFLIGHT_FAILED');assert.equal(calls,0);
        const request=await invokePrepared(ready,{invoke,authorization});
        assert.deepEqual(request,{code:fs.readFileSync(filename,'utf8')});assert.equal(calls,1);
        assert.equal((await invokePrepared(ready,{invoke,authorization})).status,'OFFLINE_PREFLIGHT_FAILED');assert.equal(calls,1);
        const existing=path.join(dir,'existing.js');fs.writeFileSync(existing,'PRESERVE');
        assert.equal(prepareInvocation({filename:existing,packet,expected}).status,'OFFLINE_PREFLIGHT_FAILED');assert.equal(fs.readFileSync(existing,'utf8'),'PRESERVE');
        const failedWithStale=prepareInvocation({filename:existing,packet,expected,build:()=>{throw Error();}});
        assert.equal((await invokePrepared(failedWithStale,{invoke,authorization})).status,'OFFLINE_PREFLIGHT_FAILED');assert.equal(calls,1);
        const uncertain=prepareInvocation({filename:path.join(dir,'uncertain.js'),packet,expected});
        await assert.rejects(invokePrepared(uncertain,{authorization,invoke:async()=>{calls++;throw Error('host failure');}}));
        assert.equal((await invokePrepared(uncertain,{invoke,authorization})).status,'OFFLINE_PREFLIGHT_FAILED');assert.equal(calls,2);
        assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
