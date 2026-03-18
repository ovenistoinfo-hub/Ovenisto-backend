/**
 * Stock Routes
 * Phase 4: Stock Adjustments, Stock Takes, Production, Transfers, Waste
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getAdjustments, createAdjustment,
  getStockTakes, getStockTake, startStockTake, completeStockTake,
  getProductions, createProduction,
  getTransfers, createTransfer, updateTransferStatus,
  getWasteRecords, createWasteRecord,
} from './stock.controller.js';

const router = Router();
const stockRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];

// ── Stock Adjustments ──
router.get('/adjustments', authenticate, getAdjustments);
router.post('/adjustments', authenticate, authorize(stockRoles), createAdjustment);

// ── Stock Takes ──
router.get('/takes', authenticate, getStockTakes);
router.get('/takes/:id', authenticate, getStockTake);
router.post('/takes', authenticate, authorize(stockRoles), startStockTake);
router.post('/takes/:id/complete', authenticate, authorize(stockRoles), completeStockTake);

// ── Production ──
router.get('/productions', authenticate, getProductions);
router.post('/productions', authenticate, authorize(stockRoles), createProduction);

// ── Transfers ──
router.get('/transfers', authenticate, getTransfers);
router.post('/transfers', authenticate, authorize(stockRoles), createTransfer);
router.put('/transfers/:id', authenticate, authorize(stockRoles), updateTransferStatus);

// ── Waste Records ──
router.get('/waste', authenticate, getWasteRecords);
router.post('/waste', authenticate, authorize(stockRoles), createWasteRecord);

export default router;
