'use strict';
const permissions = Object.freeze(['storage','scripting']);
const hosts = Object.freeze(['https://www.youtube.com/*','https://youtube.com/*']);
const background = Object.freeze({service_worker:'dist/worker.js'});
const scripts = Object.freeze([Object.freeze({matches:hosts,js:Object.freeze(['dist/content.js']),world:'ISOLATED',run_at:'document_idle'})]);
function exactManifest(manifest) {
    const keys=(value,expected)=>value && JSON.stringify(Object.keys(value).sort())===JSON.stringify([...expected].sort());
    const entry=manifest?.content_scripts?.[0];
    return Boolean(manifest?.manifest_version === 3 && !manifest.oauth2 && !manifest.externally_connectable &&
        !manifest.web_accessible_resources?.length && JSON.stringify(manifest.permissions) === JSON.stringify(permissions) &&
        JSON.stringify(manifest.host_permissions) === JSON.stringify(hosts) &&
        keys(manifest.background,['service_worker']) && manifest.background.service_worker===background.service_worker &&
        Array.isArray(manifest.content_scripts) && manifest.content_scripts.length===1 &&
        keys(entry,['matches','js','world','run_at']) && JSON.stringify(entry.matches)===JSON.stringify(hosts) &&
        JSON.stringify(entry.js)===JSON.stringify(scripts[0].js) && entry.world==='ISOLATED' && entry.run_at==='document_idle');
}
module.exports=Object.freeze({exactManifest});
