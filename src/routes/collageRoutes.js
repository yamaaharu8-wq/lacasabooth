const express = require('express');
const router = express.Router();
const collageController = require('../controllers/collageController'); 
const { uploadToDrive } = require('../../drive_service');
// 1. Ambil daftar frame
router.get('/frames', collageController.getFrames);

// 2. Ambil detail 1 frame
router.get('/frames/:id', collageController.getFrameDetail);

// 3. Render kolase
router.post('/render', collageController.renderCollage);

// 4. Print otomatis
router.post('/print', collageController.printCollage);

// BARI INI SANGAT PENTING: Harus ada di paling bawah agar server.js bisa membacanya
module.exports = router;