/**
 * Push Notification Service
 * Best-effort Firebase Cloud Messaging (FCM) sender with self-cleaning stale token removal.
 */

import { App, initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging, MulticastMessage, SendResponse } from 'firebase-admin/messaging';
import { prisma } from '../../config/database.js';

let firebaseInitialized = false;
let firebaseApp: App | null = null;
let hasLoggedConfigWarning = false;

/**
 * Lazily initialize the firebase-admin app on first use (module-level singleton).
 * Fails soft if env vars are missing or invalid, returning null.
 */
function getFirebaseApp(): App | null {
  if (firebaseInitialized) {
    return firebaseApp;
  }

  firebaseInitialized = true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    if (!hasLoggedConfigWarning) {
      hasLoggedConfigWarning = true;
      console.warn(
        '[Push] Firebase credentials not configured (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY missing). Push notifications disabled.'
      );
    }
    return null;
  }

  try {
    // Unescape literal \n sequences to real newlines
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }

    // Reuse default app if already initialized (e.g. in hot-reloading or tests)
    const existingApps = getApps();
    if (existingApps.length > 0 && existingApps[0]) {
      firebaseApp = existingApps[0];
    } else {
      firebaseApp = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }
    return firebaseApp;
  } catch (err: any) {
    if (!hasLoggedConfigWarning) {
      hasLoggedConfigWarning = true;
      // Do not log private key or client email
      console.warn('[Push] Failed to initialize Firebase Admin app:', err?.message || err);
    }
    return null;
  }
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Send a push notification to all active devices registered to a specific user.
 * Best-effort and non-throwing: never fails the caller, self-cleans stale tokens.
 */
export async function sendPushToUser(
  userId: string,
  notification: PushNotificationPayload
): Promise<void> {
  try {
    const app = getFirebaseApp();
    if (!app) return;

    const deviceTokens = await prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });

    if (deviceTokens.length === 0) return;

    const tokens = deviceTokens.map((t) => t.token);

    // Ensure all data values are strings
    const sanitizedData: Record<string, string> | undefined = notification.data
      ? Object.fromEntries(
          Object.entries(notification.data).map(([k, v]) => [k, v == null ? '' : String(v)])
        )
      : undefined;

    const multicastMessage: MulticastMessage = {
      tokens,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: sanitizedData,
    };

    const messaging = getMessaging(app);
    const response = await messaging.sendEachForMulticast(multicastMessage);

    // Self-cleaning: delete tokens that failed with stale/invalid token error codes
    const staleTokens: string[] = [];
    response.responses.forEach((res: SendResponse, index: number) => {
      if (!res.success && res.error) {
        const code = res.error.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          staleTokens.push(tokens[index]);
        }
      }
    });

    if (staleTokens.length > 0) {
      await prisma.deviceToken.deleteMany({
        where: { token: { in: staleTokens } },
      });
    }
  } catch (err: any) {
    // Non-blocking side effect: log error without exposing credentials
    console.error('[Push] Error sending push notification:', err?.message || err);
  }
}
