import {db,json,requireToken} from './_db.mjs';
export async function handler(event){
 const pool=db(); if(!pool) return json(503,{error:'Database is not configured.'});
 if(event.httpMethod!=='POST') return json(405,{error:'Method not allowed'});
 const token=await requireToken(event,pool); if(!token) return json(401,{error:'A valid 5-digit family token is required.'});
 let b={}; try{b=JSON.parse(event.body||'{}')}catch{return json(400,{error:'Invalid JSON'})}
 if(!b.author_name?.trim()||!b.body?.trim()) return json(400,{error:'Name and comment are required.'});
 const a=await pool.query("select id from articles where slug='asankran-history'");
 if(!a.rows[0]) return json(404,{error:'Article not initialized.'});
 await pool.query('insert into comments(article_id,author_name,body,token_label) values($1,$2,$3,$4)',[a.rows[0].id,b.author_name.trim(),b.body.trim(),token.label||null]);
 return json(201,{ok:true,message:'Comment submitted for approval.'});
}
