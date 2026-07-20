import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
p.wasteRecord.deleteMany({})
  .then(r => { console.log('✅ WasteRecord:', r.count, 'deleted'); })
  .catch(e => { console.error(e); })
  .finally(() => p.$disconnect());
