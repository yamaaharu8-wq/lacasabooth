const { app, BrowserWindow } = require('electron');

// 🟢 Menjalankan server mesin utama Anda (index.js) di latar belakang
require('./index.js'); 

let mainWindow;

function createWindow () {
    // Membuat jendela aplikasi Windows/Mac
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        autoHideMenuBar: true, // Menyembunyikan menu bar bawaan agar terlihat profesional
        fullscreen: false, // Ubah ke true nanti jika ingin mode Kiosk (Layar penuh terkunci)
        icon: __dirname + '/public/assets/favicon.ico', // Bebas diganti jika punya logo
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // 🟢 Mengarahkan jendela desktop untuk membuka server lokal kita
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:5513/menu.html'); 
    }, 1500);
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Tutup aplikasi sepenuhnya jika jendela di-close
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});