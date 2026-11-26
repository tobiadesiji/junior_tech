import { randomUUID } from 'node:crypto';
import { createJuniorAI, helpModes } from './junior-ai.mjs';
import { lessons } from './curriculum.mjs';

export function createLearningSupport({db,options,body,json,text,integer,password,hashPassword,verify,newSession,requireSession,log,transaction}) {
  const q=sql=>db.prepare(sql);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tutors(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS assignments(child_id TEXT NOT NULL REFERENCES children(id),tutor_id TEXT NOT NULL REFERENCES tutors(id),PRIMARY KEY(child_id,tutor_id));
    CREATE TABLE IF NOT EXISTS ai_settings(child_id TEXT PRIMARY KEY REFERENCES children(id),enabled INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'guided',daily_limit INTEGER NOT NULL DEFAULT 20);
    CREATE TABLE IF NOT EXISTS ai_usage(child_id TEXT NOT NULL REFERENCES children(id),day TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(child_id,day));
    CREATE TABLE IF NOT EXISTS ai_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,child_id TEXT NOT NULL REFERENCES children(id),week INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,flagged INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
  `);
  const ai=createJuniorAI(options.ai);
  const globalDailyLimit=Number(options.aiDailyLimit??process.env.AI_DAILY_REQUEST_LIMIT??200);
  if(!Number.isInteger(globalDailyLimit)||globalDailyLimit<1)throw new Error('AI_DAILY_REQUEST_LIMIT must be a positive integer.');
  const adminEmail=(options.adminEmail??process.env.ADMIN_EMAIL??'').trim().toLowerCase();
  const isAdmin=sess=>sess?.role==='parent' && !!adminEmail && sess.user.email===adminEmail;
  const today=()=>new Date().toISOString().slice(0,10);
  const now=()=>new Date().toISOString();
  const problem=(code,message)=>{const e=new Error(message);e.status=code;throw e;};
  const requireAdmin=sess=>{ requireSession(sess,'parent');if(!isAdmin(sess)) problem(403,'Only the academy administrator can manage tutor accounts.'); };
  const settings=id=>q('SELECT enabled,mode,daily_limit AS dailyLimit FROM ai_settings WHERE child_id=?').get(id)??{enabled:0,mode:'guided',dailyLimit:20};
  const owns=(sess,id)=>{
    requireSession(sess,'parent');
    const child=q('SELECT id,parent_id FROM children WHERE id=? AND parent_id=?').get(id,sess.user_id);
    if(!child)problem(404,'Student not found.');return child;
  };
  const assigned=(sess,id)=>sess?.role==='tutor' && !!q('SELECT 1 FROM assignments a JOIN tutors t ON t.id=a.tutor_id WHERE a.child_id=? AND a.tutor_id=? AND t.active=1 AND EXISTS(SELECT 1 FROM children c JOIN parents p ON p.id=c.parent_id WHERE c.id=a.child_id AND c.active=1 AND p.active=1)').get(id,sess.user_id);
  const accessible=(sess,id)=>!!sess && (sess.role==='child' ? sess.user_id===id : sess.role==='parent' ? !!q('SELECT 1 FROM children WHERE id=? AND parent_id=?').get(id,sess.user_id) : assigned(sess,id));
  const inFlight=new Set();
  function cleanup(){
    q("DELETE FROM ai_messages WHERE created < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')").run();
    q("DELETE FROM ai_usage WHERE day < date('now','-30 days')").run();
  }
  cleanup();
  return {
    assigned,isAdmin,cleanup,
    childrenFor(sess) {
      if(sess.role==='tutor') return q('SELECT c.id,c.nickname,c.username,c.avatar,c.unlocked,c.schedule FROM children c JOIN assignments a ON a.child_id=c.id JOIN parents p ON p.id=c.parent_id WHERE a.tutor_id=? AND c.active=1 AND p.active=1 ORDER BY c.nickname').all(sess.user_id);
      return sess.role==='parent' ? q('SELECT id,nickname,username,avatar,unlocked,schedule FROM children WHERE parent_id=?').all(sess.user_id) : q('SELECT id,nickname,username,avatar,unlocked,schedule FROM children WHERE id=?').all(sess.user_id);
    },
    decorate(state,sess) {
      state.isAdmin=isAdmin(sess);state.ai={configured:ai.configured,typedQuestionsAllowed:ai.typedQuestionsAllowed,helpModes:Object.entries(helpModes).map(([id,m])=>({id,label:m.label}))};
      state.aiSettings=[];state.aiMessages=[];state.assignments=[];
      if(!sess)return;
      cleanup();
      for(const child of state.children) {
        const config=settings(child.id);
        state.aiSettings.push({childId:child.id,...config,used:q('SELECT used FROM ai_usage WHERE child_id=? AND day=?').get(child.id,today())?.used??0});
        state.aiMessages.push(...q('SELECT id,child_id AS childId,week,role,content,flagged,created AS createdAt FROM ai_messages WHERE child_id=? ORDER BY id DESC LIMIT 60').all(child.id).reverse());
        if(sess.role==='parent')state.assignments.push(...q('SELECT a.child_id AS childId,t.id AS tutorId,t.name,t.email,t.active FROM assignments a JOIN tutors t ON t.id=a.tutor_id WHERE a.child_id=?').all(child.id));
      }
      if(state.isAdmin)state.admin={tutors:q('SELECT id,email,name,active FROM tutors ORDER BY name').all(),studentCount:q('SELECT count(*) AS n FROM children').get().n,familyCount:q('SELECT count(*) AS n FROM parents').get().n};
    },
    async handle({req,res,path,url,sess}) {
      if(req.method==='POST' && path==='/api/tutor-login') {
        const data=await body(req);const email=text(data.email,'tutor email',254).toLowerCase();
        const tutor=q('SELECT * FROM tutors WHERE email=? AND active=1').get(email);
        const valid=await verify(data.password,tutor?.password??('0'.repeat(32)+':'+'0'.repeat(128)));
        if(!tutor || !valid)problem(401,'Those sign-in details did not match. Please try again.');
        const csrf=newSession(res,'tutor',tutor.id,sess);json(res,200,{ok:true,csrfToken:csrf});return true;
      }
      if(req.method==='POST' && path==='/api/admin/tutors') {
        requireAdmin(sess);const data=await body(req);
        if(data.action==='deactivate' || data.action==='activate') {
          if(!q('SELECT id FROM tutors WHERE id=?').get(data.tutorId))problem(404,'Tutor not found.');
          transaction(()=>{q('UPDATE tutors SET active=? WHERE id=?').run(data.action==='activate'?1:0,data.tutorId);q("DELETE FROM sessions WHERE user_id=? AND role='tutor'").run(data.tutorId);});
        } else if(data.action==='reset') {
          if(!q('SELECT id FROM tutors WHERE id=?').get(data.tutorId))problem(404,'Tutor not found.');
          const hash=await hashPassword(password(data.password));
          transaction(()=>{q('UPDATE tutors SET password=? WHERE id=?').run(hash,data.tutorId);q("DELETE FROM sessions WHERE user_id=? AND role='tutor'").run(data.tutorId);});
        } else if(data.action==='create') {
          const name=text(data.name,'tutor name',60),email=text(data.email,'tutor email',254).toLowerCase();
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))problem(400,'Please enter a valid tutor email.');
          if(q('SELECT id FROM tutors WHERE email=?').get(email))problem(409,'A tutor already has this email.');
          const hash=await hashPassword(password(data.password));
          q('INSERT INTO tutors(id,email,name,password) VALUES(?,?,?,?)').run(randomUUID(),email,name,hash);
        } else problem(400,'Unknown tutor action.');
        json(res,200,{ok:true});return true;
      }
      if(req.method==='POST' && path==='/api/tutor-assignment') {
        requireSession(sess,'parent');const data=await body(req);owns(sess,data.childId);
        if(data.action==='revoke') {
          q('DELETE FROM assignments WHERE child_id=? AND tutor_id=?').run(data.childId,data.tutorId);log(data.childId,'parent','Tutor access revoked');
        } else if(data.action==='assign') {
          const tutor=q('SELECT id FROM tutors WHERE email=? AND active=1').get(text(data.email,'tutor email',254).toLowerCase());
          if(!tutor)problem(404,'No active tutor matches that email. Ask the academy administrator to create their account.');
          q('INSERT OR IGNORE INTO assignments VALUES(?,?)').run(data.childId,tutor.id);log(data.childId,'parent','Parent granted tutor access to progress, projects and AI conversations');
        } else problem(400,'Unknown assignment action.');
        json(res,200,{ok:true});return true;
      }
      if(req.method==='POST' && path==='/api/ai/settings') {
        const data=await body(req);owns(sess,data.childId);
        if(typeof data.enabled!=='boolean' || !['guided','chat'].includes(data.mode))problem(400,'Choose valid AI access settings.');
        const limit=integer(data.dailyLimit,1,50,'daily help limit');
        if(data.mode==='chat' && !ai.typedQuestionsAllowed)problem(403,'Typed questions require the owner to confirm Zero Data Retention for the OpenAI project first.');
        q('INSERT INTO ai_settings VALUES(?,?,?,?) ON CONFLICT(child_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,daily_limit=excluded.daily_limit').run(data.childId,data.enabled?1:0,data.mode,limit);
        log(data.childId,'parent',`AI tutor ${data.enabled?'enabled':'paused'} (${data.mode}, ${limit} requests/day)`);json(res,200,{ok:true});return true;
      }
      if(req.method==='GET' && path==='/api/ai/history') {
        requireSession(sess);const id=url.searchParams.get('childId');
        if(!accessible(sess,id))problem(404,'Student not found.');
        const week=integer(Number(url.searchParams.get('week')),1,24,'week');cleanup();
        json(res,200,{messages:q('SELECT id,child_id AS childId,week,role,content,flagged,created AS createdAt FROM ai_messages WHERE child_id=? AND week=? ORDER BY id').all(id,week)});return true;
      }
      if(req.method==='POST' && path==='/api/ai/help') {
        requireSession(sess,'child');const data=await body(req),id=sess.user_id;
        const child=q('SELECT id,unlocked FROM children WHERE id=?').get(id);
        const week=integer(data.week,1,child.unlocked,'week'),config=settings(id);
        if(!config.enabled)problem(403,'Your parent has paused AI help. Ask them or your tutor for a hand.');
        if(!ai.configured)problem(503,'The academy owner has not connected the AI helper yet.');
        const mode=data.mode;
        if(mode==='chat' && (config.mode!=='chat' || !ai.typedQuestionsAllowed))problem(403,'Use the guided help buttons for this account.');
        if(mode!=='chat' && !Object.hasOwn(helpModes,mode))problem(400,'Choose a lesson help button.');
        // Unexpected free-text fields on guided requests are rejected, not forwarded.
        if(mode!=='chat' && Object.keys(data).some(k=>!['week','mode'].includes(k)))problem(400,'Guided help only accepts a lesson number and help button.');
        const message=mode==='chat'?text(data.message,'question',1000):helpModes[mode].label;
        if(inFlight.has(id))problem(429,'Please wait for your current explanation.');
        const day=today();
        transaction(()=>{if(q('SELECT coalesce(sum(used),0) AS n FROM ai_usage WHERE day=?').get(day).n>=globalDailyLimit)problem(429,'The academy has reached today’s AI help allowance. Ask your parent or tutor for help.');q('INSERT OR IGNORE INTO ai_usage VALUES(?,?,0)').run(id,day);const result=q('UPDATE ai_usage SET used=used+1 WHERE child_id=? AND day=? AND used<?').run(id,day,config.dailyLimit);if(!result.changes)problem(429,'That is today’s help allowance. Ask your parent or tutor for the next step.');});
        inFlight.add(id);
        try {
          cleanup();
          const history=mode==='chat'?q('SELECT role,content FROM ai_messages WHERE child_id=? AND week=? ORDER BY id DESC LIMIT 6').all(id,week).reverse():[];
          const result=await ai.reply({lesson:(options.lessonProvider?.(week) ?? lessons[week-1]),mode,message,history,studentId:id});
          // Re-check consent after awaiting an external service. No response is saved/delivered if paused.
          const current=settings(id);
          if(!current.enabled || mode==='chat'&&current.mode!=='chat')problem(403,'Your parent has changed AI access. Ask them for the next step.');
          transaction(()=>{
            q('INSERT INTO ai_messages(child_id,week,role,content,flagged,created) VALUES(?,?,?,?,?,?)').run(id,week,'user',message,result.flagged?1:0,now());
            q('INSERT INTO ai_messages(child_id,week,role,content,flagged,created) VALUES(?,?,?,?,?,?)').run(id,week,'assistant',result.text,result.flagged?1:0,now());
            log(id,'ai',`Used Junior AI Tutor for week ${week}${result.flagged?' · adult check-in suggested':''}`);
          });
          json(res,200,{ok:true,text:result.text,flagged:result.flagged});return true;
        } finally {inFlight.delete(id);}
      }
      return false;
    },
  };
}
