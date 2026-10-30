const chokidar = require('chokidar'); // <-- Tambahkan ini
const { app: electronApp, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const koffi = require('koffi');
const express = require('express');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const crypto = require('crypto');
const { google } = require('googleapis');
const { autoUpdater } = require('electron-updater');


// 1. DEKLARASIKAN FOLDER AMAN UNTUK MENULIS DATA (AppData)
const userDataPath = electronApp.getPath('userData');
// =======================================================
// 🛡️ [POIN 3 PROFESIONAL] ATOMIC JSON WRITE & AUTO-BACKUP
// Mencegah pengaturan/voucher/template hilang saat PC mati mendadak!
// =======================================================
function atomicWriteJson(filePath, dataObj) {
    try {
        const jsonString = JSON.stringify(dataObj, null, 2);
        const tempPath = filePath + '.tmp';
        const backupPath = filePath + '.bak';

        // 1. Tulis ke file sementara (.tmp) terlebih dahulu
        fs.writeFileSync(tempPath, jsonString, 'utf8');

        // 2. Jika file asli sebelumnya ada & sehat, salin ke .bak sebagai cadangan
        if (fs.existsSync(filePath)) {
            try { fs.copyFileSync(filePath, backupPath); } catch (e) {}
        }

        // 3. Pindahkan .tmp menjadi file utama secara instan (Atomic Rename)
        fs.renameSync(tempPath, filePath);
        return true;
    } catch (err) {
        console.error(`❌ [ATOMIC WRITE ERROR] Gagal menulis ${path.basename(filePath)}:`, err.message);
        return false;
    }
}

function safeReadJson(filePath, fallbackObj = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            if (raw && raw.trim().length > 0) {
                return JSON.parse(raw);
            }
        }
    } catch (err) {
        console.warn(`⚠️ [AUTO-RECOVERY] File ${path.basename(filePath)} rusak/corrupt, memulihkan dari cadangan (.bak)...`);
    }
    // Jika file utama corrupt karena mati listrik, pulihkan otomatis dari file .bak!
    const backupPath = filePath + '.bak';
    try {
        if (fs.existsSync(backupPath)) {
            const rawBak = fs.readFileSync(backupPath, 'utf8');
            const parsedBak = JSON.parse(rawBak);
            fs.writeFileSync(filePath, JSON.stringify(parsedBak, null, 2), 'utf8');
            console.log(`✅ [AUTO-RECOVERY] Berhasil memulihkan ${path.basename(filePath)} dari backup!`);
            return parsedBak;
        }
    } catch (e) {}
    return fallbackObj;
}
const watchFolder = path.join(userDataPath, 'hot_folder');
if (!fs.existsSync(watchFolder)) fs.mkdirSync(watchFolder, { recursive: true });

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
} catch (e) {
    console.log("Info: Modul Google Drive belum tersedia.");
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
const customAssetsDir = path.join(userDataPath, 'custom_assets');
if (!fs.existsSync(customAssetsDir)) fs.mkdirSync(customAssetsDir, { recursive: true });
// ---------------------------------------------------------
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
            // [PERBAIKAN] Tambahkan slot "8": [] ke dalam kerangka dasar JSON
            // Jaga-jaga jika file asli terhapus, buat struktur kosong lengkap dengan slot 8
            fs.writeFileSync(dbPath, JSON.stringify({ "1": [], "2": [], "4": [], "6": [], "8": [], "news-1": [], "news-2": [], "news-3": [], "news-4": [] }, null, 4));
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
            flashWorkaround: false,
            mirrorCamera: true,
            livePhotoEnabled: false,
            photoGifEnabled: false,
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

// --- [PERBAIKAN URUTAN PRIORITAS FOLDER] ---
// 1. Baca folder custom (AppData) terlebih dahulu!
expressApp.use('/assets', express.static(customAssetsDir)); 

// 2. Jika tidak ada di custom, baru baca file bawaan dari folder UI
expressApp.use(express.static(uiDir)); 
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
// 2. 🤖 SISTEM WHATSAPP BOT LOKAL (SESI PERMANEN & ANTI BUG)
// =======================================================
const waSessionPath = path.join(userDataPath, 'wa_session');
const waClient = new Client({
    // Menambahkan clientId agar sesi terikat kuat dan permanen
    authStrategy: new LocalAuth({ 
        clientId: "lacasabooth-bot",
        dataPath: waSessionPath 
    }), 
    puppeteer: {
        headless: true,
        executablePath: getBrowserPath(),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', // Mencegah crash memori di latar belakang
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu', // Mengurangi beban CPU Mini PC
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
    console.log('[WA] ✅ Bot WhatsApp Siap Digunakan (Sesi Permanen Aktif)!');
    waBotStatus = 'READY';
    waBotQr = '';
});

waClient.on('authenticated', () => {
    console.log('[WA] Autentikasi berhasil!');
    waBotStatus = 'AUTHENTICATED';
});

// [BARU] Deteksi otomatis jika terputus dari server WhatsApp
waClient.on('disconnected', (reason) => {
    console.log('⚠️ [BOT WA] Sesi terputus! Alasan:', reason);
    waBotStatus = 'DISCONNECTED';
    waBotQr = '';
    
    // Jika terputus karena aplikasi di HP di-logout atau bentrok sesi
    if (reason === 'NAVIGATION' || reason === 'CONFLICT' || reason === 'LOGOUT') {
        console.log('🧹 [BOT WA] Sesi rusak terdeteksi. Menghancurkan memori lama...');
        waClient.destroy();
        // User harus klik tombol "Logout / Reset Bot WA" di Dashboard untuk membersihkan foldernya
    } else {
        // Jika terputus hanya karena jaringan ngadat sesaat, coba inisialisasi ulang
        waClient.initialize(); 
    }
});
try {
    const sessionLockPath = path.join(waSessionPath, 'session-lacasabooth-bot', 'SingletonLock');
    if (fs.existsSync(sessionLockPath)) {
        fs.unlinkSync(sessionLockPath);
        console.log("✅ Kunci sesi WA (SingletonLock) dibersihkan saat startup.");
    }
} catch(e) {}

waClient.initialize().catch(async (err) => {
    console.error("❌ [WA ERROR] Gagal inisialisasi WA:", err.message);
    
    // Buka kunci sesi Chrome secara paksa jika nyangkut dari sesi sebelumnya
    try {
        const sessionLock = path.join(waSessionPath, 'session-lacasabooth-bot', 'SingletonLock');
        if (fs.existsSync(sessionLock)) fs.unlinkSync(sessionLock);
        console.log("✅ Kunci sesi lama berhasil dibersihkan. Server tetap berjalan aman.");
    } catch(e) {}
});

expressApp.get('/api/wa-status', (req, res) => {
    res.json({ status: waBotStatus, qr: waBotQr });
});

// [PERBAIKAN] Logika Logout WA yang menghapus folder sesi hingga bersih
expressApp.post('/api/wa-logout', async (req, res) => {
    try {
        console.log("Memproses Logout WA...");
        await waClient.logout().catch(e => {});
        await waClient.destroy().catch(e => {});
    } catch (e) {}

    // Hapus paksa folder token lama agar WA tidak mendeteksi sebagai spam
    if (fs.existsSync(waSessionPath)) {
        try {
            fs.rmSync(waSessionPath, { recursive: true, force: true });
            console.log("✅ Folder sesi WA lama berhasil dihapus.");
        } catch (err) {
            console.error("Gagal menghapus folder sesi WA:", err.message);
        }
    }

    waBotStatus = 'STARTING';
    waBotQr = '';
    waClient.initialize();
    res.json({ success: true });
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
const EdsSetPropertyData = edsdk.func('EdsError EdsSetPropertyData(EdsBaseRef inRef, uint32 inPropertyID, int32 inParam, uint32 inPropertySize, void* inPropertyData)');
const EdsGetPropertyData = edsdk.func('EdsError EdsGetPropertyData(EdsBaseRef inRef, uint32 inPropertyID, int32 inParam, uint32 inPropertySize, void* outPropertyData)');
// [BARU] FUNGSI KHUSUS POINTER ANGKA (MENCEGAH ERROR 64)
const EdsSetPropertyDataUInt32 = edsdk.func('EdsError EdsSetPropertyData(EdsBaseRef inRef, uint32 inPropertyID, int32 inParam, uint32 inPropertySize, uint32* inPropertyData)');
const EdsGetPropertyDataUInt32 = edsdk.func('EdsError EdsGetPropertyData(EdsBaseRef inRef, uint32 inPropertyID, int32 inParam, uint32 inPropertySize, _Out_ uint32* outPropertyData)');
const EdsSendStatusCommand = edsdk.func('EdsError EdsSendStatusCommand(EdsBaseRef inCameraRef, uint32 inStatusCommand, int32 inParam)');
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

const EdsTerminateSDK = edsdk.func('EdsError EdsTerminateSDK()');
const EdsCloseSession = edsdk.func('EdsError EdsCloseSession(EdsBaseRef inCameraRef)');

function hubungkanKamera(forceReinit = false) {
    console.log("🔌 Mencari kamera Canon via USB...");
    try {
        // Jika diminta rescan paksa dan sebelumnya belum ada kamera aktif, siklus ulang SDK agar bus USB Windows ter-refresh!
        if (forceReinit && isEdsdkInitialized && !activeCamera) {
            try { EdsTerminateSDK(); } catch (e) {}
            isEdsdkInitialized = false;
        }

        if (!isEdsdkInitialized) {
            const initErr = EdsInitializeSDK();
            if (initErr !== 0) {
                console.log(`❌ Gagal menyalakan EDSDK (Kode: 0x${initErr.toString(16)})`);
                return false;
            }
            isEdsdkInitialized = true;
        }

        let cameraList = [null];
        const listErr = EdsGetCameraList(cameraList);
        if (listErr !== 0 || !cameraList[0]) {
            console.log(`⚠️ Gagal mengambil daftar kamera (Kode: 0x${listErr.toString(16)})`);
            return false;
        }

        let count = [0];
        EdsGetChildCount(cameraList[0], count);

        if (count[0] === 0) {
            // WAJIB RELEASE cameraList[0] AGAR TIDAK MENGUNCI BUS USB CANON!
            EdsRelease(cameraList[0]);
            activeCamera = null;
            console.log("⚠️ Tidak ada kamera Canon terdeteksi di jalur EDSDK.");
            return false;
        }

        let camera = [null];
        EdsGetChildAtIndex(cameraList[0], 0, camera);
        // Segera release cameraList setelah kamera diambil
        EdsRelease(cameraList[0]);

        activeCamera = camera[0];
        const sessionErr = EdsOpenSession(activeCamera);

        if (sessionErr === 0) {
            console.log("✅ BERHASIL TERHUBUNG! Kamera Canon siap dikendalikan.");

            // 1. Set kamera menyimpan foto ke PC (Host = 2)
            const saveTo = Buffer.alloc(4);
            saveTo.writeUInt32LE(2, 0);
            EdsSetPropertyData(activeCamera, 0x0000000b, 0, 4, saveTo);

            // 2. Set kapasitas HDD PC agar kamera mau menjepret
            const kapasitasPC = { numberOfFreeClusters: 0x7FFFFFFF, bytesPerSector: 512, reset: 1 };
            EdsSetCapacity(activeCamera, kapasitasPC);

            // 3. Buka Kunci Tombol Bodi Kamera (UI Unlock = 1) - Abaikan jika seri 1200D tidak mendukung
            try { EdsSendStatusCommand(activeCamera, 1, 0); } catch (e) {}

            // 4. Terapkan Setting Segitiga Exposure otomatis
            try {
                const dbSet = safeReadJson(settingsPath, {});
                if (dbSet.global) {
                    const setExp = (propId, valHex) => {
                        if (valHex && valHex !== "auto") {
                            let buf = Buffer.alloc(4);
                            buf.writeUInt32LE(parseInt(valHex, 16), 0);
                            EdsSetPropertyData(activeCamera, propId, 0, 4, buf);
                        }
                    };
                    setTimeout(() => setExp(0x00000402, dbSet.global.canonIso), 150);
                    setTimeout(() => setExp(0x00000406, dbSet.global.canonTv), 350);
                    setTimeout(() => setExp(0x00000405, dbSet.global.canonAv), 550);
                }
            } catch (e) {}

            // 5. Pasang pendengar jepretan (0x0200 = kEdsObjectEvent_All)
            EdsSetObjectEventHandler(activeCamera, 0x0200, callbackPenarikFoto, null);
            return true;
        } else {
            console.log(`❌ Gagal membuka sesi kamera (Kode Error: 0x${sessionErr.toString(16)}). Pastikan aplikasi lain/Windows Photos tidak sedang membuka kamera.`);
            EdsRelease(activeCamera);
            activeCamera = null;
            return false;
        }
    } catch (err) {
        console.error("❌ Exception saat menghubungkan kamera:", err.message);
        activeCamera = null;
        return false;
    }
}

// TAMBAHKAN VARIABEL GLOBAL INI DI ATAS FUNGSI
global.liveViewFrames = []; 
const MAX_LIVE_FRAMES = 50; // Menyimpan ~2 detik terakhir dari Live View

function startLiveView() {
    if (lvInterval || !activeCamera) return;
    const devicePC = Buffer.alloc(4); devicePC.writeUInt32LE(3);
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
// --- TAMBAHKAN DUA BARIS INI (Matikan unduh otomatis) ---
autoUpdater.autoDownload = false; 
autoUpdater.autoInstallOnAppQuit = true;

electronApp.whenReady().then(() => {
    
    // ✨ [PERBAIKAN] Trik Anti-Blokir Google Dinamis
    // Ambil User-Agent bawaan asli dari sistem PC Client
    let originalUserAgent = session.defaultSession.getUserAgent();
    
    // Hapus jejak kata "Electron" dan nama aplikasi agar 100% tersamar sebagai Chrome biasa
    let safeUserAgent = originalUserAgent.replace(/Electron\/[\d.]+\s/g, '').replace(/lacasabooth\/[\d.]+\s/gi, '');
    
    // Terapkan ke seluruh aplikasi dan sesi pop-up
    electronApp.userAgentFallback = safeUserAgent;
    session.defaultSession.setUserAgent(safeUserAgent);

    // --- BYPASS IZIN WEBCAM ELECTRON (TETAP DIPERTAHANKAN) ---
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
            autoUpdater.checkForUpdates(); 
        }, 5000); 
    }
});
// =======================================================
// EVENT LISTENER AUTO-UPDATER & SINGLE INSTANCE LOCK
// =======================================================

// 1. Mencegah aplikasi dibuka 2 kali secara bersamaan (Mencegah Port 3000 Error)
const gotTheLock = electronApp.requestSingleInstanceLock();
if (!gotTheLock) {
    electronApp.quit();
} else {
    electronApp.on('second-instance', () => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length) {
            if (windows[0].isMinimized()) windows[0].restore();
            windows[0].focus();
        }
    });
}

// 2. Tangkap error jika gagal mengunduh (Ini yang menyebabkan stuck 0% sebelumnya)
autoUpdater.on('error', (err) => {
    console.error("❌ Auto-updater error:", err);
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('update-error', err.message || "Gagal mengunduh pembaruan. Pastikan internet stabil.");
    });
});

// 3. Deteksi jika ada update
autoUpdater.on('update-available', (info) => {
    console.log(`🔄 Update versi ${info.version} ditemukan! Mengirim sinyal ke UI...`);
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('update-available-alert', info.version);
    });
});

// 4. Menerima perintah dari UI untuk mengunduh
ipcMain.on('start-download-update', () => {
    console.log("Mulai mengunduh update...");
    // Gunakan catch untuk menangkap kegagalan awal
    autoUpdater.downloadUpdate().catch(err => console.error("Gagal memulai unduhan:", err));
});

// 5. Mengirim progress bar ke UI
autoUpdater.on('download-progress', (progressObj) => {
    let percent = progressObj.percent;
    console.log(`Progress Update: ${percent.toFixed(2)}%`);
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('update-progress', percent);
    });
});

// 6. Otomatis restart jika unduhan selesai (ada jeda 3 detik)
autoUpdater.on('update-downloaded', () => {
    console.log('✅ Update selesai diunduh. Memulai ulang aplikasi untuk memasang pembaruan...');
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('update-ready');
    });
    setTimeout(() => {
        autoUpdater.quitAndInstall(); 
    }, 3000); 
});


const matikanSistem = async () => {
    console.log("🛑 Mematikan mesin & membersihkan sesi latar belakang...");
    try { await waClient.destroy(); } catch (e) {} // Matikan bot WA dengan aman
    if (cfTunnelProcess) cfTunnelProcess.kill();
    exec('taskkill /f /im cloudflared.exe', () => {});
    electronApp.quit();
};

ipcMain.on('tutup-aplikasi', matikanSistem);
ipcMain.on('app-quit', matikanSistem);

// Tangani tombol 'X' bawaan Windows agar tetap melewati proses ini
electronApp.on('window-all-closed', () => { 
    if (process.platform !== 'darwin') matikanSistem();
});
// Menerima perintah cek update manual dari tombol Dashboard
ipcMain.on('cek-update-manual', () => {
    console.log("Mengecek pembaruan manual dari Dashboard...");
    autoUpdater.checkForUpdates();
});
// =======================================================
// [BARU] FITUR SINKRONISASI TEMPLATE DARI GITHUB (FIXED ASYNC)
// =======================================================
ipcMain.handle('sync-templates', async (event, githubBaseUrl) => {
    return new Promise((resolve, reject) => {
        const dbPathSync = path.join(userDataPath, 'database_frame.json');
        const frameDirSync = path.join(userDataPath, 'frames');
        if (!fs.existsSync(frameDirSync)) fs.mkdirSync(frameDirSync, { recursive: true });

        // 1. Unduh file database_frame.json dari GitHub
        const dbUrl = `${githubBaseUrl}/database_frame.json`;

        https.get(dbUrl, (res) => {
            if (res.statusCode !== 200) return reject({ error: `Gagal membaca GitHub (Error ${res.statusCode})` });
            
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    const dbBaru = JSON.parse(data);
                    
                    // 2. Timpa file database di PC Klien
                    fs.writeFileSync(dbPathSync, JSON.stringify(dbBaru, null, 4));

                    // 3. Cari daftar nama gambar yang perlu diunduh
                    let filesToDownload = [];
                    for (let format in dbBaru) {
                        dbBaru[format].forEach(template => {
                            filesToDownload.push(`${template.id}.png`); 
                            if (template.img) {
                                const thumbName = template.img.replace('/frames/', '');
                                filesToDownload.push(thumbName); 
                            }
                        });
                    }

                    // 4. Proses Unduh Gambar Paralel dan TUNGGU sampai semuanya selesai
                    const downloadPromises = filesToDownload.map(fileName => {
                        return new Promise((resolveDl) => {
                            const fileUrl = `${githubBaseUrl}/frames/${fileName}`;
                            const filePath = path.join(frameDirSync, fileName);
                            
                            const fileStream = fs.createWriteStream(filePath);
                            https.get(fileUrl, (imgRes) => {
                                if(imgRes.statusCode === 200) {
                                    imgRes.pipe(fileStream);
                                    fileStream.on('finish', () => {
                                        fileStream.close();
                                        resolveDl(); // Selesai 1 gambar
                                    });
                                } else {
                                    resolveDl(); // Lanjut jika gambar 404 agar tidak error total
                                }
                            }).on('error', () => resolveDl());
                        });
                    });

                    // Tunggu semua gambar beres didownload
                    await Promise.all(downloadPromises);
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
        cb(null, customAssetsDir); // [DIUBAH] Simpan di folder AppData / custom_assets
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `custom-idle-${Date.now()}${ext}`);
    }
});

const uploadIdle = multer({ 
    storage: storageIdle,
    limits: { fileSize: 25 * 1024 * 1024 } 
});

expressApp.post('/api/upload-idle', uploadIdle.single('idleFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "Tidak ada file yang diterima." });
        }

        const fileUrl = `/assets/${req.file.filename}`;
        
        let settings = {};
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
        if (!settings.global) settings.global = {};

        // [DIUBAH] Hapus file custom lama (jika ada) di customAssetsDir
        if (settings.global.customIdleScreen) {
            const oldFileName = path.basename(settings.global.customIdleScreen);
            const oldFilePath = path.join(customAssetsDir, oldFileName);
            if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
        }

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
        const videoPath = path.join(customAssetsDir, 'pose.mp4');

        // [PERBAIKAN] Hapus video lama dulu, lalu copy
        if (fs.existsSync(videoPath)) {
            try { fs.unlinkSync(videoPath); } catch(e) {}
        }
        fs.copyFileSync(req.file.path, videoPath);
        fs.unlinkSync(req.file.path);

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
expressApp.get('/api/open-hot-folder', (req, res) => {
    try {
        if (!fs.existsSync(watchFolder)) fs.mkdirSync(watchFolder, { recursive: true });
        exec(`explorer "${watchFolder}"`);
        res.json({ success: true, path: watchFolder });
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
    const data = safeReadJson(settingsPath, {});
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(data);
});

expressApp.post('/api/settings', (req, res) => {
    try {
        let currentSettings = safeReadJson(settingsPath, {});
        const newSettings = { ...currentSettings, ...req.body };
        
        if (req.body.global) {
            newSettings.global = { ...(currentSettings.global || {}), ...req.body.global };
        }

        atomicWriteJson(settingsPath, newSettings);
        res.json({ success: true, message: "Pengaturan berhasil disimpan dengan aman!" });
    } catch (err) { 
        console.error("Gagal simpan setting:", err);
        res.json({ success: false, message: "Gagal menyimpan pengaturan." }); 
    }
});
// =======================================================
// [BARU] API FACTORY RESET (DANGER ZONE)
// =======================================================
expressApp.post('/api/factory-reset', (req, res) => {
    try {
        console.log("🧨 Memulai proses Reset Sistem ke Default...");

        // 1. Hapus Gambar QRIS Toko [DIUBAH KE customAssetsDir]
        const qrisPath = path.join(customAssetsDir, 'qris_static.png');
        if (fs.existsSync(qrisPath)) fs.unlinkSync(qrisPath);

        // 2. Hapus Video Panduan Pose [DIUBAH KE customAssetsDir]
        const posePath = path.join(customAssetsDir, 'pose.mp4');
        if (fs.existsSync(posePath)) fs.unlinkSync(posePath);

        // 3. Hapus Custom Idle Screen (Tampilan Layar Utama Custom) [DIUBAH KE customAssetsDir]
        if (fs.existsSync(customAssetsDir)) {
            const assetsFiles = fs.readdirSync(customAssetsDir);
            assetsFiles.forEach(file => {
                if (file.startsWith('custom-idle-')) {
                    fs.unlinkSync(path.join(customAssetsDir, file));
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
                flashWorkaround: false,
                mirrorCamera: true,
                livePhotoEnabled: false,
                cloudStorage: true,
                driveParentFolderId: "",
                printer4R: "",
                printerA4: "",
                cloudflareToken: "" // <-- Token CF di pengaturan umum dikosongkan
            },
            waMessage: "Halo dari Lacasaphoto! 📸\n\nTerima kasih sudah berfoto ria bersama kami. Berikut link foto kamu:\n\n🔗 {link}"
        };
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));

        // 4.5. [BARU] Kosongkan Token Cloudflare & Server/Client Key Midtrans QRIS
        const qrisDataPath = path.join(userDataPath, 'qris_data.json');
        const defaultQris = {
            type: 'static', 
            gateway: 'midtrans',
            staticImageUrl: '/assets/qris_static.png',
            dynamicPrice: 35000,
            dynamicExtraPrice: 15000,
            key1: '',
            key2: '',
            key3: '',
            cloudflareToken: ''
        };
        qrisSettings = { ...defaultQris }; // Reset juga variabel yang ada di RAM!
        fs.writeFileSync(qrisDataPath, JSON.stringify(defaultQris, null, 2));
        // Hentikan Cloudflare Tunnel yang berjalan karena tokennya sudah dihapus
        if (cfTunnelProcess) {
            cfTunnelProcess.removeAllListeners('close');
            cfTunnelProcess.kill();
        }
        exec('taskkill /f /im cloudflared.exe', () => {});

        // 5. Bersihkan Daftar Event yang sedang berjalan
        fs.writeFileSync(eventsPath, JSON.stringify({ events: [] }, null, 2));
        activeEvent = null; // Matikan event aktif di memori
        activeSessionId = 'DEFAULT_SESSION';

        // 6. Reset Laporan Analitik (MENGOSONGKAN FOLDER UPLOADS)
        // [PERBAIKAN BUG EPERM] Kita hapus isinya satu per satu, BUKAN merename foldernya
        if (fs.existsSync(uploadDir)) {
            const files = fs.readdirSync(uploadDir);
            for (const file of files) {
                const filePath = path.join(uploadDir, file);
                try {
                    // rmSync akan menghapus file, beserta folder dan sub-foldernya secara paksa
                    fs.rmSync(filePath, { recursive: true, force: true });
                } catch (err) {
                    console.error(`Gagal menghapus file/folder ${file}:`, err.message);
                }
            }
            console.log(`[SISTEM] Analitik direset. Folder uploads telah dikosongkan.`);
        }

        // Catatan: Kredensial GDrive (token.json & oauth_credentials.json) TIDAK disentuh/dihapus.

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

// Variabel penampung token KEDUANYA (ID dan Access)
let tempSaaSTokens = null; 

expressApp.get('/api/auth-google', (req, res) => {
    try {
        if (!oauth2Client) return res.send('File oauth_credentials.json belum dikonfigurasi. Silakan upload melalui Dashboard.');

        tempSaaSTokens = null; // Reset token setiap kali mulai login

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['openid', 'profile', 'email', 'https://www.googleapis.com/auth/drive'],
            prompt: 'consent select_account' 
        });
        
        require('electron').shell.openExternal(authUrl);
        res.json({ success: true, message: "Browser utama telah dibuka." });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

expressApp.get('/api/auth-google-callback', async (req, res) => {
    const code = req.query.code;
    
    if (!oauth2Client || !code) return res.status(400).send("Gagal: Kredensial tidak valid.");
    
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log("🟢 Token G-Drive berhasil disimpan!");
        
        // Simpan KEDUA token agar bisa dipakai Firebase tanpa error
        tempSaaSTokens = {
            idToken: tokens.id_token,
            accessToken: tokens.access_token
        };
        
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h2 style="color: #10b981;">✅ Sukses Terhubung!</h2>
                <p>Akun Google Anda berhasil disambungkan.</p>
                <p>Silakan tutup tab browser ini dan kembali ke aplikasi Lacasabooth.</p>
            </div>
            <script>setTimeout(() => window.close(), 3000);</script>
        `);
    } catch (error) {
        console.error("🔴 Error saat menyimpan token:", error);
        res.status(500).send("Gagal menyimpan token.");
    }
});

expressApp.get('/api/check-saas-token', (req, res) => {
    if (tempSaaSTokens) {
        res.json({ success: true, tokens: tempSaaSTokens });
        tempSaaSTokens = null; // Segera hapus demi keamanan
    } else {
        res.json({ success: false });
    }
});


// =======================================================
// TEMPLATE & QRIS
// =======================================================
expressApp.get('/api/frames', (req, res) => {
    if (fs.existsSync(dbPath)) {
        let db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        
        // [PERBAIKAN] Otomatis tambahkan array kosong jika format baru (seperti "8" atau "news") belum ada di file database lama
        const formatStandar = ["1", "2", "4", "6", "8", "news-1", "news-2", "news-3", "news-4"];
        formatStandar.forEach(fmt => {
            if (!db[fmt]) db[fmt] = [];
        });

        if (req.query.all !== 'true') {
            for (let format in db) {
                if (db[format]) db[format] = db[format].filter(t => t.isHidden !== true);
            }
        }
        res.json(db);
    } else {
        res.json({ "1": [], "2": [], "4": [], "6": [], "8": [], "news-1": [], "news-2": [], "news-3": [], "news-4": [] });
    }
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
        
        const qrisPath = path.join(customAssetsDir, 'qris_static.png');
        
        // [PERBAIKAN] Hapus file QRIS yang lama terlebih dahulu jika ada
        if (fs.existsSync(qrisPath)) {
            try { fs.unlinkSync(qrisPath); } catch(e) { console.log("Gagal hapus file lama (mungkin sedang dibaca)"); }
        }
        
        // [PERBAIKAN] Gunakan metode salin lalu hapus (Lebih aman dari bentrok/kunci file di Windows)
        fs.copyFileSync(req.file.path, qrisPath);
        fs.unlinkSync(req.file.path);
        
        res.json({ success: true, message: 'QRIS berhasil diperbarui!' });
    } catch (err) {
        console.error("Gagal Upload QRIS:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

expressApp.get('/api/get-qris', (req, res) => {
    // [DIUBAH] Cek dari customAssetsDir dulu, lalu ke assetsDir bawaan
    const qrisCustomPath = path.join(customAssetsDir, 'qris_static.png');
    const qrisDefaultPath = path.join(assetsDir, 'qris_static.png');

    if (fs.existsSync(qrisCustomPath) || fs.existsSync(qrisDefaultPath)) {
        res.json({ success: true, url: `/assets/qris_static.png?t=${Date.now()}` });
    } else {
        res.json({ success: false, message: "QRIS belum diatur" });
    }
});

// =======================================================
// [FIXED 100%] API KONTROL SEGITIGA EXPOSURE CANON EDSDK
// =======================================================
const kEdsPropID_ISOSpeed = 0x00000402; // ISO Speed Resmi Canon
const kEdsPropID_Av       = 0x00000405; // Aperture (Av) Resmi Canon
const kEdsPropID_Tv       = 0x00000406; // ✅ Shutter Speed (Tv) Resmi Canon adalah 0x00000406!

expressApp.post('/api/camera-exposure', async (req, res) => {
    if (!activeCamera) return res.json({ success: false, message: "Kamera belum terhubung via USB" });
    const { iso, tv, av } = req.body;
    let debugLog = [];

    try {
        const setPropAsync = async (propId, valHex, name) => {
            if (valHex === undefined || valHex === null || valHex === "") return;
            // Untuk Tv dan Av, abaikan jika dropdown masih tertulis "auto"
            if (valHex === "auto" && propId !== kEdsPropID_ISOSpeed) return;

            let parsedVal = (valHex === "auto") ? 0x00 : parseInt(valHex, 16);
            if (isNaN(parsedVal)) return;

            let buf = Buffer.alloc(4);
            buf.writeUInt32LE(parsedVal, 0);
            let err = EdsSetPropertyData(activeCamera, propId, 0, 4, buf);
            if (err !== 0) {
                debugLog.push(`${name} Err:0x${err.toString(16)}`);
            }
            // Beri jeda 60ms agar prosesor kamera Canon selesai memproses 1 perintah sebelum perintah berikutnya masuk
            await new Promise(r => setTimeout(r, 60));
        };

        await setPropAsync(kEdsPropID_ISOSpeed, iso, "ISO");
        await setPropAsync(kEdsPropID_Tv, tv, "Tv");
        await setPropAsync(kEdsPropID_Av, av, "Av");

        res.json({ success: true, debug: debugLog.join(' | ') });
    } catch (err) {
        res.json({ success: false, message: "Gagal menyetel kamera: " + err.message });
    }
});

expressApp.get('/api/sync-camera', (req, res) => {
    if (!activeCamera) return res.json({ success: false, message: "Kamera belum terhubung / mati" });
    try {
        let debugLog = [];
        const getProp = (propId, name) => {
            let buf = Buffer.alloc(4);
            let err = EdsGetPropertyData(activeCamera, propId, 0, 4, buf);
            if (err === 0) {
                let val = buf.readUInt32LE(0);
                if (val === 0 || val === 0xffffffff) return "auto";
                return val.toString(16).toLowerCase();
            }
            debugLog.push(`${name} Err:0x${err.toString(16)}`);
            return "auto";
        };
        
        res.json({ 
            success: true, 
            iso: getProp(kEdsPropID_ISOSpeed, "ISO"), 
            tv: getProp(kEdsPropID_Tv, "Tv"), 
            av: getProp(kEdsPropID_Av, "Av"),
            debug: debugLog.join(' | ')
        });
    } catch (err) {
        res.json({ success: false, message: "Gagal membaca mesin dari kamera" });
    }
});
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
        if (dbSet.global && (dbSet.global.livePhotoEnabled === true || dbSet.global.livePhotoEnabled === "true")) {
    isLivePhotoOn = true;
}
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
// [FIXED] ENDPOINT PENERIMA FOTO DARI WEBCAM (ANTI-BLANK SAAT MIRROR)
// =======================================================
expressApp.post('/api/upload-webcam', async (req, res) => {
    try {
        const { imageBase64, isMirrored, liveFramesBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ success: false, message: "Tidak ada gambar dari webcam" });

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        const newFileName = `foto_${9999999999999 - Date.now()}_mentah.jpg`;
        
        if (liveFramesBase64 && liveFramesBase64?.length > 0) {
            if (!global.liveFramesByPhoto) global.liveFramesByPhoto = {};
            const framesBuffer = liveFramesBase64.map(b64 => 
                Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), 'base64')
            );
            global.liveFramesByPhoto[newFileName] = {
                buffer: framesBuffer,
                isMirrored: isMirrored
            };
        }

        const sessionDir = path.join(uploadDir, activeSessionId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        const finalFilePath = path.join(sessionDir, newFileName);
        
        // TUNGGU SAMPAI FILE BENAR-BENAR SELESAI DITULIS KE DISK SEBELUM MEMBALAS KE FRONTEND!
        if (isMirrored) {
            const flippedBuf = await sharp(buffer).flop().jpeg({ quality: 92 }).toBuffer();
            fs.writeFileSync(finalFilePath, flippedBuf);
            console.log(`✅ FOTO WEBCAM (MIRRORED) MASUK: ${newFileName}`);
        } else {
            fs.writeFileSync(finalFilePath, buffer);
            console.log(`✅ FOTO WEBCAM MASUK: ${newFileName}`);
        }

        io.emit('foto-baru', { namaFile: newFileName });
        res.json({ success: true, fileName: newFileName });
    } catch (error) {
        console.error("Error upload webcam:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});
// =======================================================
// [BARU] HOT FOLDER WATCHER (Pendeteksi Jepretan Otomatis)
// =======================================================
const watcher = chokidar.watch(watchFolder, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    awaitWriteFinish: {
        stabilityThreshold: 500, // Tunggu 500ms hingga file selesai ditulis oleh kamera
        pollInterval: 100
    }
});

watcher.on('add', (filePath) => {
    if (filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.png')) {
        const newFileName = `foto_${9999999999999 - Date.now()}_mentah.jpg`;
        const sessionDir = path.join(uploadDir, activeSessionId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        
        const finalFilePath = path.join(sessionDir, newFileName);

        try {
            // Salin file dari Hot Folder ke folder Sesi Aktif
            fs.copyFileSync(filePath, finalFilePath);
            // Hapus file asli di hot folder agar tidak menumpuk
            fs.unlinkSync(filePath); 
            
            console.log(`📸 [HOT FOLDER] Shutter Fisik Ditekan! Foto masuk: ${newFileName}`);
            
            // 1. Pancarkan sinyal WebSocket ke UI
            io.emit('foto-baru', { namaFile: newFileName });

            // 2. Kirim sinyal IPC langsung ke Jendela Electron (Frontend HTML)
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send('shutter-fisik-ditekan', { 
                    namaFile: newFileName, 
                    url: `/uploads/${activeSessionId}/${newFileName}` 
                });
            });
        } catch (err) {
            console.error("❌ Gagal memproses file dari Hot Folder:", err);
        }
    }
});

// =======================================================
// 8. MESIN PENGURUS FILE FOTO (EVENT CALLBACK NATIVE)
// =======================================================
const callbackPenarikFoto = koffi.register((inEvent, inRef, inContext) => {
    if (inEvent === 0x0208) { // 0x0208 = Event file foto baru dibuat dari Kamera Canon
        const itemInfo = Buffer.alloc(512);
        EdsGetDirectoryItemInfo(inRef, itemInfo);
        const fileSize = itemInfo.readUInt32LE(0); 

        const newFileName = `foto_${9999999999999 - Date.now()}_mentah.jpg`;
        const tempFilePath = path.join(tempDir, newFileName);
        if (!global.liveFramesByPhoto) global.liveFramesByPhoto = {};
        global.liveFramesByPhoto[newFileName] = {
            buffer: global.lastCapturedLiveFrames || [],
            isMirrored: global.currentMirrorStatus
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
        
        // Fungsi pembantu untuk mengirim sinyal ke UI
        const notifyUI = () => {
            io.emit('foto-baru', { namaFile: newFileName });
            
            // Send sinyal ke frontend bahwa shutter fisik telah menjepret
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send('shutter-fisik-ditekan', { 
                    namaFile: newFileName, 
                    url: `/uploads/${activeSessionId}/${newFileName}` 
                });
            });
        };

        if (global.currentMirrorStatus === true) {
            sharp(tempFilePath).flop().toBuffer().then(buf => {
                fs.writeFileSync(finalFilePath, buf);
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                console.log(`✅ FOTO BERHASIL DI-MIRROR: ${newFileName}`);
                notifyUI();
            }).catch(err => {
                console.error("❌ Gagal melakukan mirror:", err);
            });
        } else {
            fs.renameSync(tempFilePath, finalFilePath);
            console.log(`✅ FOTO MASUK NORMAL: ${newFileName}`);
            notifyUI();
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
// =======================================================
// 🪄 API AI BOOTH PRO (TRUE FACE-LOCK & SCENE TRANSFORMATION)
// =======================================================
expressApp.post('/api/generate-ai', async (req, res) => {
    try {
        const { sessionId, fileName, styleId } = req.body;
        if (!sessionId || !fileName || !styleId) throw new Error("Data tidak lengkap!");

        const sessionDir = path.join(uploadDir, sessionId);
        const inputPath = path.join(sessionDir, fileName);

        if (!fs.existsSync(inputPath)) throw new Error("Foto mentah tidak ditemukan di disk!");

        const falApiKey = "fal_sk_c88a3db8c7a3425f950e08818408c3a5:4a0b04e304e924a1c94f54e749c72aab";
        const meta = await sharp(inputPath).metadata();
        const isPortraitImg = (meta.height > meta.width);
        const targetW = isPortraitImg ? 896 : 1152;
        const targetH = isPortraitImg ? 1152 : 896;
        const imageSizeParam = isPortraitImg ? "portrait_4_3" : "landscape_4_3";

        // Siapkan gambar asli yang jernih
        const resizedBuffer = await sharp(inputPath)
            .resize({ width: targetW, height: targetH, fit: 'cover' })
            .jpeg({ quality: 92 })
            .toBuffer();

        const sourceDataUrl = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
        const outputName = `ai_hasil_${sessionId}.jpg`;
        const outputPath = path.join(sessionDir, outputName);

        // Fungsi 1: Panggil Fal.ai Endpoint
        const callFal = async (endpoint, payload) => {
            const response = await fetch(`https://fal.run/${endpoint}`, {
                method: 'POST',
                headers: { 'Authorization': `Key ${falApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Fal.ai (${endpoint}): ${errText}`);
            }
            return await response.json();
        };

        // Fungsi 2: Unduh URL Gambar menjadi Buffer
        const downloadBuffer = async (url) => {
            const r = await fetch(url);
            return Buffer.from(await r.arrayBuffer());
        };

        // =========================================================================
        // DAFTAR TEMA AI (MENGUBAH SUASANA BACKGROUND & BAJU TANPA KATA HALUSINASI)
        // =========================================================================
        // Catatan: JANGAN gunakan kata "glasses" atau "hijab" di prompt agar AI tidak menggambar kacamata palsu!
        const styleConfigs = {
            // --- KATEGORI A: REALISTIC TELEPORT & COSPLAY (PAKAI FACE-LOCK 100% MIRIP) ---
            'bg_tokyo': {
                mode: 'faceswap_scene',
                strength: 0.72,
                prompt: "cinematic portrait of a person in stylish streetwear jacket standing in Shibuya Tokyo neon street at night, glowing Japanese neon signs, bokeh lights, rain reflections, photorealistic, 8k resolution, masterpiece"
            },
            'bg_paris': {
                mode: 'faceswap_scene',
                strength: 0.72,
                prompt: "cinematic portrait of a person wearing elegant Parisian autumn outfit in front of Eiffel Tower in Paris during golden hour sunset, warm dreamy lighting,カフェ background bokeh, photorealistic, 8k"
            },
            'bg_korea': {
                mode: 'faceswap_scene',
                strength: 0.70,
                prompt: "high-end Korean drama actor profile portrait in Seoul palace garden with blooming pink cherry blossoms, wearing luxury modern Korean outfit, soft dreamy lighting, photorealistic, 8k"
            },
            'bg_beach': {
                mode: 'faceswap_scene',
                strength: 0.72,
                prompt: "cinematic portrait of a person wearing tropical summer outfit at Bali sunset beach club, palm trees, golden ocean waves, warm sunlight glow, photorealistic, 8k"
            },
            'cyberpunk': {
                mode: 'faceswap_scene',
                strength: 0.74,
                prompt: "futuristic Cyberpunk 2077 character portrait wearing glowing high-tech cybernetic armor jacket in a neon sci-fi city at night, magenta and cyan rim lighting, photorealistic cinematic render"
            },
            'korean_studio': {
                mode: 'faceswap_scene',
                strength: 0.65,
                prompt: "professional K-pop idol studio portrait photography, wearing stylish designer blazer, clean aesthetic pastel studio backdrop with dramatic softbox lighting, sharp focus, 8k"
            },

            // --- KATEGORI B: ILLUSTRATION & 3D STYLIZED (WAJAH MIRIP + BACKGROUND BERUBAH) ---
            'anime_3d': {
                mode: 'stylized_keep_face',
                strength: 0.58,
                prompt: "3D Disney Pixar animated movie character, smooth stylized 3D render, expressive eyes, wearing colorful animated adventure outfit, magical glowing Pixar fantasy background, soft studio lighting, no glasses unless worn in original photo"
            },
            'clay_3d': {
                mode: 'stylized_keep_face',
                strength: 0.60,
                prompt: "Aardman stop-motion plasticine claymation figure, handmade sculpted clay texture, miniature diorama background, cute tactile clay art style, soft studio lighting"
            },
            'vintage_90s': {
                mode: 'stylized_keep_face',
                strength: 0.60,
                prompt: "1990s Studio Ghibli anime illustration, hand-drawn cel-shaded anime character, wearing anime outfit, scenic painted anime sky and clouds background, nostalgic retro anime aesthetic"
            },
            'comic_book': {
                mode: 'stylized_keep_face',
                strength: 0.60,
                prompt: "Marvel superhero comic book illustration, bold black ink outlines, halftone pop-art background with dramatic action lines, vibrant comic coloring"
            },
            'watercolor': {
                mode: 'stylized_keep_face',
                strength: 0.58,
                prompt: "artistic watercolor and ink portrait painting on textured canvas, expressive colorful watercolor splashes background, soft brush strokes masterpiece"
            },
            'gta_style': {
                mode: 'stylized_keep_face',
                strength: 0.60,
                prompt: "Grand Theft Auto V official loading screen artwork, stylized digital vector painting, wearing cool street outfit, Miami sunset palm trees background, bold cel-shaded shadows"
            }
        };

        // Fungsi Inti Pemroses 1 Gaya
        const processSingleStyle = async (targetStyleKey) => {
            const cfg = styleConfigs[targetStyleKey] || styleConfigs['anime_3d'];

            // 1. Generate perubahan suasana, pakaian, & bentuk tubuh dengan FLUX Img2Img
            console.log(`🎨 [AI BOOTH] Merender suasana & tubuh untuk style: ${targetStyleKey}...`);
            const genData = await callFal('fal-ai/flux/dev/image-to-image', {
                image_url: sourceDataUrl,
                prompt: cfg.prompt,
                strength: cfg.strength,
                num_inference_steps: 24,
                guidance_scale: 3.5,
                image_size: imageSizeParam,
                enable_safety_checker: false,
                safety_tolerance: "5"
            });

            const baseGeneratedUrl = genData?.images?.[0]?.url;
            if (!baseGeneratedUrl) throw new Error("Gagal merender gambar dasar AI.");

            // 2. JIKA MODE REALISTIC / TELEPORT: Jahit kembali 100% Wajah Asli menggunakan fal-ai/face-swap!
            // Ini menjamin suasana & baju berubah total sesuai tema, TAPI wajah 100% wajah asli pengunjung!
            if (cfg.mode === 'faceswap_scene') {
                try {
                    console.log(`👤 [AI BOOTH] Mengunci kemiripan wajah asli 100% (Face-Lock)...`);
                    const swapData = await callFal('fal-ai/face-swap', {
                        base_image_url: baseGeneratedUrl, // Gambar dengan suasana & baju baru
                        swap_image_url: sourceDataUrl     // Wajah asli dari jepretan kamera
                    });
                    if (swapData?.image?.url) {
                        return await downloadBuffer(swapData.image.url);
                    }
                } catch (swapErr) {
                    console.warn("⚠️ Face-swap dilewati (mungkin wajah miring), menggunakan hasil FLUX langsung:", swapErr.message);
                }
            }

            return await downloadBuffer(baseGeneratedUrl);
        };

        // ==========================================================
        // EKSEKUSI: APAKAH 4-GRID MULTI-UNIVERSE ATAU 1 FOTO?
        // ==========================================================
        if (styleId === 'multi_4grid') {
            console.log(`🌌 [AI BOOTH] Merakit 4-in-1 Multi-Universe secara paralel...`);
            const [bufTokyo, bufPixar, bufAnime] = await Promise.all([
                processSingleStyle('bg_tokyo'),
                processSingleStyle('anime_3d'),
                processSingleStyle('vintage_90s')
            ]);

            const slotW = Math.round(targetW / 2);
            const slotH = Math.round(targetH / 2);
            const pad = 24;
            const totalW = (slotW * 2) + (pad * 3);
            const totalH = (slotH * 2) + (pad * 3) + 80;

            const [s1, s2, s3, s4] = await Promise.all([
                sharp(resizedBuffer).resize(slotW, slotH, { fit: 'cover' }).toBuffer(),
                sharp(bufTokyo).resize(slotW, slotH, { fit: 'cover' }).toBuffer(),
                sharp(bufPixar).resize(slotW, slotH, { fit: 'cover' }).toBuffer(),
                sharp(bufAnime).resize(slotW, slotH, { fit: 'cover' }).toBuffer()
            ]);

            const bgCanvasSvg = `<svg width="${totalW}" height="${totalH}"><rect width="100%" height="100%" fill="#fdf8f9"/><text x="50%" y="${totalH - 28}" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="bold" fill="#9e4261">✨ LACASABOOTH.ID — AI MULTI-UNIVERSE ✨</text></svg>`;

            await sharp(Buffer.from(bgCanvasSvg))
                .composite([
                    { input: s1, left: pad, top: pad },
                    { input: s2, left: (pad * 2) + slotW, top: pad },
                    { input: s3, left: pad, top: (pad * 2) + slotH },
                    { input: s4, left: (pad * 2) + slotW, top: (pad * 2) + slotH }
                ])
                .jpeg({ quality: 92 })
                .toFile(outputPath);
        } else {
            const finalBuffer = await processSingleStyle(styleId);
            fs.writeFileSync(outputPath, finalBuffer);
        }

        // Kirim hasil ke layar detik ini juga!
        const localUrl = `http://${getLocalIP()}:3000/uploads/${sessionId}/${outputName}`;
        res.json({ 
            success: true, 
            fileUrl: `/uploads/${sessionId}/${outputName}`,
            driveLink: localUrl
        });

        // Upload ke GDrive di latar belakang
        (async () => {
            try {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                const isOnlineMode = settings.global?.cloudStorage !== false;
                const parentFolderId = settings.global?.driveParentFolderId || "1scPtcs7JaGmnF4TYfpUL2DIcN_7iU9DB";
                if (isOnlineMode && typeof uploadToDrive === 'function') {
                    const uploadedUrl = await uploadToDrive(outputPath, `AIBooth_${sessionId}`, parentFolderId);
                    if (uploadedUrl) io.emit('ai-drive-ready', { sessionId, url: uploadedUrl });
                }
            } catch (e) {}
        })();

    } catch (error) {
        console.error("Error Generate AI:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

expressApp.post('/api/generate-photobox', async (req, res) => {
    try {
        // 🔥 1. GEMBOK SESI SAAT INI AGAR ANTI-BENTROK DENGAN SESI BERIKUTNYA!
        const lockedSessionId = activeSessionId;

        let db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        let templateData = null;
        for (let formatKey in db) {
            const foundTemplate = db[formatKey].find(t => t.id === req.body.templateId);
            if (foundTemplate) { templateData = foundTemplate; break; }
        }
        if (!templateData) return res.status(400).json({ success: false, message: "Template tidak ditemukan!" });
        
        // GUNAKAN lockedSessionId MULAI DARI SINI SAMPAI BAWAH
        const sessionDir = path.join(uploadDir, lockedSessionId);
        let statusRotasiFoto = []; 
        
        const prosesFotoPromises = req.body.selectedPhotos.map(async (fotoName, i) => {
            const coord = templateData.layout.coords[i];
            const w = coord.width || templateData.layout.width;
            const h = coord.height || templateData.layout.height;
            
            const rawPhotoPath = path.join(sessionDir, fotoName);
            let imgPipeline = sharp(rawPhotoPath);
            const meta = await imgPipeline.metadata();
            
            let imgW = meta.width;
            let imgH = meta.height;
            let needsRot = false;
            
            if (req.body.orientation === 'potret' && imgW > imgH) {
                imgPipeline = imgPipeline.rotate(90); 
                needsRot = true;
                imgW = meta.height;
                imgH = meta.width; 
            }
            statusRotasiFoto[i] = needsRot;

            // 1. BACA NILAI GESER (X, Y) DAN ZOOM DARI FRONTEND
            let offX = 50, offY = 50, zoomFactor = 1.0;
            if (req.body.customOffsets && req.body.customOffsets[i]) {
                offX = parseFloat(req.body.customOffsets[i].x);
                offY = parseFloat(req.body.customOffsets[i].y);
                zoomFactor = parseFloat(req.body.customOffsets[i].zoom) || 1.0;
                if (isNaN(offX)) offX = 50;
                if (isNaN(offY)) offY = 50;
                zoomFactor = Math.max(1.0, Math.min(3.0, zoomFactor));
            }

            // 2. KALKULASI UKURAN GAMBAR SETELAH DI-ZOOM
            const baseScale = Math.max(w / imgW, h / imgH);
            const finalScale = baseScale * zoomFactor;
            const scaledW = Math.max(w, Math.round(imgW * finalScale));
            const scaledH = Math.max(h, Math.round(imgH * finalScale));

            let cropX = Math.round((scaledW - w) * (offX / 100));
            let cropY = Math.round((scaledH - h) * (offY / 100));

            cropX = Math.max(0, Math.min(cropX, scaledW - w));
            cropY = Math.max(0, Math.min(cropY, scaledH - h));

            imgPipeline = imgPipeline
                .resize(scaledW, scaledH) 
                .extract({ left: cropX, top: cropY, width: w, height: h });

            if (req.body.effect) {
                const ef = req.body.effect;
                if (ef === 'monochrome') {
                    imgPipeline = imgPipeline.grayscale().linear(1.2, -10);
                } else if (ef === 'sepia') {
                    imgPipeline = imgPipeline.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]);
                } else if (ef === 'soft') {
                    imgPipeline = imgPipeline.modulate({ brightness: 1.12, saturation: 1.25 }).linear(0.92, 10);
                } else if (ef === 'warm') {
                    imgPipeline = imgPipeline.recomb([[1.12, 0.05, 0.0], [0.0, 1.02, 0.0], [0.0, 0.0, 0.88]]).modulate({ brightness: 1.05, saturation: 1.15 });
                } else if (ef === 'cool') {
                    imgPipeline = imgPipeline.recomb([[0.90, 0.0, 0.0], [0.0, 1.02, 0.05], [0.05, 0.08, 1.15]]).modulate({ brightness: 1.04 });
                } else if (ef === 'retro') {
                    imgPipeline = imgPipeline.modulate({ brightness: 1.06, saturation: 0.82 }).recomb([[1.08, 0.06, 0.0], [0.02, 1.0, 0.02], [0.04, 0.04, 0.90]]);
                } else if (ef === 'vivid') {
                    imgPipeline = imgPipeline.modulate({ brightness: 1.04, saturation: 1.45 }).linear(1.15, -12);
                }
            }
            const processedPhoto = await imgPipeline.toBuffer();
            return { input: processedPhoto, top: coord.y, left: coord.x };
        });

        let komposisi = await Promise.all(prosesFotoPromises);
        
        // Tambahkan layer Frame Utama
        const frameFilePath = path.join(frameDir, `${req.body.templateId}.png`);
        komposisi.push({ input: frameFilePath, top: 0, left: 0 });
        
        const frameMeta = await sharp(frameFilePath).metadata();
        const canvasFullW = frameMeta.width || 1200;
        const canvasFullH = frameMeta.height || 1800;

        // 3. [BARU] RENDER OVERLAY STIKER JIKA ADA STIKER DARI FRONTEND
        if (req.body.stickers && Array.isArray(req.body.stickers) && req.body.stickers.length > 0) {
            for (const stk of req.body.stickers) {
                try {
                    if (stk.dataUrl) {
                        const stkB64 = stk.dataUrl.replace(/^data:image\/\w+;base64,/, "");
                        const stkBuf = Buffer.from(stkB64, 'base64');
                        const stkSize = Math.round((stk.sizePct || 12) / 100 * canvasFullW);
                        const resizedStk = await sharp(stkBuf).resize(stkSize, stkSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
                        const leftPos = Math.max(0, Math.min(canvasFullW - stkSize, Math.round((stk.xPct / 100) * canvasFullW - (stkSize / 2))));
                        const topPos = Math.max(0, Math.min(canvasFullH - stkSize, Math.round((stk.yPct / 100) * canvasFullH - (stkSize / 2))));
                        komposisi.push({ input: resizedStk, left: leftPos, top: topPos });
                    }
                } catch (stkErr) {
                    console.error("Gagal merender stiker:", stkErr.message);
                }
            }
        }

        const outputName = `foto_${lockedSessionId}_hasil.jpg`;
        const outputPath = path.join(sessionDir, outputName);

        // 🖼️ RENDER GAMBAR FOTO JPG
        await sharp({ create: { width: canvasFullW, height: canvasFullH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
        .composite(komposisi)
        .jpeg({ quality: 90, mozjpeg: true })
        .toFile(outputPath);
        // ==========================================
        // 2. PERSIAPAN DATA BACKGROUND (DENGAN LOCK)
        // ==========================================
        const savedLiveFrames = global.liveFramesByPhoto ? Object.assign({}, global.liveFramesByPhoto) : {};
        global.liveFramesByPhoto = {}; 

        let isOnlineMode = true; 
        let parentFolderId = "1scPtcs7JaGmnF4TYfpUL2DIcN_7iU9DB"; 
        let isLivePhotoOn = false;
        let isPhotoGifOn = false;

        try {
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.global && settings.global.cloudStorage !== undefined) isOnlineMode = settings.global.cloudStorage;
                if (settings.global && settings.global.driveParentFolderId) parentFolderId = settings.global.driveParentFolderId;
                
                // Cek apakah fitur diaktifkan di Dashboard DAN dicentang oleh user di layar
                const dashLive = (settings.global?.livePhotoEnabled === true || settings.global?.livePhotoEnabled === "true");
                const dashGif = (settings.global?.photoGifEnabled === true || settings.global?.photoGifEnabled === "true");
                
                isLivePhotoOn = dashLive && (req.body.livePhoto !== false);
                isPhotoGifOn = dashGif && (req.body.photoGif !== false);
            }
        } catch (e) {}

        let urlLivePhoto = isLivePhotoOn ? 'processing' : null;
        // 🚀 3. KIRIM BALASAN KE LAYAR KLIEN DETIK INI JUGA!
        res.json({ 
            success: true, 
            file: `/uploads/${lockedSessionId}/${outputName}`, 
            driveLink: "processing", 
            livePhoto: urlLivePhoto 
        });

        // ==========================================
        // 👻 4. BACKGROUND TASK ANTI-BENTROK SESI
        // ==========================================
        (async () => {
            const datePrefix = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
            const driveFolderName = `${datePrefix}_${lockedSessionId}`;
            
            let pathGif = null;
            const namaGif = `live_${lockedSessionId}.gif`;

            let pathPhotoGif = null;
            const namaPhotoGif = `slideshow_${lockedSessionId}.gif`;

            // ---> TUGAS A: GOOGLE DRIVE (Mendapatkan Link Folder Spesifik)
            const driveTask = (async () => {
                if (isOnlineMode && typeof uploadToDrive === 'function') {
                    try {
                        const folderLink = await uploadToDrive(outputPath, driveFolderName, parentFolderId);
                        const finalLink = folderLink || `https://drive.google.com/drive/folders/${parentFolderId}`;
                        io.emit('qr-ready', { sessionId: lockedSessionId, url: finalLink });
                    } catch(err) {
                        io.emit('qr-ready', { sessionId: lockedSessionId, url: `https://drive.google.com/drive/folders/${parentFolderId}` });
                    }
                } else {
                    const ipLokal = getLocalIP();
                    io.emit('qr-ready', { sessionId: lockedSessionId, url: `http://${ipLokal}:3000/uploads/${lockedSessionId}/${outputName}` });
                }
            })();

            // ---> TUGAS B: FFMPEG (Merakit GIF BOOMERANG WEBCAM / LIVE PHOTO)
            const gifTask = (async () => {
                if (isLivePhotoOn && req.body.selectedPhotos && req.body.selectedPhotos.length > 0) {
                    pathGif = path.join(sessionDir, namaGif);
                    const wAsli = frameMeta.width || 1200;
                    const hAsli = frameMeta.height || 1800;
                    const sf = 600 / wAsli; 
                    const canvasW = 600;
                    const canvasH = Math.round(hAsli * sf);

                    let ffmpegInputs = `-i "${path.join(frameDir, `${req.body.templateId}.png`).replace(/\\/g, '/')}" `;
                    let filterComplex = `color=c=white:s=${canvasW}x${canvasH}:d=2.5[bg0];`; 
                    let overlayChain = ``;
                    let foldersToClean = [];

                    const fsPromises = require('fs').promises; 

                    for (let i = 0; i < req.body.selectedPhotos.length; i++) {
                        const fotoName = req.body.selectedPhotos[i];
                        const slotDir = path.join(tempDir, `frames_${lockedSessionId}_slot_${i}`);
                        if (!fs.existsSync(slotDir)) fs.mkdirSync(slotDir, { recursive: true });
                        foldersToClean.push(slotDir);

                        let frameData = savedLiveFrames[fotoName];
                        let framesBuffer = frameData ? frameData.buffer : null;
                        let isMirrored = frameData ? frameData.isMirrored : false;
                        let isFallback = false;
                        
                        if (!framesBuffer || framesBuffer.length === 0) {
                            const fallbackImg = fs.readFileSync(path.join(sessionDir, fotoName));
                            framesBuffer = Array(50).fill(fallbackImg);
                            isFallback = true; 
                        }

                        const writePromises = framesBuffer.map((buf, idx) => {
                            return fsPromises.writeFile(path.join(slotDir, `frame_${String(idx).padStart(3, '0')}.jpg`), buf);
                        });
                        await Promise.all(writePromises);

                        ffmpegInputs += `-framerate 20 -i "${path.join(slotDir, 'frame_%03d.jpg').replace(/\\/g, '/')}" `;

                        const coord = templateData.layout.coords[i];
                        const sw = Math.round((coord.width || templateData.layout.width) * sf);
                        const sh = Math.round((coord.height || templateData.layout.height) * sf);
                        const sx = Math.round(coord.x * sf);
                        const sy = Math.round(coord.y * sf);

                        const mirrorFilter = (isMirrored && !isFallback) ? 'hflip,' : '';
                        const rotFilter = statusRotasiFoto[i] ? 'transpose=1,' : '';

                        let offX = 50, offY = 50;
                        if (req.body.customOffsets && req.body.customOffsets[i]) {
                            offX = parseFloat(req.body.customOffsets[i].x);
                            offY = parseFloat(req.body.customOffsets[i].y);
                            if (isNaN(offX)) offX = 50;
                            if (isNaN(offY)) offY = 50;
                        }

                        offX = Math.max(0, Math.min(100, offX));
                        offY = Math.max(0, Math.min(100, offY));

                        const cx = `(in_w-${sw})*(${offX}/100)`;
                        const cy = `(in_h-${sh})*(${offY}/100)`;

                        filterComplex += `[${i+1}:v]${mirrorFilter}${rotFilter}scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh}:${cx}:${cy}[v${i+1}];`;
                        overlayChain += `[bg${i}][v${i+1}]overlay=x=${sx}:y=${sy}[bg${i+1}];`;
                    } 

                    filterComplex += `[0:v]scale=${canvasW}:${canvasH}[frame];`;
                    filterComplex += overlayChain;
                    const jumlahSlot = req.body.selectedPhotos.length;
                    filterComplex += `[bg${jumlahSlot}][frame]overlay=0:0,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
                    
                    const outputPattern = pathGif.replace(/\\/g, '/');
                    const ffmpegPath = path.join(__dirname, 'ffmpeg.exe').replace('app.asar', 'app.asar.unpacked');
                    const ffmpegCmd = `"${ffmpegPath}" -y ${ffmpegInputs} -filter_complex "${filterComplex}" -loop 0 "${outputPattern}"`;

                    await new Promise((resolve) => {
                        exec(ffmpegCmd, (error, stdout, stderr) => {
                            if (!error) {
                                io.emit('gif-ready', { sessionId: lockedSessionId, url: `/uploads/${lockedSessionId}/${namaGif}` });
                            } else {
                                io.emit('gif-failed', { sessionId: lockedSessionId });
                            }
                            foldersToClean.forEach(folder => {
                                try { fs.rmSync(folder, { recursive: true, force: true }); } catch(e){}
                            });
                            resolve();
                        });
                    });
                }
            })();

            // ---> TUGAS C: FFMPEG (Merakit GIF SLIDESHOW DARI FOTO MENTAH)
            const photoGifTask = (async () => {
                if (isPhotoGifOn && req.body.selectedPhotos && req.body.selectedPhotos.length > 0) {
                    pathPhotoGif = path.join(sessionDir, namaPhotoGif);
                    const slotDir = path.join(tempDir, `slideshow_${lockedSessionId}`);
                    if (!fs.existsSync(slotDir)) fs.mkdirSync(slotDir, { recursive: true });

                    // Salin foto mentah pilihan user ke folder sementara (diurutkan)
                    let fotoCount = 0;
                    for (const fotoName of req.body.selectedPhotos) {
                        const src = path.join(sessionDir, fotoName);
                        const dst = path.join(slotDir, `frame_${String(fotoCount).padStart(3, '0')}.jpg`);
                        if (fs.existsSync(src)) {
                            // Jika foto berorientasi potret dari kamera, putar dulu secara fisik
                            if (statusRotasiFoto[fotoCount]) {
                                await sharp(src).rotate(90).toFile(dst);
                            } else {
                                fs.copyFileSync(src, dst);
                            }
                            fotoCount++;
                        }
                    }

                    if (fotoCount > 0) {
                        const ffmpegPath = path.join(__dirname, 'ffmpeg.exe').replace('app.asar', 'app.asar.unpacked');
                        // Kecepatan 1.5 FPS = 1 foto tampil sekitar 0.66 detik, dengan kualitas warna tinggi
                        const ffmpegCmd = `"${ffmpegPath}" -y -framerate 1.5 -i "${path.join(slotDir, 'frame_%03d.jpg').replace(/\\/g, '/')}" -vf "scale=600:-1,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" -loop 0 "${pathPhotoGif.replace(/\\/g, '/')}"`;

                        await new Promise((resolve) => {
                            exec(ffmpegCmd, (error) => {
                                if (!error) {
                                    io.emit('photo-gif-ready', { sessionId: lockedSessionId, url: `/uploads/${lockedSessionId}/${namaPhotoGif}` });
                                }
                                try { fs.rmSync(slotDir, { recursive: true, force: true }); } catch(e){}
                                resolve();
                            });
                        });
                    }
                }
            })();

            // ---> TUGAS D: UPLOAD SEMUA FILE KE DRIVE SETELAH SELESAI
            await Promise.all([driveTask, gifTask, photoGifTask]);
            
            if (isOnlineMode && typeof uploadToDrive === 'function') {
                if (isLivePhotoOn && fs.existsSync(pathGif)) {
                    try { await uploadToDrive(pathGif, driveFolderName, parentFolderId); } catch(err) {}
                }
                if (isPhotoGifOn && fs.existsSync(pathPhotoGif)) {
                    try { await uploadToDrive(pathPhotoGif, driveFolderName, parentFolderId); } catch(err) {}
                }
                const allRawFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('_mentah.jpg'));
                for (let fotoName of allRawFiles) {
                    const rawPath = path.join(sessionDir, fotoName);
                    if (fs.existsSync(rawPath)) {
                        try { await uploadToDrive(rawPath, driveFolderName, parentFolderId); } catch(err) {}
                    }
                }
            }
        })();
        
    } catch (error) { 
        res.status(500).json({ success: false, message: error.message }); 
    }
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

// -------------------------------------------------------
// [BARU] API UNTUK MEMBUAT DUPLIKAT PROFIL PRINTER
// -------------------------------------------------------
expressApp.post('/api/duplicate-printer', (req, res) => {
    const { originalPrinterName, newPrinterName } = req.body;

    if (!originalPrinterName || !newPrinterName) {
        return res.status(400).json({ success: false, message: 'Nama printer asal dan nama baru wajib diisi.' });
    }

    // [PERBAIKAN]: Tambahkan $ErrorActionPreference = 'Stop' agar jika gagal, PS langsung melempar error keras
    const psScript = `
        $ErrorActionPreference = 'Stop';
        $printer = Get-Printer -Name "${originalPrinterName}";
        Add-Printer -Name "${newPrinterName}" -DriverName $printer.DriverName -PortName $printer.PortName;
    `;

    exec(`powershell.exe -Command "${psScript}"`, (error, stdout, stderr) => {
        // [PERBAIKAN]: Cek apakah ada error dari sistem ATAU ada tulisan merah di terminal (stderr)
        if (error || stderr) {
            const errMsg = (error ? error.message : stderr).toLowerCase();
            console.error('[PRINTER ERROR]', errMsg);
            
            // Deteksi penolakan akses (Bahasa Inggris & Indonesia)
            if (errMsg.includes('access is denied') || errMsg.includes('access denied') || errMsg.includes('akses ditolak')) {
                return res.status(500).json({ 
                    success: false, 
                    needsAdmin: true, 
                    message: 'Akses ditolak! Aplikasi belum dijalankan sebagai Administrator.' 
                });
            }
            
            // Error lain (misal: printernya sudah ada)
            return res.status(500).json({ 
                success: false, 
                message: 'Gagal menduplikasi printer. Pastikan printer asal benar atau printer baru belum ada.' 
            });
        }
        
        // Jika benar-benar sukses dan tidak ada error
        res.json({ success: true, message: `Profil printer baru "${newPrinterName}" berhasil dibuat!` });
    });
});

function processPrintQueue() {
    if (isPrinting || printQueue.length === 0) return;
    isPrinting = true;
    const task = printQueue.shift(); 
    console.log(`🖨️ [PRINTER] Mencetak ke: "${task.printerName}" (${ path.basename(task.fileName) })`);
    exec(task.command, (error) => {
        if (error) console.error("[PRINTER ERROR]:", error.message);
        setTimeout(() => { isPrinting = false; processPrintQueue(); }, 3500); 
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
    let settings = safeReadJson(settingsPath, {});
    if (!settings.global) settings.global = {};

    const irfanViewPath = path.join(__dirname, 'IrfanView', 'i_view64.exe').replace('app.asar', 'app.asar.unpacked');
    let printerTarget = "";
    let folderConfig = path.join(userDataPath, 'irfan_config_4R');

    if (size === 'A4' || mode === 'newspaper') { 
        printerTarget = settings.global.printerA4 || ""; 
        folderConfig = path.join(userDataPath, 'irfan_config_A4');
    } else {
        // =========================================================================
        // 🔀 LOGIKA DUAL PRINTER LOAD BALANCING (BERGANTIAN 1 -> 2 -> 1 LINTAS SESI)
        // =========================================================================
        const p1 = (settings.global.printer4R || "").trim();
        const p2 = (settings.global.printer4R_2 || "").trim();
        const isDualActive = settings.global.dualPrinterEnabled === true && p1 !== "" && p2 !== "";

        if (isDualActive) {
            // Baca history printer mana yang terakhir mendapat tugas (1 atau 2)
            let lastIdx = settings.global.lastUsedPrinterIndex || 2;
            let nextIdx = (lastIdx === 1) ? 2 : 1;

            printerTarget = (nextIdx === 1) ? p1 : p2;

            // Simpan kembali history terbaru ke settings.json agar diingat sampai sesi berikutnya!
            settings.global.lastUsedPrinterIndex = nextIdx;
            atomicWriteJson(settingsPath, settings);
            console.log(`🔀 [DUAL PRINTER] Giliran Printer ${nextIdx} (${printerTarget})`);
        } else {
            // Jika fitur Dual Printer OFF (atau Printer 2 belum dipilih), gunakan Printer 1 biasa
            printerTarget = p1;
        }
    }

    if (!printerTarget && action !== 'open') {
        console.log("❌ Gagal Print: Klien belum memilih printer di Dashboard.");
        return res.status(400).json({ success: false, message: "Printer belum disetel di Dashboard!" });
    }

    if (!fs.existsSync(folderConfig)) fs.mkdirSync(folderConfig, { recursive: true });

    let perintahPrint = action === 'open' 
        ? `"${irfanViewPath}" "${targetPath}" /ini="${folderConfig}"`
        : `"${irfanViewPath}" "${targetPath}" /ini="${folderConfig}" /print="${printerTarget}"`;

    printQueue.push({ fileName: namaFileMentah, command: perintahPrint, printerName: printerTarget });
    processPrintQueue();
    res.json({ success: true, assignedPrinter: printerTarget });
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

    // 1. Pembersihan Nomor (Logika Anda sudah bagus, ditambah pengaman +62)
    let nomorFormat = nomorWa.trim().replace(/\D/g, ''); 
    if (nomorFormat.startsWith('0')) nomorFormat = '62' + nomorFormat.slice(1);
    if (nomorFormat.startsWith('+62')) nomorFormat = '62' + nomorFormat.slice(3);

    try {
        // 2. [VAKSIN] Cek apakah sesi WA mesin benar-benar hidup (menghindari error nyangkut)
        if (!waClient || !waClient.info) {
            return res.status(500).json({ success: false, message: 'Sesi WA terputus. Silakan Reset Bot WA di Dashboard.' });
        }

        const isRegistered = await waClient.isRegisteredUser(`${nomorFormat}@c.us`);
        if (!isRegistered) return res.status(400).json({ success: false, message: 'Nomor tidak terdaftar di WhatsApp!' });
        
        const contactId = await waClient.getNumberId(nomorFormat);
        const chatId = contactId._serialized; 
        
        let customPesan = "Halo dari Lacasaphoto! 📸\n\nTerima kasih sudah berfoto ria bersama kami. Berikut link foto kamu:\n\n🔗 {link}"; 
        
        try {
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.waMessage) {
                    customPesan = settings.waMessage;
                }
            }
        } catch (e) {
            console.error("Gagal membaca pesan WA dari pengaturan:", e);
        }

        const pesanAkhir = customPesan.replace('{link}', linkFoto);
        
        await waClient.sendMessage(chatId, pesanAkhir);
        return res.json({ success: true, message: 'Pesan WhatsApp berhasil dikirim!' });
    } catch (error) {
        console.error("Error Kirim WA:", error);
        // 3. [VAKSIN] Tampilkan pesan error asli dari mesin ke layar Toast UI
        res.status(500).json({ success: false, message: `Sistem WA: ${error.message}` });
    }
});
// =======================================================
// 📷 DETEKTOR USB MULTI-MERK (CANON, SONY, FUJIFILM, NIKON)
// =======================================================
let externalCameraConnected = false;
let detectedCameraModelName = "";

function cekKameraUsbUniversal(engineTarget = 'canon') {
    return new Promise((resolve) => {
        if (engineTarget === 'canon' && activeCamera !== null) {
            detectedCameraModelName = "Canon EOS (EDSDK)";
            return resolve(true);
        }
        if (engineTarget === 'webcam') {
            detectedCameraModelName = "UVC Webcam / Capture Card";
            return resolve(true);
        }

        // Cek perangkat USB Kamera yang tertancap di Windows via PnP (Sony, Fujifilm, Nikon, atau Canon 1200D)
        const psCheck = `Get-PnpDevice -PresentOnly | Where-Object { $_.Class -match 'Image|Camera|WPD|USB' -and $_.FriendlyName -match 'Canon|Sony|Fuji|Nikon|ILCE|DSC|X-T|X-S|X-A|EOS' } | Select-Object -ExpandProperty FriendlyName`;
        exec(`powershell -NoProfile -Command "${psCheck}"`, (err, stdout) => {
            if (!err && stdout && stdout.trim().length > 0) {
                const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
                detectedCameraModelName = lines[0];
                externalCameraConnected = true;
                resolve(true);
            } else {
                externalCameraConnected = false;
                detectedCameraModelName = "";
                resolve(false);
            }
        });
    });
}
// =======================================================
// 11.5 📊 API STATUS DASHBOARD & ANALITIK (SUPPORT MULTI-MERK)
// =======================================================
expressApp.get('/api/sys-status', async (req, res) => {
    try {
        const cfg = safeReadJson(settingsPath, {});
        const currentEngine = cfg?.global?.cameraEngine || 'canon';
        let isCamConnected = false;

        if (currentEngine === 'canon') {
            isCamConnected = (typeof activeCamera !== 'undefined' && activeCamera !== null);
            if (!isCamConnected) isCamConnected = await cekKameraUsbUniversal('canon');
        } else {
            isCamConnected = await cekKameraUsbUniversal(currentEngine);
        }
        
        let sessionsToday = 0;
        let history = {};
        
        if (fs.existsSync(uploadDir)) {
            const items = fs.readdirSync(uploadDir);
            const todayStr = new Date().toISOString().split('T')[0];

            items.forEach(item => {
                const itemPath = path.join(uploadDir, item);
                if (fs.statSync(itemPath).isDirectory() && (item.startsWith('COL-') || item.startsWith('SS-') || item.startsWith('EVT-') || item.startsWith('NEWS-') || item.startsWith('AIBOOTH-'))) {
                    const stats = fs.statSync(itemPath);
                    const dateStr = stats.mtime.toISOString().split('T')[0];
                    
                    if (dateStr === todayStr) sessionsToday++;
                    if (!history[dateStr]) history[dateStr] = 0;
                    history[dateStr]++;
                }
            });
        }
        
        res.json({ 
            cameraConnected: isCamConnected, 
            cameraModel: detectedCameraModelName || currentEngine.toUpperCase(),
            totalSessionsToday: sessionsToday, 
            history: history 
        });
    } catch (e) {
        console.error("Error Sys-Status:", e.message);
        res.json({ cameraConnected: false, totalSessionsToday: 0, history: {} });
    }
});

// =======================================================
// 11.6 📷 API DETEKSI ULANG KAMERA (CANON, SONY, FUJIFILM, NIKON, WEBCAM)
// =======================================================
expressApp.get('/api/rescan-camera', async (req, res) => {
    try {
        const cfg = safeReadJson(settingsPath, {});
        const currentEngine = (cfg?.global?.cameraEngine || 'canon').toLowerCase();
        console.log(`[SISTEM] Meminta deteksi ulang kamera (Mode: ${currentEngine.toUpperCase()})...`);

        if (currentEngine === 'canon') {
            activeCamera = null; 
            hubungkanKamera(true);
            
            setTimeout(async () => {
                if (activeCamera !== null) {
                    res.json({ success: true, message: `✅ Berhasil! Kamera Canon EOS (EDSDK) terhubung & siap digunakan.` });
                } else {
                    const usbDetected = await cekKameraUsbUniversal('canon');
                    if (usbDetected) {
                        res.json({ success: true, message: `✅ Kamera ${detectedCameraModelName} terdeteksi di USB Windows (Mode Kompatibilitas).` });
                    } else {
                        res.json({ success: false, message: "⚠️ Kamera Canon tidak terdeteksi! Pastikan kabel USB tersambung & kamera menyala." });
                    }
                }
            }, 900);
        } else if (currentEngine === 'webcam') {
            res.json({ success: true, message: "✅ Mode Webcam / Capture Card (UVC) aktif & siap digunakan!" });
        } else {
            const isConnected = await cekKameraUsbUniversal(currentEngine);
            if (isConnected) {
                res.json({ success: true, message: `✅ Berhasil! Kamera ${detectedCameraModelName || currentEngine.toUpperCase()} terdeteksi & siap digunakan.` });
            } else {
                res.json({ success: true, message: `ℹ️ Mode ${currentEngine.toUpperCase()} diaktifkan. Pastikan kamera tersambung ke USB.` });
            }
        }
    } catch (e) {
        console.error("Error Rescan Camera:", e.message);
        res.status(500).json({ success: false, message: "Kesalahan sistem saat memindai kamera." });
    }
});
// =========================================================================
// 🌟 SISTEM PEMBAYARAN LANGGANAN SAAS OTOMATIS (NEETPAY DEVELOPER)
// =========================================================================
const SAAS_NEETPAY_API_KEY = "np_live_4c039c655b74c1e5c3229b1e799ef47b86ff66911a0f73f9";

expressApp.post('/api/saas/create-invoice', async (req, res) => {
    try {
        const { email, tier, duration, amount } = req.body;
        if (!email || !tier || !amount) {
            return res.status(400).json({ success: false, message: "Data transaksi tidak lengkap." });
        }

        const durasiClean = (duration || '1Bulan').toString().replace(/\s+/g, '');
        const orderId = `SUBS-${tier.toUpperCase()}-${durasiClean}-${Date.now()}`;
        const finalAmount = Number(amount);

        const npRes = await fetch('https://api.neetpay.web.id/v1/transactions', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + SAAS_NEETPAY_API_KEY,
                'X-API-KEY': SAAS_NEETPAY_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                orderId: orderId,
                order_id: orderId,
                amount: finalAmount,
                customerName: email.split('@')[0],
                description: `Langganan Lacasabooth ${tier.toUpperCase()} (${duration})`
            })
        });

        const npData = await npRes.json().catch(() => ({}));
        if (!npRes.ok || npData.success === false) {
            const errDetail = npData?.error?.details ? JSON.stringify(npData.error.details) : (npData.message || 'Gagal membuat tagihan NeetPay');
            return res.status(400).json({ success: false, message: `NeetPay: ${errDetail}` });
        }

        const d = npData.data || npData;
        const qrString = d.qrString || d.qr_string || d.qrContent || d.qr_content || d.qrisString || d.qris_string || d.qrCode || d.qr_code;
        if (!qrString) {
            return res.status(400).json({ success: false, message: "NeetPay tidak mengembalikan data QRIS." });
        }

        const qrcode = require('qrcode');
        const qrImageBase64 = await qrcode.toDataURL(qrString, {
            errorCorrectionLevel: 'H', type: 'image/png', margin: 2, width: 380
        });

        return res.json({
            success: true,
            orderId: orderId,
            amount: finalAmount,
            qrImage: qrImageBase64
        });
    } catch (error) {
        console.error("Error Create SaaS NeetPay:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

expressApp.get('/api/saas/check-status/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const npRes = await fetch(`https://api.neetpay.web.id/v1/transactions/${orderId}`, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + SAAS_NEETPAY_API_KEY,
                'X-API-KEY': SAAS_NEETPAY_API_KEY,
                'Accept': 'application/json'
            }
        });

        const npData = await npRes.json().catch(() => ({}));
        const d = npData.data || npData;
        const trxStatus = (d?.status || '').toString().toUpperCase();
        const isSuccess = (trxStatus === 'PAID' || trxStatus === 'SUCCESS' || trxStatus === 'SETTLEMENT' || trxStatus === 'COMPLETED');

        if (npRes.ok && isSuccess) {
            return res.json({ success: true, status: 'PAID' });
        }
        return res.json({ success: true, status: 'PENDING', debug: trxStatus || 'WAITING' });
    } catch (error) {
        console.error("Error Check Status SaaS NeetPay:", error);
        return res.json({ success: false, status: 'ERROR' });
    }
});

const qrcodeImg = require('qrcode'); 
const midtransClient = require('midtrans-client');

// --- 1. Database Sederhana QRIS (Ditambah Kunci Midtrans) ---
const qrisDataPath = path.join(userDataPath, 'qris_data.json'); // Membuat file penyimpanan permanen

let qrisSettings = {
    type: 'static', 
    gateway: 'midtrans', // <-- [BARU] Menyimpan nama penyedia payment gateway
    staticImageUrl: '/assets/qris_static.png',
    dynamicPrice: 35000,
    midtransServerKey: '', 
    midtransClientKey: '',
    cloudflareToken: '' 
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
    let currentToken = "";
    try {
        // Ambil token dari settings.json agar tampil di kolom saat dashboard dibuka
        if (fs.existsSync(settingsPath)) {
            const dbSet = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (dbSet.global && dbSet.global.cloudflareToken) {
                currentToken = dbSet.global.cloudflareToken;
            }
        }
    } catch(e) {}
    res.json({ ...qrisSettings, cloudflareToken: currentToken });
});

expressApp.post('/api/settings/qris', (req, res) => {
   // 1. [PERBAIKAN] Tambahkan 'dynamicExtraPrice' ke dalam daftar tangkapan data
    const { type, gateway, dynamicPrice, dynamicExtraPrice, key1, key2, key3, cloudflareToken } = req.body;
    
    if (type) qrisSettings.type = type;
    if (gateway) qrisSettings.gateway = gateway; 
    if (dynamicPrice) qrisSettings.dynamicPrice = dynamicPrice;
    
    // 2. [BARU] Simpan Harga Extra Dinamis ke memori server
    if (dynamicExtraPrice !== undefined) qrisSettings.dynamicExtraPrice = dynamicExtraPrice; 
    
    // Simpan ke variabel global backend
    qrisSettings.key1 = key1 || "";
    qrisSettings.key2 = key2 || "";
    qrisSettings.key3 = key3 || "";
    
    // Tulis pengaturan QRIS ke file permanen qris_data.json
    fs.writeFileSync(qrisDataPath, JSON.stringify(qrisSettings, null, 2));
    
    // Masukkan Cloudflare Token ke settings.json agar dibaca oleh fungsi startCloudflareTunnel
    if (cloudflareToken !== undefined) {
        try {
            if (fs.existsSync(settingsPath)) {
                let dbSet = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (!dbSet.global) dbSet.global = {};
                
                // Deteksi apakah ada perubahan token
                const isTokenChanged = dbSet.global.cloudflareToken !== cloudflareToken;
                
                dbSet.global.cloudflareToken = cloudflareToken;
                fs.writeFileSync(settingsPath, JSON.stringify(dbSet, null, 2));
                
                // Langsung sambungkan ke Cloudflare tanpa perlu restart aplikasi
                if (isTokenChanged && cloudflareToken.trim() !== "") {
                    console.log("🔄 Token baru terdeteksi! Menyambungkan ulang Cloudflare Tunnel...");
                    startCloudflareTunnel();
                }
            }
        } catch(e) {
            console.error("Gagal menyimpan token Cloudflare:", e);
        }
    }
    
    res.json({ success: true, message: 'Pengaturan QRIS disimpan & Tunnel aktif!', data: qrisSettings });
});
// =======================================================
// 🎟️ SISTEM DATABASE VOUCHER & DISKON MASSAL
// =======================================================
const vouchersPath = path.join(userDataPath, 'vouchers.json');
if (!fs.existsSync(vouchersPath)) {
    fs.writeFileSync(vouchersPath, JSON.stringify([], null, 2));
}

function readVouchers() {
    try { return JSON.parse(fs.readFileSync(vouchersPath, 'utf8')); } catch (e) { return []; }
}
function saveVouchers(list) {
    fs.writeFileSync(vouchersPath, JSON.stringify(list, null, 2));
}

// 1. Ambil daftar semua voucher/diskon
expressApp.get('/api/vouchers', (req, res) => {
    res.json({ success: true, vouchers: readVouchers() });
});

// 2. Generate Massal (Bulk Generate)
expressApp.post('/api/vouchers/generate', (req, res) => {
    try {
        const { type, prefix = '', count = 10, amount = 0 } = req.body;
        let list = readVouchers();
        let existingCodes = new Set(list.map(v => v.code));
        let generated = [];

        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Tanpa huruf O/0/I/1 yang membingungkan saat dicetak
        const makeRandom = (len = 5) => {
            let s = '';
            for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
            return s;
        };

        for (let i = 0; i < count; i++) {
            let code = '';
            do {
                code = `${prefix}${makeRandom(5)}`.toUpperCase();
            } while (existingCodes.has(code));

            existingCodes.add(code);
            const item = {
                code,
                type: type === 'discount' ? 'discount' : 'voucher',
                amount: type === 'discount' ? parseInt(amount) : 0,
                isUsed: false,
                createdAt: new Date().toISOString()
            };
            list.unshift(item);
            generated.push(item);
        }

        saveVouchers(list);
        res.json({ success: true, generated });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 3. Validasi Voucher / Diskon dari Layar Klien
expressApp.post('/api/validate-voucher', (req, res) => {
    const { code, expectedType } = req.body;
    if (!code) return res.json({ success: false, message: "Kode kosong!" });

    let list = readVouchers();
    const cleanInput = code.trim().toUpperCase().replace(/[-_\s]/g, '');
    const idx = list.findIndex(v => v.code.toUpperCase().replace(/[-_\s]/g, '') === cleanInput);

    if (idx === -1) return res.json({ success: false, message: "Kode tidak ditemukan!" });
    if (list[idx].isUsed) return res.json({ success: false, message: "Kode ini sudah pernah digunakan!" });
    if (expectedType && list[idx].type !== expectedType) {
        return res.json({ success: false, message: `Kode ini adalah kode ${list[idx].type}, bukan ${expectedType}!` });
    }

    // Jika ini voucher gratis (langsung klaim), tandai terpakai sekarang
    if (list[idx].type === 'voucher') {
        list[idx].isUsed = true;
        list[idx].usedAt = new Date().toISOString();
        saveVouchers(list);
    }

    res.json({ success: true, voucher: list[idx] });
});

// 4. Hapus Semua Voucher
expressApp.post('/api/vouchers/clear', (req, res) => {
    saveVouchers([]);
    res.json({ success: true });
});

function markDiscountUsedIfPending(orderId) {
    const code = pendingDiscountOrders[orderId];
    if (!code) return;
    let vList = readVouchers();
    const idx = vList.findIndex(v => v.code === code);
    if (idx !== -1 && !vList[idx].isUsed) {
        vList[idx].isUsed = true;
        vList[idx].usedAt = new Date().toISOString();
        saveVouchers(vList);
        console.log(`✅ [DISKON TERPAKAI PERMANEN] Kode ${code} hangus karena Order ${orderId} telah LUNAS.`);
    }
    delete pendingDiscountOrders[orderId];
}
// --- 3. API Generate QRIS Multi-Gateway (Mesin Otak Super) ---
// Variabel penyimpan kupon diskon yang sedang dipakai di order aktif (belum lunas)
const pendingDiscountOrders = {};

expressApp.all('/api/payment/qris-dynamic', async (req, res) => {
    try {
        let reqAmount = (req.method === 'POST' && req.body && req.body.amount) ? parseInt(req.body.amount) :
                        (req.query && req.query.amount) ? parseInt(req.query.amount) : null;
        
        // 1. Ambil harga awal
        const basePrice = reqAmount ? reqAmount : parseInt(qrisSettings.dynamicPrice || 35000);
        let amount = basePrice;
        if (!amount || amount <= 0) throw new Error("Harga belum diatur di Dashboard.");

        const orderPrefix = reqAmount ? 'EXTRAPRINT-' : 'PHOTOBOOTH-';
        const orderId = orderPrefix + Date.now();

        // 2. Potong harga jika ada kode diskon (?discount=KODE)
        // PENTING: Jangan tandai isUsed = true sekarang agar jika halaman di-refresh atau ganti gateway ke DOKU, diskon tetap memotong!
        const rawDiscount = (req.query && req.query.discount) ? req.query.discount : (req.body && req.body.discount ? req.body.discount : "");
        const discountCode = rawDiscount.toString().trim().toUpperCase().replace(/[-_\s]/g, '');
        
        if (discountCode) {
            let vList = readVouchers();
            const dIdx = vList.findIndex(v => v.code.toUpperCase().replace(/[-_\s]/g, '') === discountCode && v.type === 'discount' && !v.isUsed);
            if (dIdx !== -1) {
                const potongan = parseInt(vList[dIdx].amount) || 0;
                amount = Math.max(1000, basePrice - potongan);
                pendingDiscountOrders[orderId] = vList[dIdx].code; // Catat untuk dihanguskan saat LUNAS nanti
                console.log(`🏷️ [DISKON AKTIF] Kode ${vList[dIdx].code} diterapkan ke ${qrisSettings.gateway.toUpperCase()}! Harga awal Rp ${basePrice} -> Rp ${amount}`);
            } else {
                console.log(`⚠️ [DISKON GAGAL] Kode '${rawDiscount}' tidak ditemukan atau sudah terpakai.`);
            }
        }

        const gateway = qrisSettings.gateway || 'midtrans';
        const key1 = qrisSettings.key1 ? qrisSettings.key1.trim() : "";
        const key2 = qrisSettings.key2 ? qrisSettings.key2.trim() : "";
        const key3 = qrisSettings.key3 ? qrisSettings.key3.trim() : "";
        let qrString = ""; 
        let checkoutUrlFallback = null;
        const autoWebhookUrl = global.publicTunnelUrl ? `${global.publicTunnelUrl}/api/payment/universal-webhook` : undefined;

        // 🧠 1. OTAK MIDTRANS & GOBIZ
        if (gateway === 'midtrans' || gateway === 'gobiz') {
            if (!key1) throw new Error("Server Key Midtrans belum diisi!");
            const isProd = !key1.includes('SB-'); 
            const coreApi = new midtransClient.CoreApi({ isProduction: isProd, serverKey: key1, clientKey: key2 });
            const chargeRes = await coreApi.charge({ payment_type: "gopay", transaction_details: { gross_amount: amount, order_id: orderId } });
            if (chargeRes.status_code !== '201') throw new Error(`Midtrans: ${chargeRes.status_message}`);
            const actionData = chargeRes.actions.find(a => a.name === 'generate-qr-code');
            qrString = actionData.url; 
        }
        
        // 🧠 2. OTAK XENDIT
        else if (gateway === 'xendit') {
            if (!key1) throw new Error("Secret API Key Xendit belum diisi!");
            const authHeader = 'Basic ' + Buffer.from(key1 + ':').toString('base64');
            const xenRes = await fetch('https://api.xendit.co/qr_codes', {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference_id: orderId, type: 'DYNAMIC', currency: 'IDR', amount: amount })
            });
            const xenData = await xenRes.json();
            if (!xenRes.ok) throw new Error(`Xendit: ${xenData.message}`);
            qrString = xenData.qr_string;
        } 
        
        // 🧠 3. OTAK TRIPAY
        else if (gateway === 'tripay') {
            if (!key1 || !key2 || !key3) throw new Error("API Key, Merchant Code, dan Private Key Tripay wajib diisi lengkap!");
            const signature = crypto.createHmac('sha256', key3).update(key2 + orderId + amount).digest('hex');
            const tpRes = await fetch('https://tripay.co.id/api/transaction/create', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + key1, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    method: 'QRIS', merchant_ref: orderId, amount: amount, 
                    customer_name: 'Guest Photobooth', customer_email: 'guest@lacasabooth.id', customer_phone: '081234567890',
                    order_items: [{ sku: 'PB', name: 'Photobooth Session', price: amount, quantity: 1 }],
                    signature: signature
                })
            });
            const tpData = await tpRes.json();
            if (!tpData.success) throw new Error(`Tripay: ${tpData.message}`);
            qrString = tpData.data.qr_string;
        } 
        
        // 🧠 4. OTAK DUITKU
        else if (gateway === 'duitku') {
            if (!key1 || !key2) throw new Error("API Key dan Merchant Code Duitku belum diisi!");
            const signatureDuitku = crypto.createHash('md5').update(key2 + orderId + amount + key1).digest('hex');
            const dkRes = await fetch('https://api-prod.duitku.com/api/merchant/v2/inquiry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    merchantCode: key2, paymentAmount: amount, merchantOrderId: orderId,
                    productDetails: 'Photobooth', email: 'guest@lacasabooth.id',
                    paymentMethod: 'Q1', 
                    signature: signatureDuitku
                })
            });
            const dkData = await dkRes.json();
            if (dkData.statusCode !== '00') throw new Error(`Duitku: ${dkData.statusMessage}`);
            qrString = dkData.qrString; 
        } 
        
        // 🧠 5. OTAK DOKU (JOKUL CHECKOUT QRIS LOCKED + AUTO EXTRACT QR)
        else if (gateway === 'doku') {
            if (!key1 || !key2) throw new Error("Secret Key dan Client ID DOKU belum diisi!");
            
            const isSandbox = key2.startsWith('SB-') || key1.startsWith('SB-') || key3.toLowerCase() === 'sandbox';
            const cleanClientId = key2.replace('SB-', '').trim(); 
            const cleanSecretKey = key1.trim();
            const dokuBaseUrl = isSandbox ? 'https://api-sandbox.doku.com' : 'https://api.doku.com';

            const targetPath = '/checkout/v1/payment'; 
            const timestamp = new Date().toISOString().slice(0, 19) + 'Z';
            const requestId = crypto.randomUUID ? crypto.randomUUID() : 'qr-' + Date.now();

            const bodyPayload = {
                order: {
                    amount: parseInt(amount),
                    invoice_number: orderId,
                    currency: "IDR",
                    callback_url: "https://lacasaphoto.id",
                    line_items: [
                        { name: "Sesi Photobooth", price: parseInt(amount), quantity: 1 }
                    ]
                },
                payment: {
                    payment_due_date: 15,
                    payment_method_types: ["QRIS"]
                },
                customer: {
                    id: "GUEST-" + orderId,
                    name: "Guest Photobooth",
                    email: "guest@lacasaphoto.id",
                    phone: "6281234567890"
                }
            };

            const jsonBody = JSON.stringify(bodyPayload);
            const digest = crypto.createHash('sha256').update(jsonBody).digest('base64');
            const sigComponent = `Client-Id:${cleanClientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${timestamp}\nRequest-Target:${targetPath}\nDigest:${digest}`;
            const signatureDoku = 'HMACSHA256=' + crypto.createHmac('sha256', cleanSecretKey).update(sigComponent).digest('base64');

            const dokuRes = await fetch(dokuBaseUrl + targetPath, {
                method: 'POST',
                headers: {
                    'Client-Id': cleanClientId, 
                    'Request-Id': requestId, 
                    'Request-Timestamp': timestamp,
                    'Signature': signatureDoku, 
                    'Content-Type': 'application/json'
                },
                body: jsonBody
            });

            const dokuData = await dokuRes.json().catch(() => ({}));

            if (!dokuRes.ok) {
                let errMsg = dokuData?.error?.message || dokuData?.response?.message || dokuData?.message || JSON.stringify(dokuData);
                throw new Error(`DOKU: ${errMsg}`);
            }

            let extractedQr = dokuData?.response?.qr_content || dokuData?.response?.payment?.qr_content || dokuData?.qr_content || dokuData?.qr_code;
            const checkoutUrl = dokuData?.response?.payment?.url;

            if (!extractedQr && checkoutUrl) {
                try {
                    const pageRes = await fetch(checkoutUrl);
                    const pageHtml = await pageRes.text();
                    const qrisMatch = pageHtml.match(/000201[0-9A-Za-z.\-_/@\s]{50,500}6304[0-9A-Fa-f]{4}/);
                    if (qrisMatch && qrisMatch[0]) {
                        extractedQr = qrisMatch[0].trim();
                        console.log("✅ [DOKU] Berhasil mengekstrak String QRIS Murni (EMVCo)!");
                    }
                } catch (scrapeErr) {
                    console.log("ℹ️ [DOKU] Menggunakan URL Checkout QRIS langsung.");
                }
            }

            checkoutUrlFallback = checkoutUrl || null;
            qrString = extractedQr || checkoutUrl;

            if (!qrString) {
                throw new Error("DOKU: Gagal mendapatkan data QRIS dari respons server.");
            }
        }
        
        // 🧠 6. OTAK NEETPAY (FIXED 100% - Menggunakan camelCase 'orderId')
        else if (gateway === 'neetpay') {
            if (!key1) throw new Error("API Key NeetPay belum diisi!");
            const cleanAmount = Number(amount);

            const npRes = await fetch('https://api.neetpay.web.id/v1/transactions', {
                method: 'POST',
                headers: { 
                    'Authorization': 'Bearer ' + key1,
                    'X-API-KEY': key1,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ 
                  orderId: orderId,
                  order_id: orderId,
                  amount: cleanAmount,
                  customerName: "Guest Photobooth",
                  description: "Sesi Photobooth",
                  callback_url: autoWebhookUrl,
                  webhook_url: autoWebhookUrl
              })
            });
            
            const npData = await npRes.json().catch(() => ({}));
            if (!npRes.ok || npData.success === false) {
                const errDetail = npData?.error?.details ? JSON.stringify(npData.error.details) : (npData.message || 'Gagal generate QRIS');
                throw new Error(`NeetPay: ${errDetail}`);
            }
            
            // Tangkap teks QR String dari balasan server NeetPay (mendukung berbagai struktur objek data)
            const d = npData.data || npData;
            qrString = d.qrString || d.qr_string || d.qrContent || d.qr_content || d.qrisString || d.qris_string || d.qrCode || d.qr_code;
        }
        // --- KONVERSI DATA QR KE GAMBAR YANG BISA DILIHAT KLIEN ---
        if (!qrString) throw new Error("Gagal mengekstrak QR String dari penyedia.");
        
        const qrcode = require('qrcode');
        const qrImageBase64 = await qrcode.toDataURL(qrString, {
            errorCorrectionLevel: 'H', type: 'image/png', margin: 2, width: 400
        });

        res.json({ 
            success: true, 
            qrImage: qrImageBase64, 
            amount: amount, 
            orderId: orderId,
            checkoutUrl: checkoutUrlFallback,
            isRawQris: qrString.startsWith('000201') // True jika murni EMVCo QRIS
        });
    } catch (error) {
        console.error('Payment Gateway Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- 4. UNIVERSAL WEBHOOK (Menerima sinyal bayar lunas dari semua Gateway) ---
expressApp.post('/api/payment/universal-webhook', async (req, res) => {
    try {
        const notif = req.body;
        const gateway = qrisSettings.gateway || 'midtrans';
        let isLunas = false;
        let invoiceId = "";
        let nominal = 0;

        // Mesin Pendeteksi Webhook
        if (gateway === 'midtrans' || gateway === 'gobiz') {
            isLunas = (notif.transaction_status === 'capture' || notif.transaction_status === 'settlement');
            invoiceId = notif.order_id;
            nominal = notif.gross_amount;
        } 
        else if (gateway === 'xendit') {
            isLunas = (notif.status === 'COMPLETED' || notif.status === 'PAID');
            invoiceId = notif.external_id || notif.reference_id;
            nominal = notif.amount;
        } 
        else if (gateway === 'tripay') {
            isLunas = (notif.status === 'PAID');
            invoiceId = notif.merchant_ref;
            nominal = notif.total_amount;
        }
        else if (gateway === 'duitku') {
            isLunas = (notif.resultCode === '00');
            invoiceId = notif.merchantOrderId;
            nominal = notif.amount;
        }
        else if (gateway === 'doku') {
            const trxStatus = (notif?.transaction?.status || notif?.order?.status || '').toString().toUpperCase();
            isLunas = (trxStatus === 'SUCCESS' || trxStatus === 'PAID' || trxStatus === 'SETTLEMENT');
            invoiceId = notif?.order?.invoice_number || "";
            nominal = notif?.order?.amount || 0;
            
        }
        // 🚀 TAMBAHKAN LOGIKA NEETPAY DI SINI:
        else if (gateway === 'neetpay') {
            isLunas = (notif.status === 'PAID' || notif.status === 'SUCCESS');
            invoiceId = notif.orderId || notif.order_id || notif.reference;
            nominal = notif.amount;
        }

        // Tembak Sinyal UI Klien agar lanjut foto
        if (isLunas && invoiceId) {
            console.log(`[WEBHOOK] ✅ Uang Rp${nominal} masuk dari ${gateway.toUpperCase()}! Order ID: ${invoiceId}`);
            io.emit('payment-success', { orderId: invoiceId, amount: nominal });
            markDiscountUsedIfPending(invoiceId);
        }

        // Balas 200 OK agar server gateway berhenti mengirim spam ping
        res.status(200).send({ success: true, message: 'Webhook Received' }); 
    } catch (error) {
        console.error("Error webhook:", error);
        res.status(500).send('Internal Server Error');
    }
});
// --- 4. API Cek Status Pembayaran Universal (Dinamis per Klien) ---
expressApp.get('/api/payment/check-status/:orderId', async (req, res) => {
    try {
        const gateway = qrisSettings.gateway || 'midtrans';
        const orderId = req.params.orderId;
        const key1 = qrisSettings.key1 ? qrisSettings.key1.trim() : "";
        const key2 = qrisSettings.key2 ? qrisSettings.key2.trim() : "";

        // 1. Cek Manual via Midtrans / Gobiz
        if (gateway === 'midtrans' || gateway === 'gobiz') {
            if (!key1) return res.json({ success: false, status: 'not_found' });
            
            // Deteksi otomatis: Jika ada awalan SB-, berarti mode Sandbox
            const isProd = !key1.includes('SB-'); 
            
            const coreApi = new midtransClient.CoreApi({ isProduction: isProd, serverKey: key1, clientKey: key2 });
            const statusResponse = await coreApi.transaction.status(orderId);
            return res.json({ success: true, status: statusResponse.transaction_status });
        }
        
        // 2. Cek Manual via Tripay
        else if (gateway === 'tripay') {
            if (!key1) return res.json({ success: false, status: 'not_found' });
            const tpRes = await fetch(`https://tripay.co.id/api/transaction/detail?reference=${orderId}`, {
                method: 'GET', headers: { 'Authorization': 'Bearer ' + key1 }
            });
            const tpData = await tpRes.json();
            if (tpData.success) {
                // Konversi status Tripay (PAID) menjadi bahasa yang dipahami sistem depan (settlement)
                return res.json({ success: true, status: tpData.data.status === 'PAID' ? 'settlement' : 'pending' });
            }
        }
        
        // 3. Cek Manual via Duitku
        else if (gateway === 'duitku') {
            if (!key1 || !key2) return res.json({ success: false, status: 'not_found' });
            const signature = crypto.createHash('md5').update(key2 + orderId + key1).digest('hex');
            const dkRes = await fetch('https://api-prod.duitku.com/api/merchant/v2/transactionStatus', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ merchantCode: key2, merchantOrderId: orderId, signature: signature })
            });
            const dkData = await dkRes.json();
            // 00 adalah kode sukses Duitku
            return res.json({ success: true, status: dkData.statusCode === '00' ? 'settlement' : 'pending' });
        }
        // 5. Cek Manual via NeetPay
        else if (gateway === 'neetpay') {
            if (!key1) return res.json({ success: false, status: 'not_found' });
            const npRes = await fetch(`https://api.neetpay.web.id/v1/transactions/${orderId}`, {
                method: 'GET', 
                headers: { 
                    'Authorization': 'Bearer ' + key1,
                    'X-API-KEY': key1,
                    'Accept': 'application/json'
                }
            });
            const npData = await npRes.json().catch(() => ({}));
            if (npRes.ok) {
                const rawSt = (npData?.data?.status || npData?.status || '').toString().toUpperCase();
                const isPaid = (rawSt === 'PAID' || rawSt === 'SUCCESS' || rawSt === 'SETTLEMENT' || rawSt === 'COMPLETED');
                return res.json({ success: true, status: isPaid ? 'settlement' : 'pending' });
            }
        }

        // 4. Cek Manual via DOKU
        else if (gateway === 'doku') {
            if (!key1 || !key2) return res.json({ success: false, status: 'not_found' });
            
            const isProd = !key2.startsWith('SB-'); 
            const cleanClientId = key2.replace('SB-', '');
            const dokuBaseUrl = isProd ? 'https://api.doku.com' : 'https://api-sandbox.doku.com';

            const timestamp = new Date().toISOString().slice(0, 19) + 'Z';
            const requestId = 'req-chk-' + Date.now();
            const targetPath = `/orders/v1/status/${orderId}`;

            // Untuk method GET di DOKU, Digest tidak perlu dimasukkan ke dalam komponen tanda tangan
            const sigComponent = `Client-Id:${cleanClientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${timestamp}\nRequest-Target:${targetPath}`;
            const signatureDoku = 'HMACSHA256=' + crypto.createHmac('sha256', key1).update(sigComponent).digest('base64');

            const dokuRes = await fetch(dokuBaseUrl + targetPath, {
                method: 'GET',
                headers: {
                    'Client-Id': cleanClientId, 'Request-Id': requestId, 'Request-Timestamp': timestamp, 'Signature': signatureDoku
                }
            });
            
            const dokuData = await dokuRes.json().catch(() => ({}));
          const trxStatus = (dokuData?.transaction?.status || dokuData?.order?.status || '').toString().toUpperCase();
         if (dokuRes.ok && (trxStatus === 'SUCCESS' || trxStatus === 'PAID' || trxStatus === 'SETTLEMENT')) {
              markDiscountUsedIfPending(orderId);
              return res.json({ success: true, status: 'settlement' });
          }
          return res.json({ success: true, status: 'pending' });
        }
        
        
   // 6. Cek Manual via Xendit (Rencana Cadangan)
        else if (gateway === 'xendit') {
            if (!key1) return res.json({ success: false, status: 'not_found' });
            const authHeader = 'Basic ' + Buffer.from(key1 + ':').toString('base64');
            // Mencari transaksi berdasarkan ID Eksternal / Order ID
            const xenRes = await fetch(`https://api.xendit.co/qr_codes?external_id=${orderId}`, {
                method: 'GET',
                headers: { 'Authorization': authHeader }
            });
            const xenData = await xenRes.json();
            if (xenRes.ok && xenData.data && xenData.data.length > 0) {
                // Xendit mengembalikan array, kita cek status elemen pertamanya
                const isPaid = (xenData.data[0].status === 'COMPLETED' || xenData.data[0].status === 'PAID');
                return res.json({ success: true, status: isPaid ? 'settlement' : 'pending' });
            }
            return res.json({ success: true, status: 'pending' });
        }

        // Jika Gateway tidak dikenali, kembalikan pending
        return res.json({ success: true, status: 'pending' });
        
    } catch (error) {
        console.error("Gagal cek status manual:", error.message);
        res.json({ success: false, status: 'not_found' });
    }
});
// =======================================================
// 🌐 [OTOMASI PENUH] CLOUDFLARE TUNNEL (ZERO-CONFIG OTOMATIS)
// =======================================================
let cfTunnelProcess = null;
let isIntentionalRestart = false;
global.publicTunnelUrl = ""; 

function startCloudflareTunnel() {
    try {
        const cloudflaredPath = path.join(__dirname, 'cloudflared.exe').replace('app.asar', 'app.asar.unpacked');
        if (!fs.existsSync(cloudflaredPath)) {
            console.log("⚠️ [CLOUDFLARE] File cloudflared.exe tidak ditemukan.");
            return;
        }

        isIntentionalRestart = true;
        if (cfTunnelProcess) {
            cfTunnelProcess.removeAllListeners('close');
            cfTunnelProcess.kill();
        }
        
        exec('taskkill /f /im cloudflared.exe', () => {
            isIntentionalRestart = false;
            global.publicTunnelUrl = "";

            // SELALU GUNAKAN QUICK TUNNEL OTOMATIS AGAR SETIAP PC KLIEN LANGSUNG DAPAT URL WEBHOOK TANPA TOKEN!
            const args = ['tunnel', '--no-autoupdate', '--url', 'http://localhost:3000'];

            console.log("🌐 [CLOUDFLARE] Membuat URL Webhook Publik Otomatis (Zero-Config)...");
            cfTunnelProcess = spawn(cloudflaredPath, args);

            const extractTunnelUrl = (text) => {
                const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                if (match && match[0]) {
                    global.publicTunnelUrl = match[0].trim();
                    console.log(`✅ [WEBHOOK SIAP] URL Publik Otomatis: ${global.publicTunnelUrl}/api/payment/universal-webhook`);
                }
            };

            cfTunnelProcess.stdout.on('data', (d) => extractTunnelUrl(d.toString()));
            cfTunnelProcess.stderr.on('data', (d) => extractTunnelUrl(d.toString()));

            cfTunnelProcess.on('close', () => {
                if (!isIntentionalRestart) setTimeout(startCloudflareTunnel, 10000);
            });
        });
    } catch (e) {
        console.error("❌ Error Cloudflare Tunnel:", e.message);
    }
}

expressApp.get('/api/tunnel-info', (req, res) => {
    res.json({
        success: true,
        baseUrl: global.publicTunnelUrl || "",
        webhookUrl: global.publicTunnelUrl ? `${global.publicTunnelUrl}/api/payment/universal-webhook` : ""
    });
});

startCloudflareTunnel();

// Pastikan Cloudflare mati saat aplikasi ditutup
process.on('exit', () => {
    if (cfTunnelProcess) cfTunnelProcess.kill();
    exec('taskkill /f /im cloudflared.exe', () => {});
});
// =======================================================
// API MATIKAN SISTEM DARI UI (FORCE QUIT)
// =======================================================
expressApp.post('/api/shutdown-system', (req, res) => {
    res.json({ success: true, message: "Mematikan sistem..." });
    
    setTimeout(() => {
        console.log("🛑 Mematikan sistem secara paksa...");
        
        // Coba bersihkan background (jika nyangkut, akan dilewati)
        try { 
            if (typeof matikanSistem === 'function') matikanSistem(); 
        } catch(e) {}
        
        // JURUS PAMUNGKAS: Langsung bunuh proses Node.js & Electron!
        setTimeout(() => {
            const { app } = require('electron');
            app.exit(0); // Paksa tutup jendela Windows tanpa basa-basi
            process.exit(0); // Bunuh proses backend di RAM
        }, 1000);
        
    }, 500);
});
// =======================================================
// 🛡️ [POIN 1, 2, & 4 PROFESIONAL] HARDWARE WATCHDOG & MJPEG STREAM
// =======================================================

// 1. Endpoint MJPEG Streaming Murni (Untuk Live View Super Mulus Tanpa Delay)
expressApp.get('/liveview-stream.mjpg', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache'
    });
    const streamTimer = setInterval(() => {
        if (latestLvBuffer) {
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestLvBuffer.length}\r\n\r\n`);
            res.write(latestLvBuffer);
            res.write('\r\n');
        }
    }, 45);
    req.on('close', () => clearInterval(streamTimer));
});

// 2. Watchdog Otomatis Kamera Canon (Cek & Sambung Ulang Otomatis jika Kabel Tersenggol / Baterai Diganti)
let isWatchdogBusy = false;
setInterval(() => {
    if (isWatchdogBusy) return;
    isWatchdogBusy = true;
    try {
        const cfg = safeReadJson(settingsPath, {});
        const engine = cfg?.global?.cameraEngine || 'canon';

        if (engine === 'canon') {
            if (!activeCamera) {
                // Coba deteksi kamera secara hening di latar belakang
                let camList = [null];
                if (isEdsdkInitialized && EdsGetCameraList(camList) === 0) {
                    let cnt = [0];
                    EdsGetChildCount(camList[0], cnt);
                    EdsRelease(camList[0]);
                    if (cnt[0] > 0) {
                        console.log("🔌 [WATCHDOG] Kamera Canon terdeteksi menyala kembali! Menyambungkan otomatis...");
                        hubungkanKamera();
                        io.emit('camera-watchdog-status', { connected: true });
                    } else {
                        io.emit('camera-watchdog-status', { connected: false });
                    }
                }
            } else {
                // Tes apakah kamera yang sedang aktif masih merespons atau sudah mati
                let testBuf = Buffer.alloc(4);
                let err = EdsGetPropertyData(activeCamera, 0x00000402, 0, 4, testBuf);
                if (err !== 0 && err !== 0x00008d01) { // Jika komunikasi USB terputus
                    console.warn("⚠️ [WATCHDOG] Koneksi kamera Canon terputus! Menyiapkan auto-reconnect...");
                    activeCamera = null;
                    if (lvInterval) { clearInterval(lvInterval); lvInterval = null; }
                    io.emit('camera-watchdog-status', { connected: false });
                } else {
                    io.emit('camera-watchdog-status', { connected: true });
                }
            }
        }
    } catch (e) {}
    isWatchdogBusy = false;
}, 4000);
// =======================================================
// 12. AKTIVASI EXPRESS SERVER LOKAL (PORT 3000)
// =======================================================
server.listen(3000, '0.0.0.0', () => {
    console.log("🚀 Server Photobooth Lacasaphoto siap dieksekusi di Port 3000!");
});
process.on('uncaughtException', (err) => console.error('❌ Uncaught Exception:', err.message));