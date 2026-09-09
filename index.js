const { app: electronApp, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const koffi = require('koffi');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const { google } = require('googleapis');
const { autoUpdater } = require('electron-updater');

// Atur agar auto-update berjalan diam-diam tanpa mengganggu klien
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
// 1. DEKLARASIKAN FOLDER AMAN UNTUK MENULIS DATA (AppData)
const userDataPath = electronApp.getPath('userData');

// 2. UBAH PATH DINAMIS MENGGUNAKAN userDataPath
const TOKEN_PATH = path.join(userDataPath, 'token.json');
const CREDENTIALS_PATH = path.join(userDataPath, 'oauth_credentials.json');

// --- [BARU] AUTO-COPY CREDENTIALS JSON DARI KEMASAN KE APPDATA KLIEN ---
// Cek mode production (isPackaged) vs mode development
const defaultCredentialsPath = electronApp.isPackaged 
    ? path.join(process.resourcesPath, 'oauth_credentials.json') 
    : path.join(__dirname, 'oauth_credentials.json');

// Jika di AppData belum ada, salin dari file bawaan installer
if (!fs.existsSync(CREDENTIALS_PATH)) {
    if (fs.existsSync(defaultCredentialsPath)) {
        try {
            fs.copyFileSync(defaultCredentialsPath, CREDENTIALS_PATH);
            console.log("✅ oauth_credentials.json bawaan berhasil disalin ke PC Klien.");
        } catch (err) {
            console.error("Gagal menyalin oauth_credentials bawaan:", err);
        }
    }
}
// ----------------------------------------------------------------------

const sharp = require('sharp');
const multer = require('multer');
const { exec, spawn } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const os = require('os'); 
const printQueue = [];
let isPrinting = false; 

// =======================================================
// SETUP GLOBAL GOOGLE OAUTH CLIENT
// =======================================================
let oauth2Client = null;

function initGoogleAuth() {
    try {
        if (fs.existsSync(CREDENTIALS_PATH)) {
            const fileContent = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
            const credentials = JSON.parse(fileContent);
            const keys = credentials.installed || credentials.web;
            
            oauth2Client = new google.auth.OAuth2(
            keys.client_id,
            keys.client_secret,
            'http://localhost:3000/api/auth-google-callback' 
        );
        console.log("🟢 Kredensial G-Drive berhasil dimuat secara global.");
        }
    } catch (error) {
        console.error("🔴 Gagal memuat oauth_credentials.json:", error.message);
    }
}
initGoogleAuth(); 

let uploadToDrive = null; 
try {
    const driveModule = require('./drive_service'); 
    uploadToDrive = driveModule.uploadToDrive;
    
    const frameLoader = require('./src/services/frameLoader');
    const collageRoutes = require('./src/routes/collageRoutes');
} catch (e) {
    console.log("Info: Modul eksternal (Drive/Collage) diabaikan sementara.");
}

// =======================================================
// 1. INISIASI EXPRESS SERVER & FOLDER
// =======================================================
const expressApp = express();
const server = http.createServer(expressApp); 
const io = new Server(server, { cors: { origin: '*' } }); 

// 3. PISAHKAN FOLDER DINAMIS & FOLDER BAWAAN APLIKASI
// Dinamis (Bisa ditulis/diubah):
const uploadDir = path.join(userDataPath, 'uploads');
const tempDir = path.join(userDataPath, 'temp_uploads');
const frameDir = path.join(userDataPath, 'frames'); 
const settingsPath = path.join(userDataPath, 'settings.json');
const eventsPath = path.join(userDataPath, 'events.json');
// ---------------------------------------------------------
// AUTO-COPY DATABASE FRAME KE APPDATA KLIEN
// ---------------------------------------------------------
const dbPath = path.join(userDataPath, 'database_frame.json');
const defaultDbPath = path.join(__dirname, 'database_frame.json');

// Jika klien belum punya database di PC-nya, sistem akan menyalin dari file bawaan
if (!fs.existsSync(dbPath)) {
    try {
        if (fs.existsSync(defaultDbPath)) {
            fs.copyFileSync(defaultDbPath, dbPath);
            console.log("✅ Database frame bawaan berhasil disalin ke PC Klien.");
        } else {
            // Jaga-jaga jika file asli terhapus, buat struktur kosong
            fs.writeFileSync(dbPath, JSON.stringify({ "1": [], "2": [], "4": [], "6": [] }, null, 4));
            console.log("⚠️ Database frame kosong baru dibuat.");
        }
    } catch (err) {
        console.error("Gagal menyalin database frame:", err);
    }
}

// ---------------------------------------------------------
// [BARU] AUTO-COPY FILE GAMBAR TEMPLATE KE APPDATA KLIEN
// ---------------------------------------------------------
const defaultFramesDir = path.join(__dirname, 'frames');

// Pastikan folder frames di AppData sudah ada sebelum mulai menyalin
if (!fs.existsSync(frameDir)) {
    fs.mkdirSync(frameDir, { recursive: true });
}

// Proses menyalin gambar satu per satu dari dalam installer ke PC klien
if (fs.existsSync(defaultFramesDir)) {
    const files = fs.readdirSync(defaultFramesDir);
    files.forEach(file => {
        const srcFile = path.join(defaultFramesDir, file);
        const destFile = path.join(frameDir, file);
        
        // Salin gambar HANYA jika file tersebut belum ada di PC klien
        if (!fs.existsSync(destFile)) {
            try {
                fs.copyFileSync(srcFile, destFile);
                console.log(`✅ Gambar template bawaan disalin: ${file}`);
            } catch (err) {
                console.error(`Gagal menyalin gambar ${file}:`, err);
            }
        }
    });
}
// ---------------------------------------------------------

// Bawaan (Hanya dibaca dari dalam asar):
const uiDir = path.join(__dirname, 'UI'); 
const assetsDir = path.join(uiDir, 'assets');
const thumbDir = path.join(uiDir, 'assets', 'thumbs');

// 4. HAPUS PEMBUATAN FOLDER UNTUK uiDir, assetsDir, dan thumbDir
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(settingsPath)) {
    const defaultSettings = {
        photobox: { sessionTimer: 300 },
        collage: { timer: 5, sessionTimer: 300, maxRetake: 3 },
        newspaper: { sessionTimer: 300, maxRetake: 0 },
        global: {
            theme: "theme-pop-art", // Tema default agar UI tidak rusak
            customIdleScreen: null,
            extraPrintPrice: 15000,
            cameraEngine: "canon",
            cameraPort: "",
            liveViewBrightness: 100,
            flashWorkaround: true,
            livePhotoEnabled: false,
            cloudStorage: true,
            driveParentFolderId: "",
            printer4R: "",
            printerA4: ""
        },
        waMessage: "Halo dari Lacasaphoto! 📸\n\nTerima kasih sudah berfoto ria bersama kami. Berikut link foto kamu:\n\n🔗 {link}"
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
    console.log("⚠️ File settings.json default baru dibuat.");
}
if (!fs.existsSync(eventsPath)) {
    fs.writeFileSync(eventsPath, JSON.stringify({ events: [] }, null, 2));
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}
// Middleware Express
expressApp.use(express.json({ limit: '50mb' }));
expressApp.use(express.urlencoded({ limit: '50mb', extended: true }));
expressApp.use(express.static(uiDir)); // Membuka akses folder UI
expressApp.use('/uploads', express.static(uploadDir));
expressApp.use('/frames', express.static(frameDir));
expressApp.use('/assets', express.static(assetsDir));

const upload = multer({ dest: tempDir });

// Variabel Global
global.lastCaptureMode = 'wedding'; 
global.fotoWeddingTerbaru = null;
global.currentMirrorStatus = false;
let activeEvent = null; 

let activeSessionId = 'DEFAULT_SESSION';

// =======================================================
// FUNGSI PENCARI LOKASI BROWSER OTOMATIS
// =======================================================
function getBrowserPath() {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' // Fallback ke Microsoft Edge
    ];

    for (let p of paths) {
        if (fs.existsSync(p)) return p;
    }
    
    console.log("⚠️ Peringatan: Chrome/Edge tidak ditemukan di lokasi standar.");
    return null; // Biarkan Puppeteer mencoba mencari sendiri jika semua path gagal
}
// =======================================================
// 2. 🤖 SISTEM WHATSAPP BOT LOKAL
// =======================================================
const waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(userDataPath, 'wa_session') }), 
    puppeteer: {
        headless: true,
       executablePath: getBrowserPath(),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-gpu', 
            '--disable-dev-shm-usage',
            '--disable-extensions'
        ]
    },
    webVersionCache: { type: 'none' } 
});

let waBotStatus = 'STARTING';
let waBotQr = '';

waClient.on('qr', (qr) => {
    console.log('[WA] QR Code tersedia. Silakan scan melalui Dashboard.');
    waBotStatus = 'QR_READY';
    waBotQr = qr;
});

waClient.on('ready', () => {
    console.log('[WA] ✅ Bot WhatsApp Siap Digunakan!');
    waBotStatus = 'READY';
    waBotQr = '';
});

waClient.on('authenticated', () => {
    console.log('[WA] Autentikasi berhasil!');
    waBotStatus = 'AUTHENTICATED';
});

waClient.on('disconnected', (reason) => {
    console.log('[WA] Terputus:', reason);
    waBotStatus = 'DISCONNECTED';
    waBotQr = '';
    waClient.initialize(); 
});

waClient.initialize();

expressApp.get('/api/wa-status', (req, res) => {
    res.json({ status: waBotStatus, qr: waBotQr });
});

expressApp.post('/api/wa-logout', async (req, res) => {
    try {
        await waClient.logout();
        waBotStatus = 'STARTING';
        waBotQr = '';
        waClient.initialize();
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// =======================================================
// 3. 🔌 INISIALISASI MESIN CANON EDSDK & LIVE VIEW
// =======================================================
const sdkPath = path.join(__dirname, 'sdk', 'EDSDK.dll').replace('app.asar', 'app.asar.unpacked');
const edsdk = koffi.load(sdkPath);
koffi.alias('EdsError', 'uint32'); 
const EdsBaseRef = koffi.pointer('EdsBaseRef', koffi.opaque());
const EdsCapacity = koffi.struct('EdsCapacity', { numberOfFreeClusters: 'int32', bytesPerSector: 'int32', reset: 'int32' });

const EdsInitializeSDK = edsdk.func('EdsError EdsInitializeSDK()');
const EdsGetCameraList = edsdk.func('EdsError EdsGetCameraList(_Out_ EdsBaseRef* outCameraListRef)');
const EdsGetChildCount = edsdk.func('EdsError EdsGetChildCount(EdsBaseRef inRef, _Out_ uint32* outCount)');
const EdsGetChildAtIndex = edsdk.func('EdsError EdsGetChildAtIndex(EdsBaseRef inRef, int32 inIndex, _Out_ EdsBaseRef* outChildRef)');
const EdsOpenSession = edsdk.func('EdsError EdsOpenSession(EdsBaseRef inCameraRef)');
const EdsSendCommand = edsdk.func('EdsError EdsSendCommand(EdsBaseRef inCameraRef, uint32 inCommand, int32 inParam)');
const EdsSetPropertyData = edsdk.func('EdsError EdsSetPropertyData(EdsBaseRef inRef, uint32 inPropertyID, int32 inParam, uint32 inPropertySize, const void* inPropertyData)');
const EdsSetCapacity = edsdk.func('EdsError EdsSetCapacity(EdsBaseRef inCameraRef, EdsCapacity inCapacity)'); 
const EdsCreateFileStream = edsdk.func('EdsError EdsCreateFileStream(const char* inFileName, int32 inCreateDisposition, int32 inDesiredAccess, _Out_ EdsBaseRef* outStream)');
const EdsDownload = edsdk.func('EdsError EdsDownload(EdsBaseRef inDirItemRef, uint32 inReadSize, EdsBaseRef inStream)');
const EdsDownloadComplete = edsdk.func('EdsError EdsDownloadComplete(EdsBaseRef inDirItemRef)');
const EdsGetDirectoryItemInfo = edsdk.func('EdsError EdsGetDirectoryItemInfo(EdsBaseRef inDirItemRef, _Out_ void* outDirItemInfo)');
const EdsRelease = edsdk.func('uint32 EdsRelease(EdsBaseRef inRef)');
const EdsCreateMemoryStream = edsdk.func('EdsError EdsCreateMemoryStream(uint32 inBufferSize, _Out_ EdsBaseRef* outStream)');
const EdsCreateEvfImageRef = edsdk.func('EdsError EdsCreateEvfImageRef(EdsBaseRef inStream, _Out_ EdsBaseRef* outEvfImageRef)');
const EdsDownloadEvfImage = edsdk.func('EdsError EdsDownloadEvfImage(EdsBaseRef inCameraRef, EdsBaseRef inEvfImageRef)');
const EdsGetPointer = edsdk.func('EdsError EdsGetPointer(EdsBaseRef inStream, _Out_ void** outPointer)');
const EdsGetLength = edsdk.func('EdsError EdsGetLength(EdsBaseRef inStream, _Out_ uint32* outLength)');
const EdsObjectEventHandler = koffi.proto('EdsError EdsObjectEventHandler(uint32 inEvent, EdsBaseRef inRef, void* inContext)');
const EdsSetObjectEventHandler = edsdk.func('EdsError EdsSetObjectEventHandler(EdsBaseRef inCameraRef, uint32 inEvent, EdsObjectEventHandler* inObjectEventHandler, void* inContext)');

const kEdsCameraCommand_TakePicture = 0x00000000;
let activeCamera = null; 
let latestLvBuffer = null;
let lvInterval = null;
let isEdsdkInitialized = false;

function hubungkanKamera() {
    console.log("Mencari kamera via USB...");
    if (!isEdsdkInitialized) {
        if (EdsInitializeSDK() !== 0) return console.log("❌ Gagal menyalakan EDSDK");
        isEdsdkInitialized = true; 
    }

    let cameraList = [null]; EdsGetCameraList(cameraList);
    let count = [0]; EdsGetChildCount(cameraList[0], count);
    
    if (count[0] === 0) {
        activeCamera = null;
        return console.log("⚠️ Tidak ada kamera terdeteksi! Pastikan EOS M50 menyala.");
    }
    
    let camera = [null]; EdsGetChildAtIndex(cameraList[0], 0, camera);
    activeCamera = camera[0];

    if (EdsOpenSession(activeCamera) === 0) {
        console.log("✅ BERHASIL MASUK! Kamera Canon siap dikendalikan.");
        const saveTo = Buffer.alloc(4); saveTo.writeUInt32LE(2); 
        EdsSetPropertyData(activeCamera, 0x000B, 0, 4, saveTo);
        const kapasitasPC = { numberOfFreeClusters: 0x7FFFFFFF, bytesPerSector: 512, reset: 1 };
        EdsSetCapacity(activeCamera, kapasitasPC);
        EdsSetObjectEventHandler(activeCamera, 0x0200, callbackPenarikFoto, null);
    } else {
        console.log("❌ Gagal membuka sesi kamera. Coba cabut-colok USB.");
    }
}

// TAMBAHKAN VARIABEL GLOBAL INI DI ATAS FUNGSI
global.liveViewFrames = []; 
const MAX_LIVE_FRAMES = 50; // Menyimpan ~2 detik terakhir dari Live View

function startLiveView() {
    if (lvInterval || !activeCamera) return;
    const devicePC = Buffer.alloc(4); devicePC.writeUInt32LE(2);
    EdsSetPropertyData(activeCamera, 0x00000500, 0, 4, devicePC);

    lvInterval = setInterval(() => {
        let stream = [null], evfImage = [null];
        EdsCreateMemoryStream(0, stream);
        EdsCreateEvfImageRef(stream[0], evfImage);
        
        if (EdsDownloadEvfImage(activeCamera, evfImage[0]) === 0) {
            let ptr = [null], length = [0];
            EdsGetPointer(stream[0], ptr);
            EdsGetLength(stream[0], length);
            if (length[0] > 0 && ptr[0]) {
                latestLvBuffer = Buffer.from(koffi.decode(ptr[0], 'uint8', length[0]));
                
                // SELALU REKAM FRAME KE MEMORI (Bypass syarat isLivePhotoOn)
                if (!global.liveViewFrames) global.liveViewFrames = [];
                global.liveViewFrames.push(latestLvBuffer);
                
                if (global.liveViewFrames.length > MAX_LIVE_FRAMES) {
                    global.liveViewFrames.shift(); // Buang frame terlama
                }
            }
        }
        EdsRelease(evfImage[0]); EdsRelease(stream[0]);
    }, 45); // ~22 FPS
}
function stopLiveView() {
    if (lvInterval) { clearInterval(lvInterval); lvInterval = null; }
    if (activeCamera) {
        const deviceNone = Buffer.alloc(4); deviceNone.writeUInt32LE(0);
        EdsSetPropertyData(activeCamera, 0x00000500, 0, 4, deviceNone);
    }
}

// =======================================================
// 4. 🖥️ PEMBUATAN WINDOW APLIKASI (ELECTRON)
// =======================================================
function createWindow () {
  const win = new BrowserWindow({
    width: 1280, 
    height: 720,
    title: "Lacasaphoto Booth",
    
    // --- [BARU] AKTIFKAN FRAMELESS ---
    frame: false, // Menghilangkan bingkai atas Windows (X, Maximize, Minimize)
    
    show: false, // Tahan (sembunyikan) jendela saat pertama kali proses load
    backgroundColor: '#ffffff', // Beri warna dasar agar tidak ada kilatan hitam
    
    webPreferences: { 
        nodeIntegration: true, 
        contextIsolation: false 
    }
  });
  
  win.setMenuBarVisibility(false);
  win.loadURL('http://localhost:3000/event-manager.html'); 
  hubungkanKamera(); 
  
  // 2. TAMBAHKAN BLOK EVENT INI
  // Munculkan jendela hanya ketika HTML & CSS sudah siap 100% di belakang layar
  win.once('ready-to-show', () => {
      win.show();
  });
}

electronApp.whenReady().then(() => {
    // --- BYPASS IZIN WEBCAM ELECTRON ---
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') {
            callback(true); // Otomatis izinkan akses Kamera
        } else {
            callback(false); // Tolak izin lain
        }
    });

    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'media') return true;
        return false;
    });
    // ------------------------------------

    createWindow(); // Baru buat window setelah izin di-bypass
if (electronApp.isPackaged) {
        setTimeout(() => {
            console.log("🔍 Mengecek pembaruan aplikasi utama dari GitHub Releases...");
            autoUpdater.checkForUpdatesAndNotify();
        }, 5000); // Beri jeda 5 detik setelah aplikasi nyala agar tidak berat
    }
});

// Event Listener jika update sedang diunduh di belakang layar
autoUpdater.on('update-available', () => {
    console.log('🔄 Pembaruan sistem ditemukan! Sedang mengunduh di latar belakang...');
});

// Otomatis restart aplikasi jika unduhan selesai
autoUpdater.on('update-downloaded', () => {
    console.log('✅ Update selesai diunduh. Memulai ulang aplikasi untuk memasang pembaruan...');
    autoUpdater.quitAndInstall(); 
});
electronApp.on('window-all-closed', () => { if (process.platform !== 'darwin') electronApp.quit(); });

ipcMain.on('minimize-window', () => { BrowserWindow.getFocusedWindow().minimize(); });
ipcMain.on('tutup-aplikasi', () => { console.log("🛑 Mematikan mesin..."); electronApp.quit(); });
ipcMain.on('app-quit', () => {
    console.log("🛑 Tombol Matikan Sistem ditekan. Menutup aplikasi...");
    electronApp.quit();
});
// =======================================================
// [BARU] FITUR SINKRONISASI TEMPLATE DARI GITHUB
// =======================================================
ipcMain.handle('sync-templates', async (event, githubBaseUrl) => {
    return new Promise((resolve, reject) => {
        const dbPath = path.join(userDataPath, 'database_frame.json');
        const frameDir = path.join(userDataPath, 'frames');
        if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

        // 1. Unduh file database_frame.json dari GitHub
        const dbUrl = `${githubBaseUrl}/database_frame.json`;

        https.get(dbUrl, (res) => {
            if (res.statusCode !== 200) return reject({ error: `Gagal membaca GitHub (Error ${res.statusCode})` });
            
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const dbBaru = JSON.parse(data);
                    
                    // 2. Timpa file database di PC Klien
                    fs.writeFileSync(dbPath, JSON.stringify(dbBaru, null, 4));

                    // 3. Cari daftar nama gambar yang perlu diunduh
                    let filesToDownload = [];
                    for (let format in dbBaru) {
                        dbBaru[format].forEach(template => {
                            filesToDownload.push(`${template.id}.png`); // Gambar Frame Asli
                            if (template.img) {
                                const thumbName = template.img.replace('/frames/', '');
                                filesToDownload.push(thumbName); // Gambar Thumbnail
                            }
                        });
                    }

                    // 4. Unduh gambar satu per satu dari folder /frames/ di GitHub
                    let downloadedCount = 0;
                    filesToDownload.forEach(fileName => {
                        const fileUrl = `${githubBaseUrl}/frames/${fileName}`;
                        const filePath = path.join(frameDir, fileName);
                        
                        const fileStream = fs.createWriteStream(filePath);
                        https.get(fileUrl, (imgRes) => {
                            if(imgRes.statusCode === 200) {
                                imgRes.pipe(fileStream);
                                fileStream.on('finish', () => fileStream.close());
                            }
                        }).on('error', () => { /* Abaikan jika ada 1 gambar gagal agar tidak crash */ });
                    });

                    resolve({ success: true, message: "Sinkronisasi berhasil! Refresh halaman ini." });
                } catch (err) {
                    reject({ error: "Format JSON di GitHub salah." });
                }
            });
        }).on('error', (err) => reject({ error: err.message }));
    });
});

// =======================================================
// 5. 🗄️ ENDPOINT DATABASE (EVENT MANAGER & SESSION)
// =======================================================
expressApp.get('/api/events', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
        res.json({ success: true, events: data.events });
    } catch (e) { res.json({ success: false, events: [] }); }
});

expressApp.post('/api/events', (req, res) => {
    try {
        const { judul, deskripsi, mode, payment } = req.body;
        const data = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
        const newEvent = {
            id: 'EVT-' + Date.now(),
            judul: judul || 'Untitled Event',
            deskripsi: deskripsi || '',
            mode: mode, 
            payment: payment, 
            tanggal: new Date().toISOString()
        };
        data.events.push(newEvent);
        fs.writeFileSync(eventsPath, JSON.stringify(data, null, 2));
        res.json({ success: true, event: newEvent });
    } catch (e) { res.status(500).json({ success: false, message: 'Gagal menyimpan event' }); }
});

expressApp.delete('/api/events/:id', (req, res) => {
    try {
        let data = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
        data.events = data.events.filter(e => e.id !== req.params.id);
        fs.writeFileSync(eventsPath, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

expressApp.post('/api/launch-event', (req, res) => {
    activeEvent = req.body.event; 
    res.json({ success: true, url: '/idle.html' }); 
});

expressApp.get('/api/current-event', (req, res) => {
    if (activeEvent) {
        res.json({ success: true, event: activeEvent });
    } else {
        res.json({ success: false, message: "Tidak ada event aktif" });
    }
});

let currentTransaction = { status: 'pending', method: null };

expressApp.post('/api/create-payment', (req, res) => {
    const { method } = req.body;
    currentTransaction = {
        id: 'TRX-' + Date.now(),
        method: method, 
        status: method === 'cash' ? 'paid' : 'pending',
        amount: 50000
    };
    res.json({ success: true, transaction: currentTransaction });
});

expressApp.get('/api/check-payment-status', (req, res) => {
    res.json({ success: true, status: currentTransaction.status });
});

expressApp.post('/api/confirm-cash-payment', (req, res) => {
    currentTransaction.status = 'paid';
    res.json({ success: true, message: "Pembayaran tunai dikonfirmasi." });
});

expressApp.post('/api/start-session', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) {
        activeSessionId = sessionId;
        const sessionDir = path.join(uploadDir, activeSessionId);
        
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        console.log(`\n🎉 SESI BARU DIMULAI: ${activeSessionId}`);
    }
    res.json({ success: true, sessionId: activeSessionId });
});


// =======================================================
// 6. 🎛️ DASHBOARD API: SETTINGS & TEMPLATES
// =======================================================
const storageIdle = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, assetsDir); // Simpan di folder UI/assets agar mudah dibaca browser
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        // Selalu gunakan nama unik agar browser tidak memuat cache gambar lama
        cb(null, `custom-idle-${Date.now()}${ext}`);
    }
});

const uploadIdle = multer({ 
    storage: storageIdle,
    limits: { fileSize: 25 * 1024 * 1024 } // Batas 25MB (untuk mengakomodasi video mp4 pendek)
});

expressApp.post('/api/upload-idle', uploadIdle.single('idleFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "Tidak ada file yang diterima." });
        }

        const fileUrl = `/assets/${req.file.filename}`;
        
        // Baca file settings.json
        let settings = {};
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
        if (!settings.global) settings.global = {};

        // Hapus file custom lama (jika ada) agar hardisk tidak cepat penuh
        if (settings.global.customIdleScreen) {
            const oldFileName = path.basename(settings.global.customIdleScreen);
            const oldFilePath = path.join(assetsDir, oldFileName);
            if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
        }

        // Tulis ulang dengan jalur file yang baru
        settings.global.customIdleScreen = fileUrl;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

        res.json({ success: true, message: "Layar Utama berhasil diperbarui!", fileUrl: fileUrl });
    } catch (error) {
        console.error("Error upload idle screen:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});
const storageFrame = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, frameDir); 
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const isThumb = file.fieldname === 'fileThumb';
        const fileName = isThumb ? `thumb_${req.body.idFrame}${ext}` : `${req.body.idFrame}.png`;
        cb(null, fileName);
    }
});
const uploadFrame = multer({ storage: storageFrame });

expressApp.post('/api/upload-frame', uploadFrame.fields([
    { name: 'fileFrame', maxCount: 1 },
    { name: 'fileThumb', maxCount: 1 }
]), (req, res) => {
    try {
        const { formatFoto, namaFrame, idFrame, layoutData } = req.body;
        const parsedLayout = JSON.parse(layoutData);
        const files = req.files;

        if (!files['fileFrame'] || !files['fileThumb']) {
            return res.status(400).json({ success: false, message: "File frame atau thumbnail tidak ditemukan." });
        }

       const dbPath = path.join(userDataPath, 'database_frame.json');
        let dbData = {};

        if (fs.existsSync(dbPath)) {
            dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        }

        if (!dbData[formatFoto]) {
            dbData[formatFoto] = [];
        }

        dbData[formatFoto] = dbData[formatFoto].filter(t => t.id !== idFrame);

        const newTemplate = {
            id: idFrame,
            nama: namaFrame,
            img: `/frames/${files['fileThumb'][0].filename}`,
            isHidden: false,
            layout: parsedLayout
        };

        dbData[formatFoto].push(newTemplate);
        fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 4));

        res.json({ success: true, message: "Template berhasil disimpan!" });
    } catch (error) {
        console.error("Error upload frame:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

expressApp.post('/api/upload-video', upload.single('poseVideo'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file video' });
        const videoPath = path.join(assetsDir, 'pose.mp4');
        fs.renameSync(req.file.path, videoPath);
        res.json({ success: true, message: 'Video pose berhasil diperbarui!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

expressApp.get('/api/open-uploads-folder', (req, res) => {
    try {
        const command = `explorer "${uploadDir}"`;
        exec(command, (err) => {
            if (err) {
                console.error("Gagal membuka folder:", err);
                return res.json({ success: false, message: "Gagal membuka folder" });
            }
            res.json({ success: true });
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

expressApp.get('/liveview.jpg', (req, res) => {
    if (!latestLvBuffer) return res.status(404).send('Frame belum siap');
    res.set('Content-Type', 'image/jpeg');
    res.send(latestLvBuffer);
});

expressApp.get('/api/settings', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        res.json(data);
    } catch (err) { res.json({}); }
});

expressApp.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: "Pengaturan berhasil disimpan!" });
    } catch (err) { res.json({ success: false, message: "Gagal menyimpan pengaturan." }); }
});
// =======================================================
// [BARU] API FACTORY RESET (DANGER ZONE)
// =======================================================
expressApp.post('/api/factory-reset', (req, res) => {
    try {
        console.log("🧨 Memulai proses Reset Sistem ke Default...");

        // 1. Hapus Gambar QRIS Toko
        const qrisPath = path.join(assetsDir, 'qris_static.png');
        if (fs.existsSync(qrisPath)) fs.unlinkSync(qrisPath);

        // 2. Hapus Video Panduan Pose
        const posePath = path.join(assetsDir, 'pose.mp4');
        if (fs.existsSync(posePath)) fs.unlinkSync(posePath);

        // 3. Hapus Custom Idle Screen (Tampilan Layar Utama Custom)
        if (fs.existsSync(assetsDir)) {
            const assetsFiles = fs.readdirSync(assetsDir);
            assetsFiles.forEach(file => {
                // Hapus semua file yang berawalan custom-idle-
                if (file.startsWith('custom-idle-')) {
                    fs.unlinkSync(path.join(assetsDir, file));
                }
            });
        }

        // 4. Timpa settings.json kembali ke setelan Pabrik (Default)
        const defaultSettings = {
            photobox: { sessionTimer: 300 },
            collage: { timer: 5, sessionTimer: 300, maxRetake: 3 },
            newspaper: { sessionTimer: 300, maxRetake: 0 },
            global: {
                theme: "theme-pop-art",
                customIdleScreen: null,
                extraPrintPrice: 15000,
                cameraEngine: "canon",
                cameraPort: "",
                liveViewBrightness: 100,
                flashWorkaround: true,
                livePhotoEnabled: false,
                cloudStorage: true,
                driveParentFolderId: "",
                printer4R: "",
                printerA4: ""
            },
            waMessage: "Halo dari Lacasaphoto! 📸\n\nTerima kasih sudah berfoto ria bersama kami. Berikut link foto kamu:\n\n🔗 {link}"
        };
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));

        // 5. Bersihkan Daftar Event yang sedang berjalan
        fs.writeFileSync(eventsPath, JSON.stringify({ events: [] }, null, 2));
        activeEvent = null; // Matikan event aktif di memori
        activeSessionId = 'DEFAULT_SESSION';

        // 6. Reset Laporan Analitik (Mereset Folder Uploads)
        // Kita rename folder lama sebagai backup agar foto pelanggan tidak hilang terbakar
        const timestamp = Date.now();
       const backupUploadDir = path.join(userDataPath, `uploads_backup_${timestamp}`);
        
        if (fs.existsSync(uploadDir)) {
            fs.renameSync(uploadDir, backupUploadDir); // Ubah nama jadi folder backup
            fs.mkdirSync(uploadDir, { recursive: true }); // Buat ulang folder uploads yang bersih
            console.log(`[SISTEM] Analitik direset. File foto lama diamankan ke: uploads_backup_${timestamp}`);
        }

        console.log("✅ Factory Reset Selesai!");
        res.json({ success: true, message: "Sistem berhasil direset ke Default." });

    } catch (error) {
        console.error("❌ Error Factory Reset:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// =======================================================
// GOOGLE DRIVE API ROUTES
// =======================================================
expressApp.post('/api/upload-drive-credentials', upload.single('credentialsFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file JSON yang diunggah' });
        
        fs.renameSync(req.file.path, CREDENTIALS_PATH);
        
        if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);

        // Update oauth2Client secara otomatis tanpa perlu restart server
        initGoogleAuth();

        res.json({ success: true, message: 'File kredensial berhasil disimpan! Silakan Login ke Google.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

expressApp.get('/api/check-drive-status', (req, res) => {
    const hasOauth = fs.existsSync(CREDENTIALS_PATH);
    const hasToken = fs.existsSync(TOKEN_PATH);
    res.json({ hasOauth, hasToken });
});

expressApp.post('/api/disconnect-drive', (req, res) => {
    try {
        if (fs.existsSync(TOKEN_PATH)) {
            fs.unlinkSync(TOKEN_PATH);
            console.log("🟢 Token G-Drive berhasil dihapus oleh pengguna.");
        } else {
            console.log("🟡 File token tidak ditemukan, mungkin sudah terhapus.");
        }
        return res.status(200).json({ success: true, message: 'Koneksi akun berhasil diputuskan.' });
    } catch (e) {
        console.error("🔴 Error saat memutuskan koneksi G-Drive:", e);
        return res.status(500).json({ success: false, message: 'Gagal menghapus token di server.' });
    }
});

expressApp.get('/api/auth-google', (req, res) => {
    try {
        if (!oauth2Client) return res.send('File oauth_credentials.json belum dikonfigurasi. Silakan upload melalui Dashboard.');

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive'],
            prompt: 'consent select_account' 
        });
        
        res.redirect(authUrl);
    } catch (e) {
        res.send("Error: " + e.message);
    }
});

expressApp.get('/api/auth-google-callback', async (req, res) => {
    const code = req.query.code;
    
    if (!oauth2Client) {
        return res.status(500).send("Gagal: oauth2Client belum siap. Pastikan credentials valid.");
    }

    if (!code) {
        return res.status(400).send("Gagal: Tidak ada kode otorisasi dari Google.");
    }
    
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log("🟢 Token G-Drive berhasil disimpan di:", TOKEN_PATH);
        
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h2 style="color: #10b981;">✅ Sukses Terhubung!</h2>
                <p>Akun Google Drive Anda sudah terhubung ke sistem Lacasabooth.</p>
                <p>Silakan tutup jendela ini dan kembali ke Dashboard.</p>
            </div>
        `);
    } catch (error) {
        console.error("🔴 Error saat menyimpan token:", error);
        res.status(500).send("Gagal menyimpan token. Silakan cek terminal/CMD Node.js Anda untuk melihat detail error.");
    }
});


// =======================================================
// TEMPLATE & QRIS
// =======================================================
expressApp.get('/api/frames', (req, res) => {
    
    if (fs.existsSync(dbPath)) {
        let db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        if (req.query.all !== 'true') {
            for (let format in db) db[format] = db[format].filter(t => t.isHidden !== true);
        }
        res.json(db);
    } else res.json({ "1": [], "2": [], "4": [], "6": [] });
});

expressApp.post('/api/delete-template', (req, res) => {
    try {
        const { format, idTemplate } = req.body;
    
        let db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        if (db[format]) {
            db[format] = db[format].filter(t => t.id !== idTemplate);
            fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        }
        res.json({ success: true, message: "Template berhasil dihapus!" });
    } catch (error) { res.status(500).json({ success: false }); }
});

expressApp.post('/api/toggle-template', (req, res) => {
    try {
        const { format, idTemplate, isHidden } = req.body;
        
        let db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        
        if (db[format]) {
            const templateIndex = db[format].findIndex(t => t.id === idTemplate);
            if (templateIndex !== -1) {
                db[format][templateIndex].isHidden = isHidden;
                fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
                return res.json({ success: true, message: "Status template diperbarui!" });
            }
        }
        res.status(404).json({ success: false, message: "Template tidak ditemukan" });
    } catch (error) { res.status(500).json({ success: false }); }
});

expressApp.post('/api/edit-template', (req, res) => {
    try {
        const { format, idTemplate, nama, coords } = req.body;
       
        let db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        
        if (db[format]) {
            const templateIndex = db[format].findIndex(t => t.id === idTemplate);
            if (templateIndex !== -1) {
                db[format][templateIndex].nama = nama;
                db[format][templateIndex].layout.coords = coords; 
                
                fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
                return res.json({ success: true, message: "Template berhasil diperbarui!" });
            }
        }
        res.status(404).json({ success: false, message: "Template tidak ditemukan" });
    } catch (error) { res.status(500).json({ success: false }); }
});

expressApp.post('/api/upload-qris', upload.single('qrisImage'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file gambar' });
        const qrisPath = path.join(assetsDir, 'qris_static.png');
        fs.renameSync(req.file.path, qrisPath);
        res.json({ success: true, message: 'QRIS berhasil diperbarui!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

expressApp.get('/api/get-qris', (req, res) => {
    const qrisPath = path.join(assetsDir, 'qris_static.png');
    if (fs.existsSync(qrisPath)) {
        res.json({ success: true, url: `/assets/qris_static.png?t=${Date.now()}` });
    } else {
        res.json({ success: false, message: "QRIS belum diatur" });
    }
});

// =======================================================
// 7. 📸 KONTROL KAMERA (API JEPRET & LIVE VIEW)
// =======================================================
expressApp.post('/toggle-liveview', (req, res) => {
    const { state } = req.body;
    if (state) startLiveView();
    else stopLiveView();
    res.status(200).json({ success: true });
});

expressApp.post('/capture', async (req, res) => {
    const { mirror, lvActive, mode } = req.body;
    global.lastCaptureMode = mode ? mode.toLowerCase() : 'wedding'; 
    if (mirror !== undefined) global.currentMirrorStatus = mirror;
    
    // [HUBUNGKAN KE DASHBOARD] Cek apakah Live Photo aktif
    let isLivePhotoOn = false;
    try {
        const dbSet = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (dbSet.global && dbSet.global.livePhotoEnabled === true) isLivePhotoOn = true;
    } catch(e) {}

    // Kunci rekaman HANYA jika fitur Live Photo diaktifkan di Dashboard
    if (isLivePhotoOn) {
        global.lastCapturedLiveFrames = global.liveViewFrames ? [...global.liveViewFrames] : [];
    } else {
        global.lastCapturedLiveFrames = null; // Kosongkan agar RAM tidak berat (Mini PC aman!)
    }

    res.status(200).json({ success: true });
    if (lvActive) {
        stopLiveView(); 
        await new Promise(r => setTimeout(r, 600)); 
    }

    if (activeCamera) {
        console.log(`[API] 📸 JEPRET! (Mode: ${global.lastCaptureMode})`);
        EdsSendCommand(activeCamera, kEdsCameraCommand_TakePicture, 0);
    }
});
// =======================================================
// [BARU] ENDPOINT PENERIMA FOTO DARI WEBCAM (SUPPORT GIF)
// =======================================================
expressApp.post('/api/upload-webcam', (req, res) => {
    try {
        // TERIMA TAMBAHAN DATA FRAME VIDEO DARI FRONTEND
        const { imageBase64, isMirrored, liveFramesBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ success: false, message: "Tidak ada gambar dari webcam" });

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        const newFileName = `foto_${9999999999999 - Date.now()}_mentah.jpg`;
        
        // --- LOGIKA PENYIMPANAN FRAME VIDEO BOOMERANG WEBCAM ---
        if (liveFramesBase64 && liveFramesBase64.length > 0) {
            if (!global.liveFramesByPhoto) global.liveFramesByPhoto = {};
            // Konversi semua base64 dari browser menjadi buffer gambar utuh
            const framesBuffer = liveFramesBase64.map(b64 => 
                Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), 'base64')
            );
            // Simpan ke memori sementara (RAM) untuk diolah FFmpeg nanti
            global.liveFramesByPhoto[newFileName] = {
                buffer: framesBuffer,
                isMirrored: isMirrored // Set mengikuti status mirror
            };
        }
        // -------------------------------------------------------

        const sessionDir = path.join(uploadDir, activeSessionId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        const finalFilePath = path.join(sessionDir, newFileName);
        
        // Simpan foto utama (High-Res)
        if (isMirrored) {
            sharp(buffer).flop().toBuffer().then(buf => {
                fs.writeFileSync(finalFilePath, buf);
                console.log(`✅ FOTO WEBCAM (MIRRORED) MASUK: ${newFileName}`);
                io.emit('foto-baru', { namaFile: newFileName });
            });
        } else {
            fs.writeFileSync(finalFilePath, buffer);
            console.log(`✅ FOTO WEBCAM MASUK: ${newFileName}`);
            io.emit('foto-baru', { namaFile: newFileName });
        }

        res.json({ success: true, fileName: newFileName });
    } catch (error) {
        console.error("Error upload webcam:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =======================================================
// 8. MESIN PENGURUS FILE FOTO (EVENT CALLBACK NATIVE)
// =======================================================
const callbackPenarikFoto = koffi.register((inEvent, inRef, inContext) => {
    if (inEvent === 0x0208) {
        const itemInfo = Buffer.alloc(512);
        EdsGetDirectoryItemInfo(inRef, itemInfo);
        const fileSize = itemInfo.readUInt32LE(0); 

        const newFileName = `foto_${9999999999999 - Date.now()}_mentah.jpg`;
        const tempFilePath = path.join(tempDir, newFileName);
        if (!global.liveFramesByPhoto) global.liveFramesByPhoto = {};
        global.liveFramesByPhoto[newFileName] = {
            buffer: global.lastCapturedLiveFrames || [],
            isMirrored: global.currentMirrorStatus // Ingat apakah foto ini pakai cermin atau tidak
        };
        const sessionDir = path.join(uploadDir, activeSessionId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        
        const finalFilePath = path.join(sessionDir, newFileName);

        let stream = [null];
        const statusStream = EdsCreateFileStream(tempFilePath, 1, 2, stream);
        if (statusStream !== 0) return 0;

        EdsDownload(inRef, fileSize, stream[0]);
        EdsDownloadComplete(inRef);
        EdsRelease(stream[0]); 

        console.log(`📥 MENGUNDUH DARI KAMERA: ${newFileName} (Menuju sesi: ${activeSessionId})`);
        
        if (global.currentMirrorStatus === true) {
            sharp(tempFilePath).flop().toBuffer().then(buf => {
                fs.writeFileSync(finalFilePath, buf);
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                console.log(`✅ FOTO BERHASIL DI-MIRROR: ${newFileName}`);
                io.emit('foto-baru', { namaFile: newFileName });
            }).catch(err => {
                console.error("❌ Gagal melakukan mirror:", err);
            });
        } else {
            fs.renameSync(tempFilePath, finalFilePath);
            console.log(`✅ FOTO MASUK NORMAL: ${newFileName}`);
            io.emit('foto-baru', { namaFile: newFileName });
        }
    }
    return 0; 
}, koffi.pointer(EdsObjectEventHandler));

// =======================================================
// 9. 🎞️ MESIN MERAKIT COLLAGE & PHOTOBOX 
// =======================================================
expressApp.get('/api/photobox-raws', (req, res) => {
    try {
        const sessionDir = path.join(uploadDir, activeSessionId);
        if (!fs.existsSync(sessionDir)) return res.json({ success: true, files: [] });

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('_mentah.jpg'))
            .map(f => ({ name: f, file: `/uploads/${activeSessionId}/${f}`, mtime: fs.statSync(path.join(sessionDir, f)).mtime.getTime() }))
            .sort((a, b) => b.mtime - a.mtime).slice(0, 25); 
            
        res.json({ success: true, files: files });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

expressApp.post('/api/generate-photobox', 
    async (req, res) => {
    try {
        let db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        let templateData = null;
        for (let formatKey in db) {
            const foundTemplate = db[formatKey].find(t => t.id === req.body.templateId);
            if (foundTemplate) { templateData = foundTemplate; break; }
        }
        if (!templateData) return res.status(400).json({ success: false, message: "Template tidak ditemukan!" });
        
        const sessionDir = path.join(uploadDir, activeSessionId);
        
        const prosesFotoPromises = req.body.selectedPhotos.map(async (fotoName, i) => {
            const coord = templateData.layout.coords[i];
            const w = coord.width || templateData.layout.width;
            const h = coord.height || templateData.layout.height;
            
            let imgPipeline = sharp(path.join(sessionDir, fotoName)).resize({ width: w, height: h, fit: 'cover' });

            if (req.body.effect) {
                if (req.body.effect === 'monochrome') imgPipeline = imgPipeline.grayscale().linear(1.2, -10); 
                else if (req.body.effect === 'sepia') imgPipeline = imgPipeline.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]);
            }
            const processedPhoto = await imgPipeline.toBuffer();
            return { input: processedPhoto, top: coord.y, left: coord.x };
        });

        let komposisi = await Promise.all(prosesFotoPromises);
        komposisi.push({ input: path.join(frameDir, `${req.body.templateId}.png`), top: 0, left: 0 });
        
        const frameMeta = await sharp(path.join(frameDir, `${req.body.templateId}.png`)).metadata();
        const outputName = `foto_${activeSessionId}_hasil.jpg`;
        const outputPath = path.join(sessionDir, outputName);

        // 🖼️ RENDER GAMBAR
        await sharp({ create: { width: frameMeta.width || 1200, height: frameMeta.height || 1800, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
        .composite(komposisi)
        .jpeg({ quality: 90, mozjpeg: true })
        .toFile(outputPath);

       // ==========================================
        // 🎬 [BARU] FFMPEG: GIF LIVE PHOTO MULTI-GRID
        // ==========================================
        let urlLivePhoto = null;
        let pathGif = null;
        
       // [HUBUNGKAN KE DASHBOARD] Cek apakah fitur ini ON atau OFF
        let isLivePhotoOn = false;
        try {
            const dbSet = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (dbSet.global && dbSet.global.livePhotoEnabled === true) isLivePhotoOn = true;
        } catch(e) {}
        
        // Syarat berlapis: Cek dari frontend (req.body.livePhoto) DAN dari Dashboard (isLivePhotoOn)
        if (req.body.livePhoto && isLivePhotoOn && req.body.selectedPhotos && req.body.selectedPhotos.length > 0) {
            console.log(`[FFMPEG] Merakit Live Photo Multi-Grid untuk sesi: ${activeSessionId}...`);
            const namaGif = `live_${activeSessionId}.gif`;
            pathGif = path.join(sessionDir, namaGif);
            
            // Kalkulasi Skala Keseluruhan (Kita buat lebar GIF 600px agar rapi tapi tidak berat)
            const wAsli = frameMeta.width || 1200;
            const hAsli = frameMeta.height || 1800;
            const sf = 600 / wAsli; // Faktor Skala (Scale Factor)
            const canvasW = 600;
            const canvasH = Math.round(hAsli * sf);

            // Mulai membangun Perintah FFmpeg
            let ffmpegInputs = `-i "${path.join(frameDir, `${req.body.templateId}.png`).replace(/\\/g, '/')}" `;
            let filterComplex = `color=c=white:s=${canvasW}x${canvasH}:d=2.5[bg0];`; // Canvas dasar putih
            let overlayChain = ``;
            let foldersToClean = [];

            // Proses setiap slot foto satu per satu
            req.body.selectedPhotos.forEach((fotoName, i) => {
                const slotDir = path.join(tempDir, `frames_${activeSessionId}_slot_${i}`);
                if (!fs.existsSync(slotDir)) fs.mkdirSync(slotDir, { recursive: true });
                foldersToClean.push(slotDir);

                // Tarik memori video dan status mirror khusus untuk pose foto ini
                let frameData = global.liveFramesByPhoto ? global.liveFramesByPhoto[fotoName] : null;
                let framesBuffer = frameData ? frameData.buffer : null;
                let isMirrored = frameData ? frameData.isMirrored : false;
                let isFallback = false;
                
                // Fallback: Jika error/memori kosong, gandakan foto statis
                if (!framesBuffer || framesBuffer.length === 0) {
                    const fallbackImg = fs.readFileSync(path.join(sessionDir, fotoName));
                    framesBuffer = Array(50).fill(fallbackImg);
                    isFallback = true; // Fallback sudah berbentuk foto matang (sudah ter-mirror dari Sharp)
                }

                // Tulis frame ke dalam folder slot masing-masing
                framesBuffer.forEach((buf, idx) => {
                    fs.writeFileSync(path.join(slotDir, `frame_${String(idx).padStart(3, '0')}.jpg`), buf);
                });

                ffmpegInputs += `-i "${path.join(slotDir, 'frame_%03d.jpg').replace(/\\/g, '/')}" `;

                // Hitung koordinat dan ukuran slot untuk video ini
                const coord = templateData.layout.coords[i];
                const sw = Math.round((coord.width || templateData.layout.width) * sf);
                const sh = Math.round((coord.height || templateData.layout.height) * sf);
                const sx = Math.round(coord.x * sf);
                const sy = Math.round(coord.y * sf);

                // [KUNCI PERBAIKAN MIRROR] Tambahkan filter 'hflip' (Horizontal Flip) jika mode cermin ON!
                // Catatan: Jika memori gagal & pakai fallback, jangan di-flip lagi karena fallback sudah ter-flip.
                const mirrorFilter = (isMirrored && !isFallback) ? 'hflip,' : '';

                // [Index i+1] karena Index 0 adalah Template Bingkai
                filterComplex += `[${i+1}:v]${mirrorFilter}scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh}[v${i+1}];`;
                overlayChain += `[bg${i}][v${i+1}]overlay=x=${sx}:y=${sy}[bg${i+1}];`;
            });
            // Timpa Bingkai Frame di atas semua video, lalu generate Palet GIF
            filterComplex += `[0:v]scale=${canvasW}:${canvasH}[frame];`;
            filterComplex += overlayChain;
            const jumlahSlot = req.body.selectedPhotos.length;
            filterComplex += `[bg${jumlahSlot}][frame]overlay=0:0,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
const outputPattern = pathGif.replace(/\\/g, '/');

// 1. Tentukan lokasi pasti dari file ffmpeg.exe bawaan aplikasi Anda
const ffmpegPath = path.join(__dirname, 'ffmpeg.exe').replace('app.asar', 'app.asar.unpacked');

// 2. Ganti kata 'ffmpeg' dengan variabel lokasi path tersebut
const ffmpegCmd = `"${ffmpegPath}" -y -framerate 20 ${ffmpegInputs} -filter_complex "${filterComplex}" -loop 0 "${outputPattern}"`;
            console.log(`[FFMPEG] Memproses penggabungan Grid...`);

            await new Promise((resolve) => {
                exec(ffmpegCmd, (error) => {
                    if (error) {
                        console.error("[FFMPEG] ❌ GAGAL membuat Live Photo Multi-Grid!");
                        console.error(error.message);
                    } else {
                        console.log(`[FFMPEG] ✅ Live Photo GIF Multi-Grid sukses: ${namaGif}`);
                        urlLivePhoto = `/uploads/${activeSessionId}/${namaGif}`;
                    }
                    // Bersihkan semua folder temporary
                    foldersToClean.forEach(folder => {
                        try { fs.rmSync(folder, { recursive: true, force: true }); } catch(e){}
                    });
                    resolve();
                });
            });
            
            // Bersihkan database memori RAM agar hemat daya
            global.liveFramesByPhoto = {}; 
        } else {
            console.log("[CEK GIF] ⚠️ Pembuatan GIF dilewati (Fitur dimatikan dari Dashboard / Syarat tidak terpenuhi).");
        }

        // 🚀 LOGIKA CEK MODE PENYIMPANAN
        let isOnlineMode = true; // Default Online
        try {
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.global && settings.global.cloudStorage !== undefined) {
                    isOnlineMode = settings.global.cloudStorage;
                }
            }
        } catch (e) {}

        let linkShareAkhir = "";

        if (isOnlineMode) {
            // ==========================================
            // MODE ONLINE: UPLOAD GOOGLE DRIVE
            // ==========================================
            let parentFolderId = "1scPtcs7JaGmnF4TYfpUL2DIcN_7iU9DB"; 
            try {
                if (fs.existsSync(settingsPath)) {
                    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                    if (settings.global && settings.global.driveParentFolderId) {
                        parentFolderId = settings.global.driveParentFolderId; 
                    }
                }
            } catch(e) {}
            
            linkShareAkhir = `https://drive.google.com/drive/folders/${parentFolderId}`; 
            
            if (typeof uploadToDrive === 'function') {
                console.log("[SISTEM] Mode Online: Mengupload file ke GDrive...");
                try {
                    const datePrefix = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
                    const driveFolderName = `${datePrefix}_${activeSessionId}`;

                    // 1. Upload File Hasil (Composite) CEPAT
                    const uploadedUrl = await uploadToDrive(outputPath, driveFolderName, parentFolderId);
                    
                    if (uploadedUrl) {
                        linkShareAkhir = uploadedUrl; 
                        console.log(`[DRIVE] ✅ Sukses Upload Utama! Link: ${linkShareAkhir}`);
                    }

                    // 2. Upload GIF & File Mentah DIAM-DIAM & MENGANTRE (Mencegah GDrive Error)
                    (async () => {
                        // Antrean 1: Upload file GIF 
                        if (urlLivePhoto && fs.existsSync(pathGif)) {
                            try {
                                await uploadToDrive(pathGif, driveFolderName, parentFolderId);
                                console.log(`[DRIVE] ✅ GIF Live Photo terupload!`);
                            } catch(err) { console.error(`[DRIVE] Gagal upload GIF:`, err.message); }
                        }
                        
                        // Antrean 2: Upload SEMUA file mentah dari folder sesi ini SATU PER SATU
                        // Mengambil semua foto asli yang terjepret, bukan hanya yang dipilih
                        const allRawFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('_mentah.jpg'));

                        for (let fotoName of allRawFiles) {
                            const rawPath = path.join(sessionDir, fotoName);
                            if (fs.existsSync(rawPath)) {
                                try {
                                    await uploadToDrive(rawPath, driveFolderName, parentFolderId);
                                    console.log(`[DRIVE-BACKGROUND] Semua Mentahan terupload: ${fotoName}`);
                                } catch(err) {}
                            }
                        }
                    })();
                } catch (err) {
                    console.error("❌ Gagal Upload GDrive (Tidak ada internet/Error).", err.message);
                    console.log("[SISTEM] Mengalihkan otomatis ke QR Lokal (IP Router)...");
                    const ipLokal = getLocalIP();
                    linkShareAkhir = `http://${ipLokal}:3000/uploads/${activeSessionId}/${outputName}`;
                }
            }
        } else {
            // ==========================================
            // MODE OFFLINE MURNI
            // ==========================================
            const ipLokal = getLocalIP();
            linkShareAkhir = `http://${ipLokal}:3000/uploads/${activeSessionId}/${outputName}`;
            console.log(`[SISTEM] Mode Offline aktif. Upload Cloud dilewati.`);
        }

       res.json({ 
            success: true, 
            file: `/uploads/${activeSessionId}/${outputName}`, 
            driveLink: linkShareAkhir,
            livePhoto: urlLivePhoto // <-- [BARU] Kirim URL GIF ke frontend
        });

        
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// =======================================================
// 10. 🖨️ MESIN PRINTER & MANAJEMEN GALERI
// =======================================================
expressApp.get('/api/get-printers', (req, res) => {
    exec('powershell -Command "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name"', (error, stdout) => {
        if (error) {
            exec('wmic printer get name', (err2, stdout2) => {
                 if (err2) return res.json({ success: false, printers: [] });
                 let printers = stdout2.split('\n').map(p => p.trim()).filter(p => p && p.toLowerCase() !== 'name');
                 return res.json({ success: true, printers });
            });
            return;
        }
        let printers = stdout.split('\n').map(p => p.trim()).filter(p => p);
        res.json({ success: true, printers });
    });
});

function processPrintQueue() {
    if (isPrinting || printQueue.length === 0) return;
    isPrinting = true;
    const task = printQueue.shift(); 
    console.log(`[PRINTER] Memproses antrean: Mencetak ke ${task.printerName}`);
    exec(task.command, (error) => {
        if (error) console.error("[PRINTER] Error mencetak:", error.message);
        setTimeout(() => { isPrinting = false; processPrintQueue(); }, 4000); 
    });
}

expressApp.post('/api/print', (req, res) => {
    let namaFileMentah = req.body.fileName || req.body.filename; 
    const { mode, size, action } = req.body; 
    if (!namaFileMentah) return res.status(400).json({ success: false });

    let relativePath = namaFileMentah;
    if (relativePath.startsWith('/uploads/')) relativePath = relativePath.replace('/uploads/', '');
    else if (relativePath.startsWith('\\uploads\\')) relativePath = relativePath.replace('\\uploads\\', '');
    
    const targetPath = path.join(uploadDir, relativePath);
    
    let settings = {};
    try { if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch(e){}

    let printerTarget = settings.global?.printer4R || ""; 
   let folderConfig = path.join(userDataPath, 'irfan_config_4R');
    if (size === 'A4' || mode === 'newspaper') { 
        printerTarget = settings.global?.printerA4 || ""; 
        folderConfig = path.join(userDataPath, 'irfan_config_A4');
    } 

    if (!printerTarget && action !== 'open') {
        console.log("❌ Gagal Print: Klien belum memilih printer di Dashboard.");
        return res.status(400).json({ success: false, message: "Printer belum disetel di Dashboard!" });
    }

    if (!fs.existsSync(folderConfig)) fs.mkdirSync(folderConfig, { recursive: true });

    // GANTI SEMUA DEKLARASI IRFANVIEW MENJADI SEPERTI INI:
const irfanViewPath = path.join(__dirname, 'IrfanView', 'i_view64.exe').replace('app.asar', 'app.asar.unpacked');
    let perintahPrint = action === 'open' 
        ? `"${irfanViewPath}" "${targetPath}" /ini="${folderConfig}"`
        : `"${irfanViewPath}" "${targetPath}" /ini="${folderConfig}" /print="${printerTarget}"`;

    printQueue.push({ fileName: namaFileMentah, command: perintahPrint, printerName: printerTarget });
    processPrintQueue();
    res.json({ success: true });
});

expressApp.post('/api/setup-printer', (req, res) => {
    const { size } = req.body;
    
    // 1. Simpan folder config margin di AppData (userDataPath), BUKAN di __dirname
    let folderConfig = size === 'A4' 
        ? path.join(userDataPath, 'irfan_config_A4') 
        : path.join(userDataPath, 'irfan_config_4R');
    
    if (!fs.existsSync(folderConfig)) fs.mkdirSync(folderConfig, { recursive: true });

    // 2. Perbaiki Path exe IrfanView agar bisa berjalan saat sudah di-build (.unpacked)
    const irfanPath = path.join(__dirname, 'IrfanView', 'i_view64.exe').replace('app.asar', 'app.asar.unpacked');

    // 3. Gunakan sembarang template dari folder AppData Klien sebagai gambar pancingan
    let dummyImage = "";
    if (fs.existsSync(frameDir)) {
        const files = fs.readdirSync(frameDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
        if (files.length > 0) dummyImage = path.join(frameDir, files[0]);
    }

    // Jika gambar dummy tidak ada, IrfanView tetap dibuka dengan layar kosong
    const perintah = dummyImage 
        ? `"${irfanPath}" "${dummyImage}" /ini="${folderConfig}"`
        : `"${irfanPath}" /ini="${folderConfig}"`;
    
    exec(perintah, (error) => {
        if (error) console.error("Gagal membuka Setup Printer:", error.message);
    });
    
    res.json({ success: true, message: "Jendela IrfanView terbuka di layar klien." });
});

expressApp.get('/api/gallery', (req, res) => {
    try {
        let allFiles = [];
        const rootFiles = fs.readdirSync(uploadDir);
        
        rootFiles.forEach(item => {
            const itemPath = path.join(uploadDir, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory()) {
                const subFiles = fs.readdirSync(itemPath);
                subFiles.forEach(subItem => {
                    if (subItem.toLowerCase().endsWith('.jpg') || subItem.toLowerCase().endsWith('.png')) {
                        allFiles.push({ name: `${item}/${subItem}`, url: `/uploads/${item}/${subItem}`, mtime: fs.statSync(path.join(itemPath, subItem)).mtime.getTime() });
                    }
                });
            } else if (item.toLowerCase().endsWith('.jpg') || item.toLowerCase().endsWith('.png')) {
                allFiles.push({ name: item, url: `/uploads/${item}`, mtime: stat.mtime.getTime() });
            }
        });
        
        allFiles.sort((a, b) => b.mtime - a.mtime);
        res.json({ success: true, files: allFiles });
    } catch (err) { res.json({ success: false, message: err.message }); }
});
// =======================================================
// [BARU] ENDPOINT EXPORT KE FOLDER PICTURES (PC/LAPTOP)
// =======================================================
expressApp.post('/api/export-pictures', (req, res) => {
    try {
        const { files } = req.body;
        if (!files || files.length === 0) {
            return res.status(400).json({ success: false, message: "Tidak ada file yang dipilih." });
        }

        // Gunakan modul 'os' bawaan Node.js untuk mencari direktori User saat ini
        // OS.homedir() biasanya mengarah ke C:\Users\NamaUser
        const picturesFolder = path.join(os.homedir(), 'Pictures', 'Lacasabooth_Export');
        
        // Buat foldernya jika belum pernah dibuat
        if (!fs.existsSync(picturesFolder)) {
            fs.mkdirSync(picturesFolder, { recursive: true });
        }

        // Eksekusi Salin File (Copy)
        let copiedCount = 0;
        files.forEach(file => {
            let relativePath = file;
            if (relativePath.startsWith('/uploads/')) relativePath = relativePath.replace('/uploads/', '');
            else if (relativePath.startsWith('\\uploads\\')) relativePath = relativePath.replace('\\uploads\\', '');
            
            const sourcePath = path.join(uploadDir, relativePath);
            const fileNameOnly = path.basename(relativePath);
            const destPath = path.join(picturesFolder, fileNameOnly);
            
            if (fs.existsSync(sourcePath)) {
                fs.copyFileSync(sourcePath, destPath);
                copiedCount++;
            }
        });

        // [BONUS UX] Buka Windows Explorer otomatis agar klien langsung melihat file-nya
        exec(`explorer "${picturesFolder}"`);

        res.json({ success: true, message: `Berhasil menyalin ${copiedCount} foto.` });
    } catch (err) {
        console.error("Error export ke Pictures:", err);
        res.status(500).json({ success: false, message: "Gagal menyalin file. Pastikan sistem mengizinkan akses folder." });
    }
});
expressApp.post('/api/delete-photos', (req, res) => {
    try {
        if (req.body.files && req.body.files.length > 0) {
            req.body.files.forEach(file => {
                const filePath = path.join(uploadDir, file);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});


// =======================================================
// 11. ☁️ CLOUD SYNC & WHATSAPP
// =======================================================
expressApp.post('/api/send-wa', async (req, res) => {
    let { nomorWa, linkFoto } = req.body;
    if (!nomorWa || !linkFoto) return res.status(400).json({ success: false, message: 'Nomor WA atau link kosong!' });

    let nomorFormat = nomorWa.trim().replace(/\D/g, ''); 
    if (nomorFormat.startsWith('0')) nomorFormat = '62' + nomorFormat.slice(1);

    try {
        const isRegistered = await waClient.isRegisteredUser(`${nomorFormat}@c.us`);
        if (!isRegistered) return res.status(400).json({ success: false, message: 'Nomor tidak terdaftar di WhatsApp!' });
        
        const contactId = await waClient.getNumberId(nomorFormat);
        const chatId = contactId._serialized; 
        const pesan = `Halo dari Lacasaphoto! 📸\n\nTerima kasih sudah berfoto ria bersama kami. Berikut adalah link untuk mengunduh soft file foto estetikmu:\n\n🔗 ${linkFoto}\n\nSegera download foto kamu yaa!\nJangan lupa tag kami! ✨`;
        
        await waClient.sendMessage(chatId, pesan);
        return res.json({ success: true, message: 'Pesan WhatsApp berhasil dikirim!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal mengirim pesan WhatsApp.' });
    }
});

// =======================================================
// 11.5 📊 API STATUS DASHBOARD & ANALITIK
// =======================================================
expressApp.get('/api/sys-status', (req, res) => {
    try {
        let isCamConnected = false;
        try { if (typeof activeCamera !== 'undefined' && activeCamera !== null) isCamConnected = true; } catch(e){}
        
        let sessionsToday = 0;
        let history = {};
        
        if (fs.existsSync(uploadDir)) {
            const items = fs.readdirSync(uploadDir);
            const todayStr = new Date().toISOString().split('T')[0];

            items.forEach(item => {
                const itemPath = path.join(uploadDir, item);
                if (fs.statSync(itemPath).isDirectory() && (item.startsWith('COL-') || item.startsWith('SS-') || item.startsWith('EVT-') || item.startsWith('NEWS-'))) {
                    const stats = fs.statSync(itemPath);
                    const dateStr = stats.mtime.toISOString().split('T')[0];
                    
                    if (dateStr === todayStr) sessionsToday++;
                    if (!history[dateStr]) history[dateStr] = 0;
                    history[dateStr]++;
                }
            });
        }
        
        res.json({ cameraConnected: isCamConnected, totalSessionsToday: sessionsToday, history: history });
    } catch (e) {
        console.error("Error Sys-Status:", e.message);
        res.json({ cameraConnected: false, totalSessionsToday: 0, history: {} });
    }
});

// =======================================================
// 11.6 📷 API DETEKSI ULANG KAMERA (PLUG & PLAY CANON)
// =======================================================
expressApp.get('/api/rescan-camera', (req, res) => {
    try {
        console.log("[SISTEM] Meminta deteksi ulang kamera Canon (EDSDK)...");
        
        activeCamera = null; 
        hubungkanKamera(); 
        
        setTimeout(() => {
            if (activeCamera !== null) {
                res.json({ success: true, message: `Berhasil! Kamera Canon terhubung & siap digunakan.` });
            } else {
                res.json({ success: false, message: "Kamera tidak terdeteksi! Pastikan kabel USB tersambung & kamera Canon menyala." });
            }
        }, 1000);

    } catch (e) {
        console.error("Error Rescan Camera:", e.message);
        res.status(500).json({ success: false, message: "Kesalahan sistem saat merestart EDSDK." });
    }
});
const qrcodeImg = require('qrcode'); 
const midtransClient = require('midtrans-client');

// --- 1. Database Sederhana QRIS (Ditambah Kunci Midtrans) ---
const qrisDataPath = path.join(userDataPath, 'qris_data.json'); // Membuat file penyimpanan permanen

let qrisSettings = {
    type: 'static', 
    staticImageUrl: '/assets/qris_static.png',
    dynamicPrice: 35000,
    midtransServerKey: '', 
    midtransClientKey: '',
    cloudflareToken: '' // <-- Menyatukan token ke database terpisah ini
};

// Mencegah data hilang saat restart dengan membaca file permanen
if (fs.existsSync(qrisDataPath)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(qrisDataPath, 'utf8'));
        qrisSettings = { ...qrisSettings, ...savedData };
    } catch(e) { console.error("Gagal membaca qris_data.json"); }
}

// --- 2. API Pengaturan ---
expressApp.get('/api/settings/qris', (req, res) => {
    res.json(qrisSettings);
});

expressApp.post('/api/settings/qris', express.json(), (req, res) => {
    const { type, dynamicPrice, midtransServerKey, midtransClientKey, cloudflareToken } = req.body;
    
    let isTokenChanged = false;

    if (type) qrisSettings.type = type;
    if (dynamicPrice) qrisSettings.dynamicPrice = dynamicPrice;
    if (midtransServerKey !== undefined) qrisSettings.midtransServerKey = midtransServerKey;
    if (midtransClientKey !== undefined) qrisSettings.midtransClientKey = midtransClientKey;
    
    // Deteksi dan Simpan Token
    if (cloudflareToken !== undefined) {
        if (qrisSettings.cloudflareToken !== cloudflareToken) {
            isTokenChanged = true;
        }
        qrisSettings.cloudflareToken = cloudflareToken;
    }
    
    // Tulis pengaturan ke file permanen qris_data.json
    fs.writeFileSync(qrisDataPath, JSON.stringify(qrisSettings, null, 2));

    // Eksekusi Cloudflare langsung jika token berubah atau baru diisi
    if (isTokenChanged && qrisSettings.cloudflareToken && qrisSettings.cloudflareToken.trim() !== "") {
        console.log("🔄 Token Cloudflare tersimpan! Menyambungkan ke Internet...");
        startCloudflareTunnel();
    }
    
    res.json({ success: true, message: 'Pengaturan QRIS & Token disimpan!', data: qrisSettings });
});
// --- 3. API Generate QRIS Midtrans (Bisa untuk Sesi Utama & Cetak Extra) ---
expressApp.get('/api/payment/qris-dynamic', async (req, res) => {
    try {
        // CEK APAKAH INI BAYAR EXTRA PRINT ATAU SESI UTAMA
        // Jika frontend mengirim ?amount=15000, gunakan itu. Jika tidak, pakai dynamicPrice standar.
        const reqAmount = parseInt(req.query.amount);
        const amount = reqAmount ? reqAmount : qrisSettings.dynamicPrice; 
        
        const serverKey = qrisSettings.midtransServerKey;
        
        if (!serverKey) throw new Error("Server Key Midtrans belum diisi di Dashboard.");
        if (!amount || amount <= 0) throw new Error("Harga belum diatur di Dashboard.");

        const coreApi = new midtransClient.CoreApi({
            isProduction: !serverKey.startsWith('SB-'), 
            serverKey: serverKey,
            clientKey: qrisSettings.midtransClientKey
        });

        // Bedakan ID Order agar rapi di laporan Midtrans
        const orderPrefix = reqAmount ? 'EXTRAPRINT-' : 'PHOTOBOOTH-';
        const orderId = orderPrefix + Date.now();
        
        let parameter = {
            "payment_type": "gopay",
            "transaction_details": {
                "gross_amount": amount,
                "order_id": orderId,
            }
        };

        const chargeResponse = await coreApi.charge(parameter);
        if (chargeResponse.status_code !== '201') throw new Error(`Ditolak Midtrans: ${chargeResponse.status_message}`);

        const actionString = chargeResponse.actions && chargeResponse.actions.find(a => a.name === 'generate-qr-code');
        if (!actionString) throw new Error("Midtrans tidak mengembalikan QR Code");

        const qrImageBase64 = await qrcodeImg.toDataURL(actionString.url, {
            errorCorrectionLevel: 'H', type: 'image/png', margin: 2, width: 400
        });

        res.json({ success: true, qrImage: qrImageBase64, amount: amount, orderId: orderId });
    } catch (error) {
        console.error('Midtrans Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- [BARU] API WEBHOOK MIDTRANS ---
expressApp.post('/api/payment/midtrans-webhook', async (req, res) => {
    try {
        const notif = req.body;
        console.log(`[MIDTRANS] Menerima webhook untuk Order ID: ${notif.order_id} | Status: ${notif.transaction_status}`);
        
        // --- TAMBAHAN LOGIKA REAL-TIME ---
        // Jika pelanggan berhasil membayar (settlement) atau ter-capture
        if (notif.transaction_status === 'capture' || notif.transaction_status === 'settlement') {
            console.log(`[MIDTRANS] ✅ Uang Rp${notif.gross_amount} masuk! Order ID: ${notif.order_id}`);
            
            // Tembakkan sinyal ke UI Klien (Layar depan) agar langsung lanjut foto
            io.emit('payment-success', { 
                orderId: notif.order_id, 
                amount: notif.gross_amount 
            });
        }
        // ----------------------------------

        res.status(200).send('OK'); 
    } catch (error) {
        console.error("Error webhook:", error);
        res.status(500).send('Internal Server Error');
    }
});
// --- 4. API Cek Status Pembayaran (Dinamis per Klien) ---
expressApp.get('/api/payment/check-status/:orderId', async (req, res) => {
    try {
        const serverKey = qrisSettings.midtransServerKey;
        if (!serverKey) return res.json({ success: false, status: 'not_found' });

        const coreApi = new midtransClient.CoreApi({
            isProduction: !serverKey.startsWith('SB-'),
            serverKey: serverKey,
            clientKey: qrisSettings.midtransClientKey
        });

        const statusResponse = await coreApi.transaction.status(req.params.orderId);
        res.json({ success: true, status: statusResponse.transaction_status });
    } catch (error) {
        res.json({ success: false, status: 'not_found' });
    }
});
// =======================================================
// [BARU] INTEGRASI CLOUDFLARE TUNNELS OTOMATIS
// =======================================================
let cfTunnelProcess = null;

function startCloudflareTunnel() {
    try {
        // Ambil token dari memori qrisSettings
        let cfToken = qrisSettings.cloudflareToken || ""; 

        const cloudflaredPath = path.join(__dirname, 'cloudflared.exe').replace('app.asar', 'app.asar.unpacked');

        if (!fs.existsSync(cloudflaredPath)) {
            console.log("⚠️ [CLOUDFLARE] Batal jalan: File cloudflared.exe tidak ditemukan di folder proyek.");
            return;
        }

        if (!cfToken) {
            console.log("⚠️ [CLOUDFLARE] Batal jalan: Token Cloudflare belum diisi di Pengaturan.");
            return;
        }

        console.log("🌐 [CLOUDFLARE] Menghubungkan Mini PC ke Internet...");
        
        // Membunuh proses lama jika sebelumnya nyangkut
        exec('taskkill /f /im cloudflared.exe', (err) => {
            // Menjalankan cloudflared di background
            cfTunnelProcess = spawn(cloudflaredPath, ['tunnel', '--no-autoupdate', 'run', '--token', cfToken]);

            cfTunnelProcess.stdout.on('data', (data) => {
                console.log(`[CF] ${data.toString().trim()}`);
            });

            cfTunnelProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                // Sembunyikan log info biasa agar terminal tidak terlalu penuh, tampilkan yg penting
                if(msg.includes('Registered tunnel connection') || msg.includes('ERR')) {
                    console.log(`[CF TUNNEL] ${msg}`);
                }
            });

            cfTunnelProcess.on('close', (code) => {
                console.log(`[CLOUDFLARE] Tunnel terputus (Kode: ${code}). Mencoba ulang dalam 10 detik...`);
                setTimeout(startCloudflareTunnel, 10000); // Auto-restart jika putus
            });
        });

    } catch (e) {
        console.error("❌ Error menjalankan Cloudflare Tunnel:", e.message);
    }
}

// Panggil fungsinya saat server baru menyala
startCloudflareTunnel();

// Pastikan Cloudflare mati saat aplikasi ditutup
process.on('exit', () => {
    if (cfTunnelProcess) cfTunnelProcess.kill();
    exec('taskkill /f /im cloudflared.exe', () => {});
});
// =======================================================
// 12. AKTIVASI EXPRESS SERVER LOKAL (PORT 3000)
// =======================================================
server.listen(3000, '0.0.0.0', () => {
    console.log("🚀 Server Photobooth Lacasaphoto siap dieksekusi di Port 3000!");
});
process.on('uncaughtException', (err) => console.error('❌ Uncaught Exception:', err.message));