const bytenode = require('bytenode');
const path = require('path');

// Compile index.js menjadi index.jsc
bytenode.compileFile({
    filename: path.join(__dirname, 'index.js'),
    output: path.join(__dirname, 'index.jsc')
});

console.log("✅ Kompilasi Bytenode berhasil menggunakan mesin Electron!");