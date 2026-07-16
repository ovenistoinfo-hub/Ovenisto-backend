import 'dotenv/config';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { socketAuth } from '../socketAuth.js';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/database.js';
import type { Socket } from 'socket.io';

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
  },
}));

vi.mock('../../config/database.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

describe('socketAuth middleware', () => {
  let mockSocket: any;
  let mockNext: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSocket = {
      handshake: {
        auth: {
          token: 'mock-token',
        },
      },
      data: {},
      join: vi.fn(),
    };
    mockNext = vi.fn();
  });

  it('fails if no token is provided', async () => {
    mockSocket.handshake.auth.token = undefined;

    await socketAuth(mockSocket as unknown as Socket, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    expect(mockNext.mock.calls[0][0].message).toBe('No token provided');
    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('fails if JWT verification throws', async () => {
    vi.mocked(jwt.verify).mockImplementationOnce(() => {
      throw new Error('invalid signature');
    });

    await socketAuth(mockSocket as unknown as Socket, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    expect(mockNext.mock.calls[0][0].message).toBe('Invalid or expired token');
    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('fails if user is not found in database', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ userId: 'u1' } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as any);

    await socketAuth(mockSocket as unknown as Socket, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    expect(mockNext.mock.calls[0][0].message).toBe('User not found');
    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('fails if user status is not active', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ userId: 'u1' } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      role: 'MANAGER',
      outletId: 'o1',
      status: 'deactivated',
    } as any);

    await socketAuth(mockSocket as unknown as Socket, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    expect(mockNext.mock.calls[0][0].message).toBe('Account is deactivated');
    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('authenticates Super Admin, maps role, joins super-admin room', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ userId: 'u1' } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      role: 'SUPER_ADMIN',
      outletId: null,
      status: 'active',
    } as any);

    await socketAuth(mockSocket as unknown as Socket, mockNext);

    expect(mockNext).toHaveBeenCalledWith();
    expect(mockSocket.data).toEqual({
      userId: 'u1',
      role: 'Super Admin',
      outletId: null,
    });
    expect(mockSocket.join).toHaveBeenCalledWith('super-admin');
    expect(mockSocket.join).toHaveBeenCalledTimes(1);
  });

  it('authenticates normal user (e.g. Cashier), maps role, joins outlet:<id> room', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ userId: 'u2' } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u2',
      role: 'CASHIER',
      outletId: 'out-123',
      status: 'active',
    } as any);

    await socketAuth(mockSocket as unknown as Socket, mockNext);

    expect(mockNext).toHaveBeenCalledWith();
    expect(mockSocket.data).toEqual({
      userId: 'u2',
      role: 'Cashier',
      outletId: 'out-123',
    });
    expect(mockSocket.join).toHaveBeenCalledWith('outlet:out-123');
    expect(mockSocket.join).toHaveBeenCalledTimes(1);
  });

  it('authenticates user with no outletId, maps role, does not join any room', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ userId: 'u3' } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u3',
      role: 'MANAGER',
      outletId: null,
      status: 'active',
    } as any);

    await socketAuth(mockSocket as unknown as Socket, mockNext);

    expect(mockNext).toHaveBeenCalledWith();
    expect(mockSocket.data).toEqual({
      userId: 'u3',
      role: 'Manager',
      outletId: null,
    });
    expect(mockSocket.join).not.toHaveBeenCalled();
  });
});
