import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  listCancellationRequests,
  listMyCancellationRequests,
  reviewCancellationRequest,
} from './cancellation-request.controller.js';

const authorizerRoles = ['Super Admin', 'Admin', 'Manager'];

export const cancellationRequestsRouter = Router();
cancellationRequestsRouter.use(authenticate);

// Specific paths before parameterized — ORDER MATTERS
cancellationRequestsRouter.get('/mine', listMyCancellationRequests);
cancellationRequestsRouter.get('/', authorize(authorizerRoles), listCancellationRequests);
cancellationRequestsRouter.patch('/:id/review', authorize(authorizerRoles), reviewCancellationRequest);
