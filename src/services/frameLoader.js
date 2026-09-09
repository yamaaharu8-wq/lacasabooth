const fs = require('fs').promises;
const path = require('path');

class FrameLoader {
    constructor() {
    this.framesCache = [];
    // Ganti dengan path lengkap di komputer Anda
    this.framesDirectory = 'C:\\Users\\Admin\\Documents\\La_Project\\server\\frames\\collage';
    this.isLoaded = false;
}

    // Memuat seluruh file JSON di folder saat server pertama kali hidup
    async loadFrames() {
    try {
        console.log("📂 [COLLAGE] Memulai proses load...");
        const files = await fs.readdir(this.framesDirectory);
        const jsonFiles = files.filter(file => file.endsWith('.json'));

        // Reset cache
        this.framesCache = []; 
        
        for (const file of jsonFiles) {
            const filePath = path.join(this.framesDirectory, file);
            const fileData = await fs.readFile(filePath, 'utf-8');
            const parsedData = JSON.parse(fileData);
            
            // PENTING: Masukkan ke array
            this.framesCache.push(parsedData);
            console.log(`✅ [COLLAGE] Berhasil memuat frame: ${parsedData.id}`);
        }

        this.isLoaded = true;
        console.log("📊 Total frame di memori:", this.framesCache.length);
    } catch (error) {
        console.error("❌ [COLLAGE] Error saat load frame:", error);
    }
}

    // Mengambil data frame instan dari RAM (O(1) complexity, sangat cepat)
    getAvailableFrames() {
        if (!this.isLoaded) {
            console.warn("⚠️ [COLLAGE] Peringatan: Frame belum selesai dimuat ke memori.");
        }
        return this.framesCache;
    }

    // Mengambil detail satu frame secara spesifik
    getFrameById(id) {
        return this.framesCache.find(frame => frame.id === id) || null;
    }
}

// Mengekspor sebagai Singleton (hanya satu instansiasi di seluruh aplikasi)
module.exports = new FrameLoader();