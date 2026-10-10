import type { Request, Response, NextFunction } from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { parseBearerToken } from './website.helpers.js';

// Website customers sign in with Firebase Auth (project "ovenisto-rider", the rider app's). Checking an
// ID token needs only the project id (Google's public keys), not push.service's service account, so it
// gets its own named app and works even where the push credentials aren't set.
const APP_NAME = 'website-customers';

function customerAuth() {
  const app = getApps().find((a) => a.name === APP_NAME)
    ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'ovenisto-rider' }, APP_NAME);
  return getAuth(app);
}

/** Requires a signed-in website customer; their Firebase uid goes on `res.locals.customerUid`. */
export const requireWebsiteCustomer = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) throw ApiError.unauthorized('Please sign in to continue');
  try {
    res.locals.customerUid = (await customerAuth().verifyIdToken(token)).uid;
  } catch {
    throw ApiError.unauthorized('Your sign-in has expired. Please sign in again.');
  }
  next();
});
