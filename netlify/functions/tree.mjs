import {db,json} from './_db.mjs';
export async function handler(){
  const pool=db();
  if(!pool) return json(503,{error:'Database is not configured. Demo data is available locally.'});
  const [p,r]=await Promise.all([
    pool.query('select * from people order by lower(given_name),lower(surname)'),
    pool.query("select * from relationships where status='approved'")
  ]);
  return json(200,{mode:'database',people:p.rows,relationships:r.rows});
}
