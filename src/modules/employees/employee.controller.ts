/**
 * Employee Controller
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

const supervisorSelect = { id: true, firstName: true, lastName: true };
const userSelect = { id: true, name: true, email: true };

function mapEmployee(e: any) {
  return {
    ...e,
    rate: Number(e.rate),
    penaltyFee: e.penaltyFee != null ? Number(e.penaltyFee) : null,
  };
}

export const getEmployees = asyncHandler(async (req: Request, res: Response) => {
  const { page = '1', limit = '20', search, status } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { designation: { contains: search, mode: 'insensitive' } },
      { division: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { firstName: 'asc' },
      include: { supervisor: { select: supervisorSelect }, user: { select: userSelect } },
    }),
    prisma.employee.count({ where }),
  ]);

  return res.json(ApiResponse.paginated(data.map(mapEmployee), Number(page), Number(limit), total));
});

export const getEmployee = asyncHandler(async (req: Request, res: Response) => {
  const e = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: { supervisor: { select: supervisorSelect }, user: { select: userSelect } },
  });
  if (!e) throw new ApiError('Employee not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && e.outletId !== scope) throw new ApiError('Employee not found', 404);
  return res.json(ApiResponse.success(mapEmployee(e)));
});

export const getMyEmployee = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user?.id) throw new ApiError('Not authenticated', 401);
  const e = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  return res.json(ApiResponse.success(e ? mapEmployee(e) : null));
});

export const getSupervisorOptions = asyncHandler(async (req: Request, res: Response) => {
  const where: any = { status: 'active' };
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
  const excludeId = req.query.excludeId as string | undefined;
  if (excludeId) where.id = { not: excludeId };

  const data = await prisma.employee.findMany({
    where,
    select: { id: true, firstName: true, lastName: true },
    orderBy: { firstName: 'asc' },
  });
  return res.json(ApiResponse.success(data));
});

const REQUIRED_FIELDS = ['firstName', 'phone', 'designation', 'hireDate', 'rateType', 'rate'] as const;
const RATE_TYPES = ['Hourly', 'Daily', 'Monthly', 'PerShift'];

function validateBody(body: any) {
  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new ApiError(`${field} is required`, 400);
    }
  }
  if (!RATE_TYPES.includes(body.rateType)) {
    throw new ApiError(`rateType must be one of: ${RATE_TYPES.join(', ')}`, 400);
  }
}

export const createEmployee = asyncHandler(async (req: Request, res: Response) => {
  validateBody(req.body);
  const {
    firstName, lastName, email, phone, photoUrl, userId, supervisorId,
    division, designation, dutyType, hireDate, rateType, rate, payFrequency, penaltyFee,
    dateOfBirth, gender, maritalStatus, cnic,
    emergencyContactName, emergencyContactRelation, emergencyContactPhone,
  } = req.body;

  const outletId = resolveCreateOutlet(req);

  if (supervisorId) {
    const supervisor = await prisma.employee.findUnique({ where: { id: supervisorId } });
    if (!supervisor || supervisor.outletId !== outletId) {
      throw new ApiError('Supervisor not found', 400);
    }
  }

  try {
    const e = await prisma.employee.create({
      data: {
        firstName, lastName: lastName || null, email: email || null, phone,
        photoUrl: photoUrl || null,
        userId: userId || null,
        supervisorId: supervisorId || null,
        outletId,
        division: division || null,
        designation,
        dutyType: dutyType || null,
        hireDate: new Date(hireDate),
        rateType,
        rate: Number(rate),
        payFrequency: payFrequency || null,
        penaltyFee: penaltyFee != null ? Number(penaltyFee) : null,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        gender: gender || null,
        maritalStatus: maritalStatus || null,
        cnic: cnic || null,
        emergencyContactName: emergencyContactName || null,
        emergencyContactRelation: emergencyContactRelation || null,
        emergencyContactPhone: emergencyContactPhone || null,
      },
    });
    return res.status(201).json(ApiResponse.created(mapEmployee(e), 'Employee created'));
  } catch (err: any) {
    if (err.code === 'P2002') throw new ApiError('This user account is already linked to another employee', 400);
    throw err;
  }
});

export const updateEmployee = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Employee not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Employee not found', 404);

  const {
    firstName, lastName, email, phone, photoUrl, userId, supervisorId,
    division, designation, dutyType, hireDate, rateType, rate, payFrequency, penaltyFee,
    dateOfBirth, gender, maritalStatus, cnic,
    emergencyContactName, emergencyContactRelation, emergencyContactPhone, status,
  } = req.body;

  if (rateType !== undefined && !RATE_TYPES.includes(rateType)) {
    throw new ApiError(`rateType must be one of: ${RATE_TYPES.join(', ')}`, 400);
  }

  if (supervisorId) {
    if (supervisorId === req.params.id) {
      throw new ApiError('An employee cannot be their own supervisor', 400);
    }
    const supervisor = await prisma.employee.findUnique({ where: { id: supervisorId } });
    if (!supervisor || (scope && supervisor.outletId !== scope)) {
      throw new ApiError('Supervisor not found', 400);
    }
  }

  try {
    const e = await prisma.employee.update({
      where: { id: req.params.id },
      data: {
        firstName: firstName ?? existing.firstName,
        lastName: lastName !== undefined ? lastName : existing.lastName,
        email: email !== undefined ? email : existing.email,
        phone: phone ?? existing.phone,
        photoUrl: photoUrl !== undefined ? photoUrl : existing.photoUrl,
        userId: userId !== undefined ? (userId || null) : existing.userId,
        supervisorId: supervisorId !== undefined ? (supervisorId || null) : existing.supervisorId,
        division: division !== undefined ? division : existing.division,
        designation: designation ?? existing.designation,
        dutyType: dutyType !== undefined ? dutyType : existing.dutyType,
        hireDate: hireDate ? new Date(hireDate) : existing.hireDate,
        rateType: rateType ?? existing.rateType,
        rate: rate != null ? Number(rate) : existing.rate,
        payFrequency: payFrequency !== undefined ? payFrequency : existing.payFrequency,
        penaltyFee: penaltyFee !== undefined ? (penaltyFee != null ? Number(penaltyFee) : null) : existing.penaltyFee,
        dateOfBirth: dateOfBirth !== undefined ? (dateOfBirth ? new Date(dateOfBirth) : null) : existing.dateOfBirth,
        gender: gender !== undefined ? gender : existing.gender,
        maritalStatus: maritalStatus !== undefined ? maritalStatus : existing.maritalStatus,
        cnic: cnic !== undefined ? cnic : existing.cnic,
        emergencyContactName: emergencyContactName !== undefined ? emergencyContactName : existing.emergencyContactName,
        emergencyContactRelation: emergencyContactRelation !== undefined ? emergencyContactRelation : existing.emergencyContactRelation,
        emergencyContactPhone: emergencyContactPhone !== undefined ? emergencyContactPhone : existing.emergencyContactPhone,
        status: status ?? existing.status,
      },
    });
    return res.json(ApiResponse.success(mapEmployee(e), 'Employee updated'));
  } catch (err: any) {
    if (err.code === 'P2002') throw new ApiError('This user account is already linked to another employee', 400);
    throw err;
  }
});

export const deleteEmployee = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Employee not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Employee not found', 404);
  const e = await prisma.employee.update({ where: { id: req.params.id }, data: { status: 'inactive', terminationDate: new Date(), terminationReason: 'Deactivated' } });
  return res.json(ApiResponse.success(mapEmployee(e), 'Employee deactivated'));
});

export const terminateEmployee = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    throw new ApiError('Termination reason is required', 400);
  }

  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Employee not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Employee not found', 404);

  const e = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      status: 'inactive',
      terminationDate: new Date(),
      terminationReason: reason.trim(),
    },
  });

  return res.json(ApiResponse.success(mapEmployee(e), 'Employee terminated successfully'));
});

export const rehireEmployee = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Employee not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Employee not found', 404);

  const { rehireDate, rate } = req.body;

  const e = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      status: 'active',
      rehireDate: rehireDate ? new Date(rehireDate) : new Date(),
      rate: rate != null ? Number(rate) : existing.rate,
    },
  });

  return res.json(ApiResponse.success(mapEmployee(e), 'Employee rehired successfully'));
});
