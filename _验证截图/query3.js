const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/windows/AppData/Roaming/screener-master/data/screener.db', { readOnly: true });
const manual = db.prepare("SELECT id,filename,category,category_by,cat_changed_at FROM images WHERE tags LIKE '%manual_flaw%' ORDER BY cat_changed_at DESC LIMIT 10").all();
console.log('manual_flaw rows:', JSON.stringify(manual, null, 2));
const recent = db.prepare("SELECT id,filename,category,category_by,cat_changed_at FROM images WHERE cat_changed_at IS NOT NULL ORDER BY cat_changed_at DESC LIMIT 10").all();
console.log('recent cat_changed:', JSON.stringify(recent, null, 2));
console.log('now:', Date.now());
