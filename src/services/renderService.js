const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');

class RenderService {
    async processCollage(frameConfig, capturedPhotos) {
        // 1. Buat kanvas kosong sesuai ukuran frame JSON
        let baseCanvas = sharp({
            create: {
                width: frameConfig.canvas.width,
                height: frameConfig.canvas.height,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        });

        // 2. Siapkan komposit foto-foto
        const compositeOperations = [];

        for (let i = 0; i < capturedPhotos.length; i++) {
            const slot = frameConfig.slots[i];
            const photoPath = capturedPhotos[i];

            const resizedPhoto = await sharp(photoPath)
                .resize(slot.width, slot.height, { fit: 'cover', position: 'center' })
                .toBuffer();

            compositeOperations.push({
                input: resizedPhoto,
                top: slot.y,
                left: slot.x
            });
        }

        // 3. Gabungkan foto ke kanvas, lalu tempel frame
        const finalPath = path.join(__dirname, '../../uploads/final_collage.jpg');
        
        await baseCanvas
            .composite(compositeOperations)
            .composite([{ input: path.join(__dirname, `../../frames/collage/${frameConfig.id}.png`) }])
            .jpeg({ quality: 90 })
            .toFile(finalPath);

        // 4. Perintah cetak
        console.log("🖨️ Mengirim ke printer...");
        exec(`mspaint /p "${finalPath}"`, (err) => {
            if (err) console.error("❌ Gagal print:", err);
            else console.log("✅ Print berhasil dikirim!");
        });

        //return finalPath;
    }
}

module.exports = new RenderService();