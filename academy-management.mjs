import {randomUUID} from 'node:crypto';
import {lessons} from './curriculum.mjs';

export const defaultLanding={headline:'Small steps. Brilliant discoveries.',intro:'A 24-week adventure in computers, coding, automation and virtual robotics for curious minds aged 9–12.',about:'Build confidence through two short sessions each week, practical projects and encouragement from parents and tutors.',parentInfo:'Follow progress, celebrate projects and choose the support that suits your family.'};
export function createManagement({db,body,json,text,integer,password,hashPassword,requireSession,isAdmin,transaction}) {
  const q=sql=>db.prepare(sql),fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  for(const table of ['parents','children']) if(!q(`PRAGMA table_info(${table})`).all().some(c=>c.name==='active')) db.exec(`ALTER TABLE ${table} ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  db.exec(`CREATE TABLE IF NOT EXISTS content(key TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created TEXT NOT NULL);`);
  const audit=(sess,action,target)=>q('INSERT INTO admin_audit(actor,action,target,created) VALUES(?,?,?,?)').run(sess.user_id,action,target,new Date().toISOString());
  const entry=key=>q('SELECT value,revision FROM content WHERE key=?').get(key);
  const lesson=week=>{const row=entry(`week:${week}`);return {...(row?JSON.parse(row.value):structuredClone(lessons[week-1])),revision:row?.revision??0};};
  const landing=()=>{const row=entry('landing');return {...defaultLanding,...(row?JSON.parse(row.value):{}),revision:row?.revision??0};};
  const canEdit=sess=>isAdmin(sess)||sess?.role==='tutor';
  const email=value=>{const v=text(value,'email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))fail(400,'Please enter a valid email.');return v;};
  const save=(key,value,revision,sess)=>transaction(()=>{
    const current=entry(key);if(revision!==(current?.revision??0))fail(409,'Someone else updated this content. Reload the editor before saving.');
    q('INSERT INTO content VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=excluded.revision').run(key,JSON.stringify(value),revision+1);audit(sess,'content saved',key);
  });
  return {lesson,landing,canEdit,
    decorate(state,sess){
      state.landing=landing();state.canEditContent=canEdit(sess);
      state.lessons=lessons.map(l=>{const {quiz,revision,...rest}=lesson(l.week);return {...rest,quiz:{question:quiz.question,options:quiz.options}};});
      if(isAdmin(sess)){
        state.admin.parents=q('SELECT id,name,email,active FROM parents ORDER BY name').all();
        state.admin.students=q('SELECT c.id,c.parent_id AS parentId,c.nickname,c.username,c.schedule,c.unlocked,c.active,p.name AS parentName FROM children c JOIN parents p ON p.id=c.parent_id ORDER BY c.nickname').all();
      }
    },
    async handle({req,res,path,url,sess}){
      if(req.method==='GET'&&path==='/api/content'){
        requireSession(sess);if(!canEdit(sess))fail(403,'Content editing requires a tutor or administrator account.');
        const week=integer(Number(url.searchParams.get('week')),1,24,'week');json(res,200,{lesson:lesson(week),landing:landing()});return true;
      }
      if(req.method==='POST'&&path==='/api/content'){
        requireSession(sess);if(!canEdit(sess))fail(403,'Content editing requires a tutor or administrator account.');const data=await body(req);
        if(data.kind==='landing'){
          const value=Object.fromEntries(Object.keys(defaultLanding).map(k=>[k,text(data.value?.[k],k,k==='headline'?120:1200)]));save('landing',value,data.revision,sess);
        }else if(data.kind==='lesson'){
          const week=integer(data.week,1,24,'week'),value=structuredClone(lessons[week-1]),v=data.value;
          if(!v||typeof v!=='object')fail(400,'Enter lesson content.');
          for(const key of ['title','subtitle','challenge','output','assessment','teachingNotes'])value[key]=text(v[key],key,2000);
          if(!Array.isArray(v.objectives)||v.objectives.length<1||v.objectives.length>6)fail(400,'Enter 1–6 objectives.');value.objectives=v.objectives.map(x=>text(x,'objective',500));
          for(const key of ['sessionA','sessionB']){
            const s=v[key];if(!s||!Array.isArray(s.steps)||s.steps.length!==3)fail(400,'Each session needs three steps.');
            value[key]={title:text(s.title,'session title',150),minutes:text(s.minutes,'session duration',30),explanation:text(s.explanation,'explanation',2000),steps:s.steps.map(x=>text(x,'step',1500))};
          }
          if(!v.quiz||!Array.isArray(v.quiz.options)||v.quiz.options.length!==3)fail(400,'Enter three quiz options.');
          value.quiz={question:text(v.quiz.question,'quiz question',500),options:v.quiz.options.map(x=>text(x,'quiz option',500)),answer:integer(v.quiz.answer,0,2,'correct answer')};
          if(!Array.isArray(v.resources)||v.resources.length>8)fail(400,'Use up to eight resources.');
          value.resources=v.resources.map(r=>{let url;try{url=new URL(r.url);}catch{fail(400,'Enter valid resource URLs.');}if(url.protocol!=='https:'||url.username||url.password)fail(400,'Resources need HTTPS links without login details.');return{title:text(r.title,'resource title',150),url:url.href};});
          save(`week:${week}`,value,data.revision,sess);
        }else fail(400,'Choose lesson or landing content.');
        json(res,200,{ok:true});return true;
      }
      if(req.method==='POST'&&path==='/api/admin/accounts'){
        requireSession(sess,'parent');if(!isAdmin(sess))fail(403,'Only the academy administrator can manage accounts.');
        const data=await body(req),tables={parent:'parents',child:'children',tutor:'tutors'},table=tables[data.role];if(!table)fail(400,'Choose an account type.');
        if(data.action==='create'&&data.role==='child'){
          if(!q('SELECT id FROM parents WHERE id=? AND active=1').get(data.parentId))fail(400,'Choose an active parent account.');
          if(q('SELECT count(*) AS n FROM children WHERE parent_id=?').get(data.parentId).n>=10)fail(400,'This family already has ten student profiles.');
          const name=text(data.username,'student username',30).toLowerCase();if(!/^[a-z0-9_-]{3,30}$/.test(name))fail(400,'Use 3–30 letters, numbers, underscores or hyphens.');
          if(q('SELECT id FROM children WHERE username=?').get(name))fail(409,'This student username is already in use.');
          const nickname=text(data.nickname,'nickname',30),hash=await hashPassword(password(data.password)),id=randomUUID();
          transaction(()=>{q('INSERT INTO children(id,parent_id,nickname,username,password) VALUES(?,?,?,?,?)').run(id,data.parentId,nickname,name,hash);audit(sess,'student created',id);});
        }else if(data.action==='create'&&data.role==='parent'){
          const address=email(data.email);if(q('SELECT id FROM parents WHERE email=?').get(address))fail(409,'This parent email is already in use.');
          const hash=await hashPassword(password(data.password));const id=randomUUID();transaction(()=>{q('INSERT INTO parents(id,email,name,password) VALUES(?,?,?,?)').run(id,address,text(data.name,'name',60),hash);audit(sess,'parent created',id);});
        }else{
          const account=q(`SELECT * FROM ${table} WHERE id=?`).get(data.id);if(!account)fail(404,'Account not found.');
          if(data.role==='parent'&&isAdmin({role:'parent',user:account})&&['status','reset','update'].includes(data.action))fail(400,'The configured administrator account cannot be changed here.');
          if(data.action==='reset'){
            const hash=await hashPassword(password(data.password));transaction(()=>{q(`UPDATE ${table} SET password=? WHERE id=?`).run(hash,data.id);q('DELETE FROM sessions WHERE user_id=?').run(data.id);audit(sess,'passphrase reset',data.id);});
          }else if(data.action==='status'){
            if(typeof data.active!=='boolean')fail(400,'Choose active or paused.');
            transaction(()=>{q(`UPDATE ${table} SET active=? WHERE id=?`).run(data.active?1:0,data.id);q('DELETE FROM sessions WHERE user_id=?').run(data.id);if(data.role==='parent')q("DELETE FROM sessions WHERE role='child' AND user_id IN (SELECT id FROM children WHERE parent_id=?)").run(data.id);audit(sess,data.active?'account activated':'account paused',data.id);});
          }else if(data.action==='update'){
            if(data.role==='child'){
              const name=text(data.username,'username',30).toLowerCase();if(!/^[a-z0-9_-]{3,30}$/.test(name))fail(400,'Use 3–30 letters, numbers, underscores or hyphens.');
              if(q('SELECT id FROM children WHERE username=? AND id<>?').get(name,data.id))fail(409,'This username is already in use.');
              const nickname=text(data.nickname,'nickname',30),schedule=text(data.schedule,'study plan',500,false),unlocked=integer(data.unlocked,1,24,'unlocked week');
              transaction(()=>{q('UPDATE children SET nickname=?,username=?,schedule=?,unlocked=? WHERE id=?').run(nickname,name,schedule,unlocked,data.id);audit(sess,'student updated',data.id);});
            }else{
              const address=email(data.email),name=text(data.name,'name',60);if(q(`SELECT id FROM ${table} WHERE email=? AND id<>?`).get(address,data.id))fail(409,'This email is already in use.');
              transaction(()=>{q(`UPDATE ${table} SET name=?,email=? WHERE id=?`).run(name,address,data.id);q('DELETE FROM sessions WHERE user_id=?').run(data.id);audit(sess,'account updated',data.id);});
            }
          }else fail(400,'Unknown account action.');
        }
        json(res,200,{ok:true});return true;
      }
      return false;
    }
  };
}
