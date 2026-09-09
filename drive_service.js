const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

async function uploadToDrive(filePath, folderName, parentId) {
    console.log(`\n[DRIVE-DEBUG] Memulai proses upload...`);
    console.log(`[DRIVE-DEBUG] File Target: ${filePath}`);
    console.log(`[DRIVE-DEBUG] Nama Folder Sesi: ${folderName}`);
    console.log(`[DRIVE-DEBUG] ID Folder Utama (Parent): "${parentId}"`);

    // Validasi super ketat untuk Parent ID
    if (!parentId || parentId.trim() === "" || parentId === ".") {
        throw new Error("ID Folder Utama tidak valid atau hanya berisi titik.");
    }
    parentId = parentId.split('?')[0];
    const credPath = path.join(__dirname, 'oauth_credentials.json');
    const tokenPath = path.join(__dirname, 'token.json');

    if (!fs.existsSync(credPath) || !fs.existsSync(tokenPath)) {
        throw new Error("File Kredensial (oauth_credentials.json) atau Token (token.json) tidak ditemukan di folder.");
    }

    try {
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const keys = creds.installed || creds.web;
        const oauth2Client = new google.auth.OAuth2(keys.client_id, keys.client_secret, keys.redirect_uris[0]);
        oauth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        let targetFolderId = null;
        let folderLink = null;

        console.log(`[DRIVE-DEBUG] Mencari folder "${folderName}" di dalam ID "${parentId}"...`);
        const res = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed=false`,
            fields: 'files(id, webViewLink)',
            spaces: 'drive'
        });

        if (res.data.files.length > 0) {
            targetFolderId = res.data.files[0].id;
            folderLink = res.data.files[0].webViewLink;
            console.log(`[DRIVE-DEBUG] Folder sudah ada! Menggunakan ID: ${targetFolderId}`);
        } else {
            console.log(`[DRIVE-DEBUG] Folder belum ada. Membuat folder baru...`);
            const folder = await drive.files.create({
                resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
                fields: 'id, webViewLink'
            });
            targetFolderId = folder.data.id;
            folderLink = folder.data.webViewLink;
            
            await drive.permissions.create({ fileId: targetFolderId, requestBody: { role: 'reader', type: 'anyone' } });
            console.log(`[DRIVE-DEBUG] Folder berhasil dibuat dan dibuka aksesnya.`);
        }

        console.log(`[DRIVE-DEBUG] Mengunggah file ke Google Drive...`);
        const fileName = path.basename(filePath);
        await drive.files.create({
            resource: { name: fileName, parents: [targetFolderId] },
            media: { mimeType: 'image/jpeg', body: fs.createReadStream(filePath) },
            fields: 'id'
        });

        return folderLink; 
    } catch (error) {
        // Tangkap error langsung dari Google API agar pesannya lebih rinci
        console.error(`\n[DRIVE-ERROR-DETAIL] Terjadi kesalahan fatal:`, error.message);
        throw error;
    }
}

module.exports = { uploadToDrive };