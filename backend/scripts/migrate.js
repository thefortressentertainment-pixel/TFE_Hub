#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
(async ()=>{
  const dir = path.join(__dirname, '..', 'migrations');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/fortress' });
  try{
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
    for(const f of files){
      const sql = fs.readFileSync(path.join(dir,f),'utf8');
      console.log('Applying', f);
      await pool.query(sql);
    }
    console.log('migrations applied');
  }catch(e){ console.error(e); process.exit(1);} finally{ await pool.end(); }
})();
