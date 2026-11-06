import express from 'express';
import Database from 'better-sqlite3';
import multer from 'multer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import crypto from 'node:crypto';
import pdfParse from 'pdf-parse';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
const app=express(), PORT=process.env.PORT||3000;
fs.mkdirSync('data/files',{recursive:true});
const db=new Database('data/obraflux.db');db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL DEFAULT 'Nota fiscal',supplier TEXT DEFAULT '',cnpj TEXT DEFAULT '',number TEXT DEFAULT '',amount REAL DEFAULT 0,due TEXT DEFAULT '',issued TEXT DEFAULT '',project TEXT DEFAULT '',status TEXT DEFAULT 'Pendente',notes TEXT DEFAULT '',filename TEXT DEFAULT '',originalname TEXT DEFAULT '',hash TEXT UNIQUE,source TEXT DEFAULT 'Manual',created_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,document_id INTEGER,action TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
for(const [name,ddl] of Object.entries({posted_at:"TEXT DEFAULT ''",posting_reference:"TEXT DEFAULT ''",payment_status:"TEXT DEFAULT 'Não informado'",paid_at:"TEXT DEFAULT ''"})){if(!db.prepare('PRAGMA table_info(documents)').all().some(c=>c.name===name))db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${ddl}`)}
for(const [name,ddl] of Object.entries({linked_invoice_id:'INTEGER',extraction_status:"TEXT DEFAULT 'Não analisado'"})){if(!db.prepare('PRAGMA table_info(documents)').all().some(c=>c.name===name))db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${ddl}`)}
const sessions=new Map();const attempts=new Map();const password=process.env.ADMIN_PASSWORD;if(!password||password.length<12)throw Error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres no .env');
app.use(express.json({limit:'2mb'}));app.use(express.static('public'));
const auth=(req,res,next)=>{let token=req.headers.authorization?.replace(/^Bearer /,'');if(!token||!sessions.has(token)||Date.now()-sessions.get(token)>8*3600_000)return res.status(401).json({error:'Não autorizado'});sessions.set(token,Date.now());next()};
app.post('/api/login',(req,res)=>{const ip=req.ip;const item=attempts.get(ip)||{count:0,until:0};if(item.until>Date.now())return res.status(429).json({error:'Muitas tentativas. Aguarde 15 minutos.'});const a=Buffer.from(String(req.body.password||'')),b=Buffer.from(password);if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){const count=item.count+1;attempts.set(ip,{count,until:count>=8?Date.now()+900000:0});return res.status(401).json({error:'Senha incorreta'})}attempts.delete(ip);const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now());res.json({token})});
app.post('/api/logout',auth,(req,res)=>{sessions.delete(req.headers.authorization.slice(7));res.json({ok:true})});
app.get('/api/documents',auth,(req,res)=>res.json(db.prepare('SELECT * FROM documents ORDER BY created_at DESC,id DESC').all()));
const fields=['kind','supplier','cnpj','number','amount','due','issued','project','status','notes','posted_at','posting_reference','payment_status','paid_at'];
app.post('/api/documents',auth,(req,res)=>{const o=Object.fromEntries(fields.map(k=>[k,req.body[k]??(k==='amount'?0:'')]));o.amount=Number(o.amount)||0;if(o.status==='Lançado'&&!o.posted_at)o.posted_at=new Date().toISOString().slice(0,10);const result=db.prepare(`INSERT INTO documents(${fields.join(',')}) VALUES(${fields.map(k=>'@'+k).join(',')})`).run(o);db.prepare('INSERT INTO audit(document_id,action) VALUES(?,?)').run(result.lastInsertRowid,'Criado');res.json({id:result.lastInsertRowid})});
app.patch('/api/documents/:id',auth,(req,res)=>{const updates=fields.filter(k=>Object.hasOwn(req.body,k));if(req.body.status==='Lançado'&&!req.body.posted_at)req.body.posted_at=new Date().toISOString().slice(0,10),updates.includes('posted_at')||updates.push('posted_at');if(!updates.length)return res.status(400).json({error:'Sem alterações'});const data={id:Number(req.params.id)};for(const k of updates)data[k]=k==='amount'?Number(req.body[k])||0:String(req.body[k]);const r=db.prepare(`UPDATE documents SET ${updates.map(k=>k+'=@'+k).join(',')} WHERE id=@id`).run(data);if(!r.changes)return res.status(404).json({error:'Não encontrado'});db.prepare('INSERT INTO audit(document_id,action) VALUES(?,?)').run(data.id,'Atualizado: '+updates.join(', '));res.json({ok:true})});
app.delete('/api/documents/:id',auth,(req,res)=>{const row=db.prepare('SELECT filename FROM documents WHERE id=?').get(req.params.id);if(!row)return res.status(404).json({error:'Não encontrado'});db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);db.prepare('INSERT INTO audit(document_id,action) VALUES(?,?)').run(req.params.id,'Excluído');if(row.filename)fs.rmSync(path.join('data/files',row.filename),{force:true});res.json({ok:true})});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024}});
const cleanNumber=s=>String(s||'').replace(/\D/g,'').replace(/^0+/,'')||'';
const brDate=s=>{const m=String(s||'').match(/(\d{2})\/(\d{2})\/(\d{4})/);return m?`${m[3]}-${m[2]}-${m[1]}`:''};
const money=s=>{let v=String(s||'').replace(/[^\d,.]/g,'');if(v.includes(','))v=v.replace(/\./g,'').replace(',','.');return Number(v)||0};
const digits=s=>String(s||'').replace(/\D/g,'');
const normalizeName=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\b(LTDA|EIRELI|ME|EPP|SA|S A)\b/g,'').replace(/[^A-Z0-9]/g,'');
const findCnpj=s=>String(s||'').match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/)?.[0]||'';
function parseDocument(text,ext,originalname){
 const flat=String(text||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ');
 const lines=flat.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 if(ext==='.xml'){
  const val=(tag,body=flat)=>body.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]+)</(?:\\w+:)?${tag}>`))?.[1]||'';
  const emit=flat.match(/<emit>([\s\S]*?)<\/emit>/)?.[1]||'';
  const dup=flat.match(/<dup>([\s\S]*?)<\/dup>/)?.[1]||'';
  return {kind:'Nota fiscal',supplier:val('xNome',emit),cnpj:findCnpj(val('CNPJ',emit)),number:cleanNumber(val('nNF')),amount:Number(val('vNF'))||0,issued:val('dhEmi').slice(0,10)||val('dEmi'),due:val('dVenc',dup),confidence:'XML da NF-e (emitente e duplicata)'};
 }
 const isInvoice=/DANFE|NOTA FISCAL ELETR[ÔO]NICA|NF-e/i.test(flat);
 const isBoleto=!isInvoice&&(/linha digit[aá]vel|ficha de compensa[cç][aã]o|valor cobrado|data de vencimento|benefici[aá]rio|pagador/i.test(flat)||/boleto|cobran/i.test(originalname));
 if(isBoleto){
  const due=brDate(flat.match(/(?:data de vencimento|vencimento|vence em)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1]||lines.find(x=>/^\d{2}\/\d{2}\/\d{4}$/.test(x))||'');
  const amount=money(flat.match(/(?:\(=\)\s*valor documento|valor documento|valor cobrado)\s*:?\s*R?\$?\s*([\d.,]+)/i)?.[1]);
  const benef=flat.match(/(?:benefici[aá]rio|cedente)\s*:?\s*([^\n]{4,100})/i)?.[1]||'';
  const supplier=benef.replace(/\s+(?:CNPJ|CPF|Ag[eê]ncia|Banco)\b.*$/i,'').trim();
  const cnpj=findCnpj(benef)||findCnpj(flat.match(/(?:benefici[aá]rio|cedente)[\s\S]{0,180}/i)?.[0]);
  const invoiceRef=cleanNumber(flat.match(/(?:NF-e|nota fiscal|N\.?F\.?)\s*(?:n[º°.]*)?\s*[:#-]?\s*([\d.]{3,})/i)?.[1]);
  return {kind:'Boleto',supplier,cnpj,number:invoiceRef,amount,due,issued:'',confidence:due?'Boleto: conferir beneficiário e vencimento':'Conferir vencimento do boleto'};
 }
 const emitterIndex=lines.findIndex(x=>/IDENTIFICA[CÇ][AÃ]O DO EMITENTE/i.test(x));
 const emitterSection=emitterIndex>=0?lines.slice(emitterIndex+1,emitterIndex+14).join('\n'):lines.slice(0,24).join('\n');
 const cut=emitterSection.split(/(?:NATUREZA DA OPERA[CÇ][AÃ]O|DESTINAT[AÁ]RIO\s*\/\s*REMETENTE|DADOS DOS PRODUTOS|C[AÁ]LCULO DO IMPOSTO)/i)[0];
 const supplierLine=cut.split('\n').find(x=>/\b(?:LTDA|EIRELI|S\/A|ME|EPP)\b/i.test(x)&&!/(?:RECEBEMOS|DESTINAT[AÁ]RIO|DANFE)/i.test(x));
 const supplier=(supplierLine||'').replace(/^.*?(?=[A-Z][A-Z ]{3,}\b(?:LTDA|EIRELI|S\/A|ME|EPP)\b)/,'').trim();
 const cnpj=findCnpj(cut.match(/(?:CNPJ(?:\s*\/\s*CPF)?)[\s\S]{0,65}/i)?.[0])||'';
 const number=cleanNumber(flat.match(/(?:NF-e\s*N[º°o.]?\s*|N[º°o.]\s*[:.]?\s*)([\d.]{4,})/i)?.[1]||flat.match(/(?:N[ÚU]MERO DA NOTA|N[ÚU]MERO NF)\s*:?\s*([\d.]+)/i)?.[1]);
 const issued=brDate(flat.match(/DATA DA EMISS[AÃ]O\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1]);
 const amount=money(flat.match(/(?:V\.?\s*TOTAL DA NOTA|VALOR TOTAL DA NOTA)\s*R?\$?\s*([\d.,]+)/i)?.[1]);
 const duplicateArea=flat.match(/FATURA\s*\/\s*DUPLICATA([\s\S]{0,260})/i)?.[1]||'';
 const due=brDate(duplicateArea.match(/(?:Venc\.?|Vencimento)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1]);
 return {kind:isInvoice?'Nota fiscal':'Documento para conferir',supplier,cnpj,number,amount,issued,due,confidence:isInvoice?'DANFE: revisar os campos extraídos':'Tipo não reconhecido'};
}
function linkBoleto(boletoId){
 const boleto=db.prepare('SELECT * FROM documents WHERE id=?').get(boletoId);
 if(!boleto||boleto.kind!=='Boleto'||!boleto.due||boleto.linked_invoice_id)return false;
 const candidates=db.prepare("SELECT * FROM documents WHERE kind='Nota fiscal' AND id<>? AND amount>0 AND ABS(amount-?)<0.01").all(boletoId,boleto.amount);
 const matches=candidates.filter(n=>{
  const sameCnpj=digits(n.cnpj).length===14&&digits(n.cnpj)===digits(boleto.cnpj);
  const sameName=normalizeName(n.supplier).length>=8&&normalizeName(n.supplier)===normalizeName(boleto.supplier);
  const sameNumber=Boolean(boleto.number&&n.number&&cleanNumber(boleto.number)===cleanNumber(n.number));
  return sameCnpj||(sameName&&sameNumber);
 });
 if(matches.length!==1)return false;
 const invoice=matches[0];
 db.prepare('UPDATE documents SET linked_invoice_id=?,extraction_status=? WHERE id=?').run(invoice.id,'Vinculado: fornecedor, referência e valor conferidos',boletoId);
 db.prepare('UPDATE documents SET due=? WHERE id=?').run(boleto.due,invoice.id);
 db.prepare('INSERT INTO audit(document_id,action) VALUES(?,?)').run(invoice.id,'Boleto '+boletoId+' vinculado; vencimento '+boleto.due);
 return true;
}
function linkPendingBoletos(){for(const b of db.prepare("SELECT id FROM documents WHERE kind='Boleto' AND linked_invoice_id IS NULL").all())linkBoleto(b.id)}
async function storeFile(buffer,originalname,source='Upload',extra={}){
 const hash=crypto.createHash('sha256').update(buffer).digest('hex');const existing=db.prepare('SELECT id FROM documents WHERE hash=?').get(hash);if(existing)return {id:existing.id,duplicate:true};
 const ext=path.extname(originalname).toLowerCase();if(!['.pdf','.xml'].includes(ext))throw Error('Somente PDF e XML');
 let parsed;try{const text=ext==='.pdf'?(await pdfParse(buffer)).text:buffer.toString('utf8');parsed=parseDocument(text,ext,originalname)}catch(e){parsed={kind:'Documento para conferir',supplier:'',cnpj:'',number:'',amount:0,issued:'',due:'',confidence:'Falha na leitura: '+e.message}}
 const filename=crypto.randomUUID()+ext;fs.writeFileSync(path.join('data/files',filename),buffer);
 const r=db.prepare('INSERT INTO documents(kind,supplier,cnpj,number,amount,due,issued,project,status,notes,filename,originalname,hash,source,extraction_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(parsed.kind,parsed.supplier,parsed.cnpj,parsed.number,parsed.amount,parsed.due,parsed.issued,'','Pendente',extra.notes||'',filename,originalname,hash,source,parsed.confidence);
 db.prepare('INSERT INTO audit(document_id,action) VALUES(?,?)').run(r.lastInsertRowid,'Importado: '+source+'; '+parsed.confidence);
 linkPendingBoletos();
 return {id:r.lastInsertRowid,duplicate:false,extracted:parsed};
}
app.post('/api/upload',auth,upload.array('files',30),async(req,res)=>{const results=[];for(const f of req.files||[]){try{results.push({name:f.originalname,...await storeFile(f.buffer,f.originalname)})}catch(e){results.push({name:f.originalname,error:e.message})}}res.json(results)});
app.get('/api/documents/:id/file',auth,(req,res)=>{const row=db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);if(!row?.filename)return res.status(404).end();res.type(row.filename.endsWith('.xml')?'application/xml':'application/pdf');res.set('Content-Disposition',`inline; filename="${row.filename}"`);res.sendFile(path.resolve('data/files',row.filename))});
app.get('/api/audit',auth,(req,res)=>res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all()));
app.post('/api/sync-email',auth,async(req,res)=>{const {IMAP_HOST,IMAP_PORT,IMAP_USER,IMAP_PASSWORD}=process.env;if(!IMAP_HOST||!IMAP_USER||!IMAP_PASSWORD)return res.status(400).json({error:'Configure IMAP no arquivo .env'});const client=new ImapFlow({host:IMAP_HOST,port:Number(IMAP_PORT)||993,secure:true,auth:{user:IMAP_USER,pass:IMAP_PASSWORD},logger:false});let imported=0,duplicates=0,errors=0;try{await client.connect();const lock=await client.getMailboxLock('INBOX');try{const total=client.mailbox.exists;const start=Math.max(1,total-199);if(total){for await(const msg of client.fetch(`${start}:${total}`,{source:true})){const mail=await simpleParser(msg.source);const emailDocs=[];for(const a of mail.attachments){if(!/\.(pdf|xml)$/i.test(a.filename||''))continue;try{const r=await storeFile(a.content,a.filename,'E-mail',{notes:`De: ${mail.from?.text||''} | Assunto: ${mail.subject||''} | Data: ${mail.date?.toISOString()||''}`});r.duplicate?duplicates++:imported++;if(r.id)emailDocs.push(db.prepare('SELECT * FROM documents WHERE id=?').get(r.id))}catch{errors++}}linkPendingBoletos()}}}finally{lock.release()}await client.logout();res.json({imported,duplicates,errors})}catch(e){try{await client.logout()}catch{}res.status(500).json({error:'Falha ao sincronizar e-mail: '+e.message})}});
app.use((err,req,res,next)=>res.status(400).json({error:err.message}));app.listen(PORT,()=>console.log(`ObraFlux em http://localhost:${PORT}`));
