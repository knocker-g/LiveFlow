const vm = require('node:vm');
const { createProductionBridge } = require('../../src/production-content');
const { installWorker } = require('../../src/production-worker');
const { createContentHandoff, createRenderer } = require('../../src/youtube-chat');
const nativeFixture = require('./native-facts-dom').fixture;
const { load } = require('./acquisition-harness');
const { setup } = require('./retirement-harness');
const geometry = require('../../src/geometry-adapter');
const pending = require('../../src/pending-selection');
const overlay = require('../../src/overlay-core');
const tuning = require('../../src/phase5-tuning');
const core = require('../../src/chat-read-core');

function fixture(manifest, options = {}) {
    const f = nativeFixture(), messages = [], requests = [], injections = [], schedulerJobs = [];
    const connectListeners = new Set(), clientMessages = new Set(), workerMessages = new Set();
    const disconnectClient = new Set(), disconnectWorker = new Set();
    let now = 0, nextTimer = 0, enabled = options.enabled !== false, disconnected = false, bridge, connections = 0, finishInjection;
    const timers = new Map(), binding = [], indicators = [], logs = [];
    const realm = { ...f.realm, performance: { now: () => now }, AbortController,queueMicrotask,
        crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
        setTimeout(callback, delay) { const handle = ++nextTimer; timers.set(handle,{ callback,due:now+delay }); return handle; },
        clearTimeout(handle) { timers.delete(handle); },
        fetch(url,init) { let resolve,reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); requests.push({url,init,resolve,reject}); return promise; } };
    const workerPort = { name: 'liveflow-bootstrap-private-v1', sender: { id: 'a'.repeat(32), tab: {id:7}, frameId:0,
        documentId:f.options.route.documentId, url:f.document.URL, ...options.sender },
        onMessage: { addListener: fn => workerMessages.add(fn) },
        onDisconnect: { addListener: fn => disconnectWorker.add(fn), removeListener: fn => disconnectWorker.delete(fn) },
        postMessage: value => messages.push(()=>{ for(const fn of clientMessages)fn(value); }),
        disconnect() { disconnected=true;for(const fn of disconnectClient)fn();for(const fn of disconnectWorker)fn(); } };
    const clientPort = { onMessage: {addListener:fn=>clientMessages.add(fn)},
        onDisconnect: {addListener:fn=>disconnectClient.add(fn)},
        postMessage:value=>messages.push(()=>{for(const fn of workerMessages)fn(value);}) };
    const api = { runtime: { id:'a'.repeat(32), getManifest:()=>manifest,
        onConnect:{addListener:fn=>connectListeners.add(fn)},
        connect() { connections++;messages.push(()=>{for(const fn of connectListeners)fn(workerPort);});return clientPort; } },
        scripting:{ async executeScript(args) {
            injections.push(args); if(options.permissionDenied)throw Error('denied');
            if(options.lostInjection)return new Promise(()=>{});
            const mainDocument={querySelector:()=>root};
            const root={isConnected:true,ownerDocument:mainDocument,data:{currentVideoEndpoint:{watchEndpoint:{videoId:'target'}},
                contents:{twoColumnWatchNextResults:{conversationBar:{liveChatRenderer:{isReplay:options.mode!=='live',
                    continuations:[{reloadContinuationData:{continuation:'initial'}}]}}}}}};
            const result=vm.runInNewContext(`(${args.func.toString()})()`,{document:mainDocument,window:{INNERTUBE_CONTEXT:{hl:'en'}}});
            const answer=[{frameId:0,documentId:options.resultDocument || f.options.route.documentId,result}];
            if(options.deferredInjection)return new Promise(resolve=>{finishInjection=()=>resolve(answer);});
            return answer;
        }} };
    realm.chrome=api;
    bridge=createProductionBridge({api,realm});
    const rf=load('renderer-lifecycle-seam.test.js',['fixture','settle']);
    const r=rf.fixture({observer:bridge.rendererObserver,runtimeObserver:bridge.observeDetached,animationMode:options.animationMode});
    r.state.phase3Runtime=null;r.state.phase3RuntimeVideo=null;
    realm.Element.prototype.getBoundingClientRect=r.player.constructor.prototype.getBoundingClientRect;
    f.adopt(r.player,{document:f.document,children:[r.video],classes:new Set(),queries:{'video.html5-main-video, video':[r.video]}});
    f.adopt(r.video,{document:f.document,readyState:4,ended:false,seeking:false,paused:false,position:0,rate:1});
    f.value(f.watch).queries['#movie_player, .html5-video-player']=[r.player];
    f.value(f.watch).children=[r.player,r.video,f.frame];
    if(options.mode==='live')f.value(f.child).url='https://www.youtube.com/live_chat?v=target';
    const renderer=createRenderer({...r.dependencies,recognizeAttempt:bridge.recognizeAttempt,
        isProductCurrent:bridge.privateEntry.isProductCurrent,resolveProductLease:bridge.privateEntry.resolveProductLease,
        withPresentationCleanup:bridge.privateEntry.withPresentationCleanup});
    const state={currentMessages:[],currentChatMode:options.mode||'replay',currentPageKey:'',currentPageRevision:0,
        currentPageLifecycleGeneration:0,rendererGeneration:0,runtimeSettings:r.state.runtimeSettings,
        replayDiagnosticBatch:{},replayDiagnosticBatchInProgress:false,livePresentationResumeGateActive:false};
    const originalOptions=setup({collector:true,lifetime:true,generations:true}).runtimeConfiguration;
    let runtime=null;
    const content=createContentHandoff({state,pending,overlayCore:overlay,phase5Tuning:tuning.CURRENT,performance:realm.performance,
        isEffectiveDisplayActive:()=>enabled,getCurrentMainMedia:()=>({player:r.player,video:r.video}),
        cleanupOverlay:()=>renderer.cleanupOverlay(),
        ensurePhase3Runtime() {
            if(!r.state.phase3Runtime){
                const adapter=geometry.createSubtitleGeometryAdapter({authority:geometry.createGeometryAuthority({epsilon:1}),
                    readGeometry:()=>({state:'KNOWN_EMPTY',exclusionRegions:[],capabilityAvailable:true})});
                r.state.subtitleGeometryAdapter=adapter;
                runtime=bridge.createRuntime({...originalOptions,clock:()=>now,generation:()=>r.state.rendererGeneration,
                    scheduleOneShot(callback,delay){const job={callback,delay};schedulerJobs.push(job);return job;},
                    cancelOneShot(job){job.cancelled=true;},geometryAdapter:adapter,observe:event=>logs.push(event),
                    candidateProof:(...args)=>renderer.getCandidateProof(...args),
                    launch:(entry,proof)=>bridge.launch(entry,proof,(...args)=>renderer.renderDanmaku(...args))});
                r.state.phase3Runtime=runtime;r.state.phase3RuntimeVideo=r.video;
            }return runtime;
        },ensureSubtitleGeometryObservers(){},ensurePlaybackContextObserver(){},observeLivePresentationBatch(){},
        publishReplaySchedulerDiagnostic(){},rememberReplayPendingOwner(){},privateEntry:bridge.privateEntry});
    bridge.bind({renderer,content,document:f.document,window:realm,performance:realm.performance,enabled:()=>enabled,
        setBinding:mode=>{state.currentChatMode=mode;binding.push(mode);},
        onBatch(batch,scope,handle,owner,productLease){
            options.onBatch?.({ batch, scope, handle, pendingOwner: owner, productLease, bridge, content });
            if(!options.legacyFallback&&handle&&content.registerBatch(handle))content.processRegisteredBatch(handle,productLease);
            else content.processLegacySuccess(batch,owner,scope,productLease);
        },
        setReadIndicatorState:value=>indicators.push(value)});
    if(options.install!==false)installWorker(api);
    async function flush(){for(let i=0;i<10;i++){while(messages.length)messages.shift()();await new Promise(resolve=>setImmediate(resolve));}}
    function fire(){for(let i=0;;i++){const next=[...timers].find(([,job])=>job.due<=now);if(!next)break;
        if(i>25)throw Error('unbounded timer work');timers.delete(next[0]);next[1].callback();}}
    const payload=load('acquisition-owner-replay.test.js',['payload']).payload;
    return {bridge,f,r,renderer,content,state,realm,api,workerPort,clientPort,requests,injections,schedulerJobs,timers,binding,indicators,logs,
        get runtime(){return runtime;},get disconnected(){return disconnected;},
        get connections(){return connections;},
        finishInjection:()=>finishInjection?.(),
        async start(){bridge.start();await flush();fire();await flush();},
        async answer(index=0,body=payload([0],'next','seek-next')){requests[index].resolve({status:200,json:async()=>body});await flush();bridge.inspect();},
        async tick(value){now=value;bridge.synchronize();fire();await flush();},
        launch(){const job=schedulerJobs.find(job=>!job.cancelled&&!job.fired);if(job){job.fired=true;job.callback();}bridge.inspect();},
        async settle(index=0,rejected=false){rejected?r.animations[index].reject(Error('native')):r.animations[index].resolve();await rf.settle();return bridge.inspect();},
        setEnabled(value){enabled=value;},flush,fire,
        livePayload(token='next'){return{continuationContents:{liveChatContinuation:{actions:[{addChatItemAction:{item:{
            liveChatTextMessageRenderer:{id:'live',message:{runs:[{text:'hello'}]}}}}}],continuations:[{timedContinuationData:{continuation:token,timeoutMs:1000}}]}}};}
    };
}
module.exports={fixture};
