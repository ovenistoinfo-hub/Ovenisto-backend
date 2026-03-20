/**
 * Upload Controller
 * Handles image uploads to Cloudinary
 */

import type { Request, Response } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { env } from '../../config/env.js';

// Configure Cloudinary once
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

/**
 * POST /api/upload/image
 * Accepts multipart/form-data with field "image"
 * Returns { url, publicId }
 */
export const uploadImage = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    throw ApiError.badRequest('No image file provided');
  }

  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw ApiError.internal('Cloudinary is not configured');
  }

  // Upload buffer to Cloudinary
  const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'ovenisto/menu',
        transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }],
      },
      (error, result) => {
        if (error || !result) return reject(error || new Error('Upload failed'));
        resolve({ secure_url: result.secure_url, public_id: result.public_id });
      }
    );
    stream.end(req.file!.buffer);
  });

  res.status(201).json(
    ApiResponse.success({ url: result.secure_url, publicId: result.public_id }, 'Image uploaded successfully')
  );
});

/**
 * DELETE /api/upload/image
 * Body: { publicId: string }
 */
export const deleteImage = asyncHandler(async (req: Request, res: Response) => {
  const { publicId } = req.body;
  if (!publicId) throw ApiError.badRequest('publicId is required');

  await cloudinary.uploader.destroy(publicId);
  res.json(ApiResponse.success(null, 'Image deleted'));
});
