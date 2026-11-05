// Reuse existing deterministic environments. No Product source is transformed.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
function load(name, exports = ['harness', 'payload']) {
    const filename = path.resolve(__dirname, '..', name);
    let source = fs.readFileSync(filename, 'utf8').split('\ntest(')[0];
    source = source.replace('const owner = createOwner(config), channel',
        'if (options.configure) options.configure(config);\n    const owner = createOwner(config), channel');
    source = source.replace('const owner = createOwner(config); assert.ok(owner);',
        'if (options.configure) options.configure(config);\n    const owner = createOwner(config); assert.ok(owner);');
    source = source.replace('const owner = createLiveAcquisitionOwner(config);',
        'if (options.configure) options.configure(config);\n    const owner = createLiveAcquisitionOwner(config);');
    const instance = new Module(filename, module);
    instance.filename = filename; instance.paths = Module._nodeModulePaths(path.dirname(filename));
    instance._compile(source + '\nmodule.exports = { ' + exports.join(', ') + ' };', filename);
    return instance.exports;
}
module.exports = { load };
