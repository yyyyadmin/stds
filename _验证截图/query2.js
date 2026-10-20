const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/windows/AppData/Roaming/screener-master/data/screener.db', { readOnly: true });
const rows = db.prepare("SELECT id,filename,category,category_by,status,tier,tags FROM images WHERE filename LIKE '%7623%'").all();
console.log(JSON.stringify(rows,null,2));
console.log(JSON.stringify(db.prepare("SELECT status, COUNT(1) AS n FROM images GROUP BY status").all()));
