const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Fungsi cerdas: Jika klien menempelkan URL lengkap Google Drive, ambil hanya ID foldernya saja!
function cleanDriveFolderId(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return "";
    let str = rawInput.trim();
    const matchFolder = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (matchFolder && matchFolder[1]) return matchFolder[1];
    const matchId = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (matchId && matchId[1]) return matchId[1];
    return str.split('?')[0].split('/')[0].trim();
}

async function uploadToDrive(filePath, folderName, rawParentId) {
    const parentId = cleanDriveFolderId(rawParentId);
    console.log(`\n[DRIVE] Memulai upload: ${path.basename(filePath)}`);
    console.log(`[DRIVE] Sub-Folder: ${folderName || '(LANGSUNG KE FOLDER UTAMA / CAMPUR)'} | Parent ID: "${parentId}"`);

    if (!parentId || parentId === ".") {
        throw new Error("ID Folder Google Drive kosong atau tidak valid.");
    }

    const userDataPath = app.getPath('userData');
    const credPath = path.join(userDataPath, 'oauth_credentials.json');
    const tokenPath = path.join(userDataPath, 'token.json');

    if (!fs.existsSync(credPath) || !fs.existsSync(tokenPath)) {
        throw new Error("Kredensial atau Token Google Drive belum login di Dashboard.");
    }

    try {
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const keys = creds.installed || creds.web;
        const redirectUri = (keys.redirect_uris && keys.redirect_uris[0]) ? keys.redirect_uris[0] : 'http://localhost:3000/api/auth-google-callback';
        const oauth2Client = new google.auth.OAuth2(keys.client_id, keys.client_secret, redirectUri);
        oauth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        let targetFolderId = parentId;
        let folderLink = `https://drive.google.com/drive/folders/${parentId}`;

        // JIKA MODE PER SESI (folderName ada isinya): Cari atau buat sub-folder
        // JIKA MODE 1 FOLDER CAMPUR (folderName === null / kosong): Langsung gunakan parentId!
        if (folderName && typeof folderName === 'string' && folderName.trim() !== "" && folderName !== '__DIRECT_ROOT__') {
            const safeName = folderName.trim().replace(/'/g, "\\'");
            const res = await drive.files.list({
                q: `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and '${parentId}' in parents and trashed=false`,
                fields: 'files(id, webViewLink)',
                spaces: 'drive'
            });

            if (res.data.files && res.data.files.length > 0) {
                targetFolderId = res.data.files[0].id;
                folderLink = res.data.files[0].webViewLink || `https://drive.google.com/drive/folders/${targetFolderId}`;
            } else {
                const folder = await drive.files.create({
                    requestBody: {
                        name: folderName.trim(),
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [parentId]
                    },
                    fields: 'id, webViewLink'
                });
                targetFolderId = folder.data.id;
                folderLink = folder.data.webViewLink || `https://drive.google.com/drive/folders/${targetFolderId}`;

                // Bungkus dengan try-catch agar jika mewarisi izin dari parent, tidak pernah menggagalkan upload file!
                try {
                    await drive.permissions.create({
                        fileId: targetFolderId,
                        requestBody: { role: 'reader', type: 'anyone' }
                    });
                } catch (permErr) {
                    console.log(`[DRIVE] Sub-folder otomatis mewarisi izin akses dari folder utama.`);
                }
            }
        }

        const fileName = path.basename(filePath);
        let fileMimeType = 'image/jpeg';
        if (fileName.toLowerCase().endsWith('.gif')) fileMimeType = 'image/gif';
        else if (fileName.toLowerCase().endsWith('.mp4')) fileMimeType = 'video/mp4';
        else if (fileName.toLowerCase().endsWith('.png')) fileMimeType = 'image/png';

        await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [targetFolderId]
            },
            media: {
                mimeType: fileMimeType,
                body: fs.createReadStream(filePath)
            },
            fields: 'id'
        });

        console.log(`✅ [DRIVE SUKSES] Terupload: ${fileName} -> ${folderLink}`);
        return folderLink;
    } catch (error) {
        console.error(`❌ [DRIVE ERROR] Gagal upload ${path.basename(filePath)}:`, error.message);
        throw error;
    }
}

module.exports = { uploadToDrive };