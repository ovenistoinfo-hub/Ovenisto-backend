import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getLedgerSummary, getSettlements, createSettlement } from './warehouse-ledger.controller.js';

const viewRoles = ['Super Admin', 'Admin', 'Accountant', 'Manager'];
// Super Admin represents Main warehouse — the creditor, not the payer — so it can view every
// branch's balance but never records a payment; only the owing branch's own staff can.
const payRoles = ['Admin', 'Accountant', 'Manager'];

export const warehouseLedgerRouter = Router();

warehouseLedgerRouter.get('/',                      authenticate, authorize(viewRoles), getLedgerSummary);
warehouseLedgerRouter.get('/:outletId/settlements',  authenticate, authorize(viewRoles), getSettlements);
warehouseLedgerRouter.post('/:outletId/settlements', authenticate, authorize(payRoles), createSettlement);
