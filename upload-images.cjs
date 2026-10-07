const { PrismaClient } = require('@prisma/client');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'dskx6l5ut',
  api_key: '315637194511465',
  api_secret: '9HTEYOfqVrTB_M20psR3WyVUHKM'
});

const prisma = new PrismaClient();

const itemsToUpdate = [
  { name: 'Choco Molten Lava Cake with Ice Cream', file: 'C:\\Users\\Awais Hanif\\.gemini\\antigravity\\brain\\c1ba9140-eda7-4b75-8ae0-dbe757db269a\\choco_molten_lava_1791278450832.jpg' }
];

async function main() {
  try {
      await prisma.$connect();
      console.log('connected to db');
  } catch (e) {
      console.log('error connecting to db, retrying...', e);
      await new Promise(r => setTimeout(r, 2000));
      await prisma.$connect();
  }
  for (const item of itemsToUpdate) {
    try {
      console.log(`Uploading ${item.name}...`);
      const result = await cloudinary.uploader.upload(item.file, { folder: 'ovenisto/menu' });
      
      const dbItem = await prisma.foodMenuItem.findFirst({ where: { name: item.name } });
      if (dbItem) {
        await prisma.foodMenuItem.update({
          where: { id: dbItem.id },
          data: { image: result.secure_url }
        });
        console.log(`Updated DB for ${item.name}`);
      }
    } catch (e) {
      console.error(`Error on ${item.name}:`, e);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
