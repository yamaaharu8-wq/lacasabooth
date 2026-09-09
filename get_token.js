const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

// Pastikan file ini bernama persis seperti yang didownload
const CREDENTIALS_PATH = 'oauth_credentials.json';
const TOKEN_PATH = 'token.json';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

fs.readFile(CREDENTIALS_PATH, (err, content) => {
  if (err) return console.log('Error loading client secret file:', err);
  authorize(JSON.parse(content), getAccessToken);
});

function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed || credentials.web;
  // Jika redirect_uris tidak ada, gunakan localhost
  const redirectUri = (redirect_uris && redirect_uris.length > 0) ? redirect_uris[0] : 'http://localhost';
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  callback(oAuth2Client);
}

function getAccessToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('\n======================================================');
  console.log('Kunjungi URL ini di browser Anda untuk memberi izin:');
  console.log('👉', authUrl);
  console.log('======================================================\n');
  
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Setelah login, Anda akan dialihkan ke halaman "localhost" yang error.\nCopy seluruh URL di address bar browser Anda, dan Paste ke sini:\n> ', (urlBalasan) => {
    rl.close();
    
    // Ambil kode dari URL
    try {
        const urlParams = new URL(urlBalasan);
        const code = urlParams.searchParams.get('code');
        
        if (!code) throw new Error("Kode tidak ditemukan di URL");

        oAuth2Client.getToken(code, (err, token) => {
        if (err) return console.error('Error saat mengambil token', err);
        fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
            if (err) return console.error(err);
            console.log('\n✅ BERHASIL! File token.json telah dibuat di folder Anda.');
            console.log('Sekarang sistem GDrive Anda sudah siap digunakan!');
        });
        });
    } catch (e) {
        console.log("❌ Format URL salah. Pastikan meng-copy seluruh URL yang berawal dari http://localhost...");
    }
  });
}