/**
 * DEMO seed for the Dashboard's "Top & Bottom Items" (and the other filterable sales
 * sections). Inserts a batch of COMPLETED + cashApproved orders so both the Top Performers
 * and Underperformers tables populate.
 *
 * ⚠️  Local dev talks to the LIVE production database — there is no staging. These orders
 *     WILL appear in Sales reports, P&L, the Cash Register and the Dashboard until removed.
 *     Every row is tagged `DEMO-*` (orderNumber) + customerName "DEMO Customer" so it is
 *     trivially reversible:
 *
 *       npx tsx scripts/seed-dashboard-demo.ts --clean
 *
 * It inserts Order/OrderItem rows DIRECTLY (raw Prisma) — it does NOT run the createOrder
 * pipeline, so there is NO stock deduction, NO cash settlement, NO shift impact. Cost/Profit
 * on the dashboard is still real (computed from each item's live FoodRecipe at read time).
 *
 * Usage:
 *   npx tsx scripts/seed-dashboard-demo.ts                 # seed into the first active outlet
 *   npx tsx scripts/seed-dashboard-demo.ts --outlet=DHA    # match outlet by id | name | code
 *   npx tsx scripts/seed-dashboard-demo.ts --clean         # delete every DEMO-* order
 *
 * Idempotent: seeding first deletes any existing DEMO-* orders, then re-inserts.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TAG = 'DEMO';
const CLEAN = process.argv.includes('--clean');
const outletArg = process.argv.find((a) => a.startsWith('--outlet='))?.split('=')[1];

/** PKT (UTC+5) "now" — the codebase's standard for any "today" computation. */
const pktNow = () => new Date(Date.now() + 5 * 60 * 60 * 1000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
const rint = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

async function clean() {
  const del = await prisma.order.deleteMany({ where: { orderNumber: { startsWith: `${TAG}-` } } });
  console.log(`🧹  Deleted ${del.count} ${TAG}-* order(s) (OrderItems cascade).`);
}

async function main() {
  if (CLEAN) {
    await clean();
    return;
  }

  // ── Resolve the outlet ────────────────────────────────────────────────────
  const outlet = outletArg
    ? await prisma.outlet.findFirst({
        where: {
          OR: [
            { id: outletArg },
            { code: { equals: outletArg, mode: 'insensitive' } },
            { name: { contains: outletArg, mode: 'insensitive' } },
          ],
        },
      })
    : await prisma.outlet.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });

  if (!outlet) {
    const all = await prisma.outlet.findMany({ select: { name: true, code: true, id: true } });
    console.error(`No outlet matched "${outletArg ?? '(first active)'}". Available:`);
    all.forEach((o) => console.error(`  - ${o.name}  code=${o.code}  id=${o.id}`));
    process.exit(1);
  }
  console.log(`🏢  Seeding into outlet: ${outlet.name} (code ${outlet.code}, id ${outlet.id})`);

  // ── Menu items ───────────────────────────────────────────────────────────
  const items = await prisma.foodMenuItem.findMany({
    where: { available: true },
    select: { id: true, name: true, price: true, variants: { select: { id: true, name: true, price: true } } },
    orderBy: { createdAt: 'asc' },
    take: 40,
  });
  if (items.length < 12) {
    console.error(`Only ${items.length} available menu items — need at least 12 for a Top + Bottom spread.`);
    process.exit(1);
  }
  const menu = items.slice(0, 16); // 16 distinct items → Top 10 + Bottom 10 both fill
  console.log(`🍕  Using ${menu.length} distinct menu items.`);

  // A line's (menuItemId, variantId, name, unit price)
  const lineFor = (m: (typeof menu)[number], forceVariant = false) => {
    const v = m.variants.length && (forceVariant || Math.random() < 0.6) ? pick(m.variants) : null;
    return {
      menuItemId: m.id,
      variantId: v?.id ?? null,
      name: v ? `${m.name} (${v.name})` : m.name,
      price: Number(v?.price ?? m.price),
    };
  };

  // Buckets: heavy sellers → top of the profit ranking; single small sales → bottom.
  const HEAVY = menu.slice(0, 6);
  const MID = menu.slice(6, 10);
  const LIGHT = menu.slice(10, 16);

  const PAYMENTS = ['Cash', 'Cash', 'Cash', 'JazzCash', 'EasyPaisa', 'JazzCash'];
  const TYPES: string[] = ['DINE_IN', 'DINE_IN', 'TAKE_AWAY', 'DELIVERY', 'SELF_ORDER'];

  // wipe any previous DEMO run first (idempotent)
  await clean();

  const now = pktNow();

  type Line = { menuItemId: string; variantId: string | null; name: string; price: number; qty: number; discount: number };
  const plans: { daysAgo: number; hour: number; lines: Line[] }[] = [];

  // 14 orders spread across TODAY (so the section's default "Today" view shows both tables)
  for (let i = 0; i < 14; i++) {
    const nLines = rint(1, 3);
    const lines: Line[] = [];
    for (let j = 0; j < nLines; j++) {
      const src = j === 0 ? pick(HEAVY) : pick([...HEAVY, ...MID, ...LIGHT]);
      const l = lineFor(src);
      lines.push({ ...l, qty: rint(1, 4), discount: 0 });
    }
    plans.push({ daysAgo: 0, hour: rint(11, 22), lines });
  }

  // 8 orders across the past ~20 days (populates This Week / This Month too)
  for (let i = 0; i < 8; i++) {
    const l = lineFor(pick([...HEAVY, ...MID]));
    plans.push({ daysAgo: rint(1, 20), hour: rint(11, 22), lines: [{ ...l, qty: rint(1, 3), discount: 0 }] });
  }

  // 3 deliberately thin / loss-making orders (one LIGHT item, ~90% line discount) → very bottom
  for (let i = 0; i < 3; i++) {
    const l = lineFor(pick(LIGHT));
    plans.push({
      daysAgo: rint(0, 6),
      hour: rint(11, 22),
      lines: [{ ...l, qty: 1, discount: Math.round(l.price * 0.9) }],
    });
  }

  // ── Build + insert ───────────────────────────────────────────────────────
  let seq = 0;
  let created = 0;
  for (const p of plans) {
    seq += 1;
    const when = new Date(now.getTime() - p.daysAgo * 86_400_000);
    when.setUTCHours(p.hour - 5, rint(0, 59), 0, 0); // p.hour is PKT wall-clock → shift to UTC
    const dateOnly = new Date(`${ymd(new Date(when.getTime() + 5 * 60 * 60 * 1000))}T00:00:00.000Z`);

    const subtotal = p.lines.reduce((s, l) => s + l.price * l.qty, 0);
    const discount = p.lines.reduce((s, l) => s + l.discount, 0);
    const total = Math.max(0, subtotal - discount);

    await prisma.order.create({
      data: {
        orderNumber: `${TAG}-${String(seq).padStart(3, '0')}`,
        type: pick(TYPES) as never,
        status: 'COMPLETED' as never,
        subtotal,
        discount,
        tax: 0,
        total,
        cashApproved: true,
        paymentMethod: pick(PAYMENTS),
        customerName: 'DEMO Customer',
        staffName: 'DEMO Seed',
        outletId: outlet.id,
        date: dateOnly,
        time: `${String(p.hour).padStart(2, '0')}:${String(rint(0, 59)).padStart(2, '0')}`,
        createdAt: when,
        items: {
          create: p.lines.map((l) => ({
            menuItemId: l.menuItemId,
            variantId: l.variantId,
            name: l.name,
            price: l.price,
            qty: l.qty,
            discount: l.discount,
            modifiers: [],
            modifierIds: [],
            status: 'active',
          })),
        },
      },
    });
    created += 1;
  }

  const distinct = new Set(plans.flatMap((p) => p.lines.map((l) => l.menuItemId))).size;
  const oldest = ymd(new Date(now.getTime() - 20 * 86_400_000));
  console.log(`\n✅  Created ${created} DEMO order(s), ${distinct} distinct items, ${oldest} … ${ymd(now)}.`);
  console.log(`   Dashboard → "Top & Bottom Items" (default "Today" view) should now show both tables.`);
  console.log(`\n   Undo:  npx tsx scripts/seed-dashboard-demo.ts --clean\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
