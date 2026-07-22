import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getReservations, createReservation, updateReservation, deleteReservation, convertReservationToOrder } from './reservation.controller.js';

const router = Router();

router.get('/', authenticate, getReservations);
router.post('/', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), createReservation);
router.put('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), updateReservation);
router.delete('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), deleteReservation);
router.post('/:id/convert-to-order', authenticate, authorize(['Super Admin', 'Admin', 'Manager', 'Cashier', 'Waiter']), convertReservationToOrder);

export { router as reservationsRouter };

