import { getDb } from './index.js';

console.log('Running migrations...');
const db = getDb();
console.log('Database initialized at:', db.name);
console.log('Tables:', db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name).join(', '));
console.log('Migrations completed.');
