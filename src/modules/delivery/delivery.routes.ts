import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getRiders, createRider, updateRider,
  getAssignments, getMyAssignments, getMyStats,
  getMyProfile, updateMyStatus, getMyHistory, getMyEarnings, getRiderRankings,
  assignRider, updateAssignmentStatus,
  getRiderStats, getDeliveryDashboard,
} from './delivery.controller.js';

const managerRoles  = ['Super Admin', 'Admin', 'Manager', 'Cashier', 'Delivery Manager'];
const riderRoles    = ['Super Admin', 'Admin', 'Manager', 'Cashier', 'Delivery Manager', 'Rider'];

export const deliveryRouter = Router();

// Riders
deliveryRouter.get   ('/riders',         authenticate, authorize(managerRoles), getRiders);
deliveryRouter.post  ('/riders',         authenticate, authorize(managerRoles), createRider);
deliveryRouter.put   ('/riders/:id',     authenticate, authorize(managerRoles), updateRider);
deliveryRouter.get   ('/riders/:id/stats', authenticate, authorize(managerRoles), getRiderStats);

// Rider's own endpoints
deliveryRouter.get   ('/my-assignments', authenticate, authorize(riderRoles),   getMyAssignments);
deliveryRouter.get   ('/my-stats',       authenticate, authorize(riderRoles),   getMyStats);
deliveryRouter.get   ('/my-profile',     authenticate, authorize(riderRoles),   getMyProfile);
deliveryRouter.patch ('/my-status',      authenticate, authorize(riderRoles),   updateMyStatus);
deliveryRouter.get   ('/my-history',     authenticate, authorize(riderRoles),   getMyHistory);
deliveryRouter.get   ('/my-earnings',    authenticate, authorize(riderRoles),   getMyEarnings);
deliveryRouter.get   ('/rankings',       authenticate, authorize(riderRoles),   getRiderRankings);

// Assignments
deliveryRouter.get   ('/assignments',             authenticate, authorize(managerRoles), getAssignments);
deliveryRouter.post  ('/assign',                  authenticate, authorize(riderRoles),   assignRider);
deliveryRouter.put   ('/assignments/:id/status',  authenticate, authorize(riderRoles),   updateAssignmentStatus);

// Dashboard
deliveryRouter.get   ('/dashboard', authenticate, authorize(managerRoles), getDeliveryDashboard);
