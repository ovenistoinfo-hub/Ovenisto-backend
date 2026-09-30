import { describe, it, expect } from 'vitest';
import { isVariantAvailable, toPublicMenuItem } from '../publicMenu.js';

describe('publicMenu helpers', () => {
  describe('isVariantAvailable', () => {
    it('returns true if no recipes', () => {
      expect(isVariantAvailable([], null, new Map(), new Map())).toBe(true);
    });

    it('returns false if zero stock', () => {
      const recipes = [{ variantId: null, ingredientId: 'i1', productionItemId: null, qtyPerUnit: 1 }];
      expect(isVariantAvailable(recipes, null, new Map([['i1', 0]]), new Map())).toBe(false);
    });

    it('returns true if enough stock', () => {
      const recipes = [{ variantId: null, ingredientId: 'i1', productionItemId: null, qtyPerUnit: 2 }];
      expect(isVariantAvailable(recipes, null, new Map([['i1', 5]]), new Map())).toBe(true);
    });

    it('filters for variant-specific recipes', () => {
      const recipes = [
        { variantId: 'v1', ingredientId: 'i1', productionItemId: null, qtyPerUnit: 1 },
        { variantId: 'v2', ingredientId: 'i2', productionItemId: null, qtyPerUnit: 1 },
      ];
      expect(isVariantAvailable(recipes, 'v1', new Map([['i1', 5], ['i2', 0]]), new Map())).toBe(true);
      expect(isVariantAvailable(recipes, 'v2', new Map([['i1', 5], ['i2', 0]]), new Map())).toBe(false);
    });
  });

  describe('toPublicMenuItem', () => {
    const mockItem = {
      id: 'item1', name: 'Burger', price: '100', image: null, category: null,
      takeAwayPrice: '110', deliveryPrice: '120',
      variants: [
        { id: 'v1', name: 'Large', price: '20', takeAwayPrice: '25', deliveryPrice: null }
      ],
      modifiers: [
        { modifier: { id: 'm1', name: 'Cheese', price: '15', status: 'active' } },
        { modifier: { id: 'm2', name: 'Bacon', price: '30', status: 'archived' } }
      ]
    };

    it('maps base prices with no orderType', () => {
      const res = toPublicMenuItem(mockItem, [], new Map(), new Map());
      expect(res.price).toBe(100);
      expect(res.variants[0].price).toBe(20);
      expect(res.modifiers).toHaveLength(1);
      expect(res.modifiers[0].id).toBe('m1');
    });

    it('maps channel prices with fallback', () => {
      const resTakeAway = toPublicMenuItem(mockItem, [], new Map(), new Map(), 'Take Away');
      expect(resTakeAway.price).toBe(110);
      expect(resTakeAway.variants[0].price).toBe(25);

      const resDelivery = toPublicMenuItem(mockItem, [], new Map(), new Map(), 'Delivery');
      expect(resDelivery.price).toBe(120);
      expect(resDelivery.variants[0].price).toBe(20); // falls back to base 20 because deliveryPrice is null
    });
  });
});
