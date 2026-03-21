import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getRiders, createRider, updateRider,
  getAssignments, getMyAssignments, getMyStats,
  assignRider, updateAssignmentStatus, collectAmount,
  getRiderStats, getDeliveryDashboard,
} from './delivery.controller.js';

const managerRoles  = ['Super Admin', 'Admin', 'Manager', 'Cashier', 'Delivery Manager'];
const riderRoles    = ['Super Admin', 'Admin', 'Manager', 'Cashier', 'Delivery Manager', 'Rider'];
const collectRoles  = ['Super Admin', 'Admin', 'Manager', 'Cashier', 'Delivery Manager'];

export const deliveryRouter = Router();

// Riders
deliveryRouter.get   ('/riders',         authenticate, authorize(managerRoles), getRiders);
deliveryRouter.post  ('/riders',         authenticate, authorize(managerRoles), createRider);
deliveryRouter.put   ('/riders/:id',     authenticate, authorize(managerRoles), updateRider);
deliveryRouter.get   ('/riders/:id/stats', authenticate, authorize(managerRoles), getRiderStats);

// Rider's own endpoints
deliveryRouter.get   ('/my-assignments', authenticate, authorize(riderRoles),   getMyAssignments);
deliveryRouter.get   ('/my-stats',       authenticate, authorize(riderRoles),   getMyStats);

// Assignments
deliveryRouter.get   ('/assignments',             authenticate, authorize(managerRoles), getAssignments);
deliveryRouter.post  ('/assign',                  authenticate, authorize(managerRoles), assignRider);
deliveryRouter.put   ('/assignments/:id/status',  authenticate, authorize(riderRoles),   updateAssignmentStatus);
deliveryRouter.put   ('/assignments/:id/collect', authenticate, authorize(collectRoles),  collectAmount);

// Dashboard
deliveryRouter.get   ('/dashboard', authenticate, authorize(managerRoles), getDeliveryDashboard);
