import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSendEachForMulticast, mockFindMany, mockDeleteMany } = vi.hoisted(() => ({
  mockSendEachForMulticast: vi.fn(),
  mockFindMany: vi.fn(),
  mockDeleteMany: vi.fn(),
}));

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => ({
    sendEachForMulticast: mockSendEachForMulticast,
  })),
}));

vi.mock('../../../config/database.js', () => ({
  prisma: {
    deviceToken: {
      findMany: mockFindMany,
      deleteMany: mockDeleteMany,
    },
  },
}));

// Import after vi.mock
import { sendPushToUser } from '../push.service.js';

describe('sendPushToUser', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      FIREBASE_PROJECT_ID: 'test-project',
      FIREBASE_CLIENT_EMAIL: 'test@project.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\\n-----END PRIVATE KEY-----\\n',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('no-ops when user has no registered device tokens', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    await expect(
      sendPushToUser('user-no-tokens', { title: 'Order Ready', body: 'Your order is ready' })
    ).resolves.toBeUndefined();

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-no-tokens' },
      select: { token: true },
    });
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('sends push to all user tokens when tokens exist and all succeed', async () => {
    mockFindMany.mockResolvedValueOnce([{ token: 'token-1' }, { token: 'token-2' }]);
    mockSendEachForMulticast.mockResolvedValueOnce({
      responses: [{ success: true }, { success: true }],
      successCount: 2,
      failureCount: 0,
    });

    await expect(
      sendPushToUser('user-1', {
        title: 'New Delivery Assigned',
        body: 'Order ORD-001 has been assigned',
        data: { orderId: 'ord-1', assignmentId: 'asg-1' },
      })
    ).resolves.toBeUndefined();

    expect(mockSendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['token-1', 'token-2'],
      notification: {
        title: 'New Delivery Assigned',
        body: 'Order ORD-001 has been assigned',
      },
      data: {
        orderId: 'ord-1',
        assignmentId: 'asg-1',
      },
    });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('self-cleans stale tokens on messaging/registration-token-not-registered and messaging/invalid-registration-token', async () => {
    mockFindMany.mockResolvedValueOnce([
      { token: 'valid-token' },
      { token: 'not-registered-token' },
      { token: 'invalid-token' },
      { token: 'server-error-token' },
    ]);

    mockSendEachForMulticast.mockResolvedValueOnce({
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'Not registered' } },
        { success: false, error: { code: 'messaging/invalid-registration-token', message: 'Invalid token' } },
        { success: false, error: { code: 'messaging/internal-error', message: 'Internal error' } },
      ],
      successCount: 1,
      failureCount: 3,
    });

    await expect(
      sendPushToUser('user-1', { title: 'Order Ready', body: 'Ready' })
    ).resolves.toBeUndefined();

    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        token: {
          in: ['not-registered-token', 'invalid-token'],
        },
      },
    });
  });

  it('never throws even if admin.messaging().sendEachForMulticast rejects', async () => {
    mockFindMany.mockResolvedValueOnce([{ token: 'failing-token' }]);
    mockSendEachForMulticast.mockRejectedValueOnce(new Error('Firebase service unavailable'));

    await expect(
      sendPushToUser('user-1', { title: 'Order Ready', body: 'Ready' })
    ).resolves.toBeUndefined();

    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('converts non-string data values to strings', async () => {
    mockFindMany.mockResolvedValueOnce([{ token: 'token-1' }]);
    mockSendEachForMulticast.mockResolvedValueOnce({
      responses: [{ success: true }],
    });

    await sendPushToUser('user-1', {
      title: 'Test',
      body: 'Test Body',
      data: { count: 42 as any, active: true as any },
    });

    expect(mockSendEachForMulticast).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          count: '42',
          active: 'true',
        },
      })
    );
  });
});
