/**
 * Upload Routes
 * Image upload via Cloudinary
 */

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { uploadImage, deleteImage } from './upload.controller.js';

const router = Router();

// Multer: store in memory (buffer), 5MB max, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

router.post('/image', authenticate, upload.single('image'), uploadImage);
router.delete('/image', authenticate, deleteImage);

export default router;
