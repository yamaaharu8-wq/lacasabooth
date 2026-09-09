const frameLoader = require('../services/frameLoader');
const renderService = require('../services/renderService');
const fs = require('fs');
const path = require('path');

exports.getFrames = (req, res) => {
    try {
        const frames = frameLoader.getAvailableFrames();
        res.status(200).json({ success: true, data: frames });
    } catch (error) {
        res.status(500).json({ success: false, message: "Gagal mengambil data frame." });
    }
};

exports.getFrameDetail = (req, res) => {
    try {
        const frameId = req.params.id;
        const frame = frameLoader.getFrameById(frameId);
        if (!frame) return res.status(404).json({ success: false, message: "Frame tidak ditemukan." });
        res.status(200).json({ success: true, data: frame });
    } catch (error) {
        res.status(500).json({ success: false, message: "Gagal memproses permintaan." });
    }
};

exports.renderCollage = async (req, res) => {
    try {
        const { frameId } = req.body;
        const config = frameLoader.getFrameById(frameId);
        
        if (!config) return res.status(404).json({ success: false, message: "Frame config tidak ditemukan." });

        const files = fs.readdirSync(path.join(__dirname, '../../uploads'))
                        .filter(f => f.startsWith('foto_'))
                        .sort((a, b) => b.localeCompare(a)) 
                        .slice(0, config.requiredPhotos)
                        .map(f => path.join(__dirname, '../../uploads', f));

        // Pastikan jumlah foto cukup sebelum render
        if (files.length < config.requiredPhotos) {
            return res.status(400).json({ success: false, message: "Jumlah foto tidak mencukupi untuk frame ini." });
        }

        const resultPath = await renderService.processCollage(config, files);
        res.status(200).json({ success: true, path: '/uploads/final_collage.jpg' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
// Pastikan kode ini benar-benar ada di file collageController.js Anda
exports.printCollage = (req, res) => {
    const finalPath = path.join(__dirname, '../../uploads/final_collage.jpg');
    console.log("🖨️ User memencet tombol print...");
    
    exec(`mspaint /p "${finalPath}"`, (err) => {
        if (err) {
            console.error("❌ Gagal print:", err);
            return res.status(500).json({ success: false, message: "Gagal mencetak" });
        }
        res.status(200).json({ success: true, message: "Berhasil mencetak" });
    });
};