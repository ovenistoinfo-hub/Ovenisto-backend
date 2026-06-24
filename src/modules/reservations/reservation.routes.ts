import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getReservations, createReservation, updateReservation, deleteReservation } from './reservation.controller.js';

const router = Router();

router.get('/', authenticate, getReservations);
router.post('/', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), createReservation);
router.put('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), updateReservation);
router.delete('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), deleteReservation);

export { router as reservationsRouter };
