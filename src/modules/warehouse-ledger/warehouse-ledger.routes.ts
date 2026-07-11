import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getLedgerSummary, getSettlements, createSettlement } from './warehouse-ledger.controller.js';

const ledgerRoles = ['Super Admin', 'Admin', 'Accountant', 'Manager'];

export const warehouseLedgerRouter = Router();

warehouseLedgerRouter.get('/',                      authenticate, authorize(ledgerRoles), getLedgerSummary);
warehouseLedgerRouter.get('/:outletId/settlements',  authenticate, authorize(ledgerRoles), getSettlements);
warehouseLedgerRouter.post('/:outletId/settlements', authenticate, authorize(ledgerRoles), createSettlement);
