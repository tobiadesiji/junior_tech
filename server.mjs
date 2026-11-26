import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lessons, publicLessons, stepIds, rubric } from './curriculum.mjs';
import { createLearningSupport } from './learning-support.mjs';
import { createManagement } from './academy-management.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_FILE = 10 * 1024 * 1024;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const text = (value, label, max = 2000, required = true) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(400, `Please enter a valid ${label}.`);
  return value.trim();
};
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(400, `Invalid ${label}.`);
  return value;
};
const username = value => {
  const name = text(value, 'student username', 30).toLowerCase();
  if (!/^[a-z0-9_-]{3,30}$/.test(name)) fail(400, 'Use 3–30 letters, numbers, underscores or hyphens for a username.');
  return name;
};
const password = value => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail(400, 'Use a passphrase of 12–128 characters.');
  return value;
};
async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(value, salt, 64)).toString('hex')}`;
}
async function verify(value, stored) {
  const [salt, key] = stored.split(':');
  const attempt = await derive(typeof value === 'string' ? value.slice(0, 128) : '', salt, 64);
  return timingSafeEqual(attempt, Buffer.from(key, 'hex'));
}
async function body(req, limit = 96 * 1024, raw = false) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); fail(413, 'This upload is too large.'); }
  const chunks = []; let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn:false })) {
    length += chunk.length;
    if (length > limit) { req.resume(); fail(413, 'This upload is too large.'); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (raw) return bytes;
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Send JSON data.');
  try {
    const parsed = JSON.parse(bytes.toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Invalid request.');
    return parsed;
  } catch { fail(400, 'Invalid request data.'); }
}

export function createAcademy(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origin = options.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:3000';
  const parsedOrigin = new URL(origin);
  if (origin !== parsedOrigin.origin || (production && parsedOrigin.protocol !== 'https:')) throw new Error('APP_ORIGIN must be an exact origin, using HTTPS in production.');
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? resolve(root, 'data/academy.sqlite');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id), nickname TEXT NOT NULL, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT 'robot', unlocked INTEGER NOT NULL DEFAULT 1, schedule TEXT NOT NULL DEFAULT 'Two 30–40 minute sessions each week');
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS progress (child_id TEXT NOT NULL REFERENCES children(id), week INTEGER NOT NULL, steps TEXT NOT NULL DEFAULT '[]', quiz INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'not_started', scores TEXT NOT NULL DEFAULT '[]', feedback TEXT NOT NULL DEFAULT '', PRIMARY KEY(child_id, week));
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), week INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), week INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, reflection TEXT NOT NULL, link TEXT NOT NULL, file_id TEXT REFERENCES files(id), version INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, child_id TEXT NOT NULL REFERENCES children(id), actor TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL);
  `);
  const q = sql => db.prepare(sql);
  const now = () => new Date().toISOString();
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const log = (childId, actor, message) => q('INSERT INTO activity(child_id, actor, text, created) VALUES(?,?,?,?)').run(childId, actor, message, now());
  const rates = new Map();
  function rate(key, max, window = 15 * 60 * 1000) {
    const time = Date.now(); let entry = rates.get(key);
    if (!entry || entry.until < time) { entry = { count: 0, until: time + window }; rates.set(key, entry); }
    if (++entry.count > max) fail(429, 'Too many attempts. Please try again in 15 minutes.');
  }
  const cleanup = setInterval(() => {
    for (const [key, value] of rates) if (value.until < Date.now()) rates.delete(key);
    q('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    support.cleanup();
  }, 60_000).unref();
  const dummy = '00000000000000000000000000000000:' + '0'.repeat(128);
  function session(req) {
    const cookie = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('academy_session='))?.slice(16);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return null;
    const sess = q('SELECT * FROM sessions WHERE token=? AND expires>?').get(digest(cookie), Date.now());
    if (!sess) return null;
    const user = sess.role === 'parent' ? q('SELECT id,email,name FROM parents WHERE id=? AND active=1').get(sess.user_id) : sess.role === 'tutor' ? q('SELECT id,email,name FROM tutors WHERE id=? AND active=1').get(sess.user_id) : sess.role === 'child' ? q('SELECT id,parent_id,nickname,username FROM children WHERE id=? AND active=1 AND EXISTS(SELECT 1 FROM parents WHERE parents.id=children.parent_id AND parents.active=1)').get(sess.user_id) : null;
    return user ? { ...sess, user } : null;
  }
  function newSession(res, role, id, oldSession) {
    if (oldSession) q('DELETE FROM sessions WHERE token=?').run(oldSession.token);
    const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
    q('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(token), id, role, csrf, Date.now() + 7 * 86400_000);
    res.setHeader('Set-Cookie', `academy_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${production ? '; Secure' : ''}`);
    return csrf;
  }
  function requireSession(sess, role) {
    if (!sess) fail(401, 'Please sign in.');
    if (role && !(Array.isArray(role) ? role.includes(sess.role) : sess.role === role)) fail(403, 'This action is not available to this account.');
  }
  const support = createLearningSupport({db,options:{...options,lessonProvider:week=>management.lesson(week)},body,json,text,integer,password,hashPassword,verify,newSession,requireSession,log,transaction});
  const management = createManagement({db,body,json,text,integer,password,hashPassword,requireSession,isAdmin:support.isAdmin,transaction});
  function childFor(sess, id) {
    requireSession(sess);
    const child = q('SELECT id,parent_id,nickname,username,avatar,unlocked,schedule FROM children WHERE id=?').get(id);
    if (!child || !(sess.role === 'parent' ? child.parent_id === sess.user_id : sess.role === 'tutor' ? support.assigned(sess,id) : child.id === sess.user_id)) fail(404, 'Student not found.');
    return child;
  }
  const getProgress = (childId, week) => {
    q('INSERT OR IGNORE INTO progress(child_id,week) VALUES(?,?)').run(childId, week);
    return q('SELECT * FROM progress WHERE child_id=? AND week=?').get(childId, week);
  };
  const decodeProgress = p => ({ childId: p.child_id, week: p.week, completedSteps: JSON.parse(p.steps), quizPassed: !!p.quiz, status: p.status, scores: JSON.parse(p.scores), feedback: p.feedback });
  function state(sess) {
    const base = { role: sess?.role ?? 'guest', registrationOpen: options.allowRegistration ?? process.env.ALLOW_REGISTRATION === 'true', lessons: publicLessons, rubric, csrfToken: sess?.csrf ?? '', children: [], progress: [], projects: [], activity: [] };
    if (!sess) { support.decorate(base,sess); management.decorate(base,sess); return base; }
    base.user = sess.user;
    const children = support.childrenFor(sess);
    base.children = children;
    for (const child of children) {
      base.progress.push(...q('SELECT * FROM progress WHERE child_id=? ORDER BY week').all(child.id).map(decodeProgress));
      base.projects.push(...q('SELECT p.*,f.name AS filename FROM projects p LEFT JOIN files f ON p.file_id=f.id WHERE p.child_id=? ORDER BY p.created DESC').all(child.id).map(p => ({ id: p.id, childId: p.child_id, week: p.week, title: p.title, description: p.description, reflection: p.reflection, link: p.link, fileId: p.file_id, filename: p.filename, version: p.version, createdAt: p.created })));
      base.activity.push(...q('SELECT id,child_id AS childId,actor,text,created AS createdAt FROM activity WHERE child_id=? ORDER BY id DESC LIMIT 30').all(child.id));
    }
    base.activity.sort((a, b) => b.id - a.id);
    support.decorate(base,sess);
    management.decorate(base,sess);
    return base;
  }
  function json(res, status, result) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); }
  const publicFiles = new Map(['index.html','app.js','styles.css','favicon.svg'].map(file => [`/${file}`, { bytes: readFileSync(resolve(root, 'public', file)), type: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] }]));
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, origin); const path = url.pathname;
      const sess = session(req);
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) fail(403, 'This request did not come from this academy. Refresh the page and try again.');
        if (sess && req.headers['x-csrf-token'] !== sess.csrf) { const error = new HttpError(403, 'Your page is out of date. Refresh and try again.'); error.code = 'STALE_CSRF'; throw error; }
        rate(`post:${sess ? sess.role + ':' + sess.user_id : req.socket.remoteAddress}`, 180);
      }
      if (req.method === 'GET' && path === '/api/healthz') { q('SELECT 1').get(); return json(res, 200, { status: 'ok', version:'0.3.0' }); }
      if (req.method === 'GET' && path === '/api/academy') return json(res, 200, state(sess));
      if (req.method === 'POST' && path === '/api/tutor-login') rate(`auth:${req.socket.remoteAddress}`,20);
      if (await management.handle({req,res,path,url,sess})) return;
      if (await support.handle({req,res,path,url,sess})) return;
      if (req.method === 'POST' && ['/api/register', '/api/login', '/api/child-login'].includes(path)) {
        rate(`auth:${req.socket.remoteAddress}`, 20);
        const data = await body(req);
        if (path === '/api/register') {
          // Parent registration is opt-in; configure before exposing a new deployment.
          if (!(options.allowRegistration ?? process.env.ALLOW_REGISTRATION === 'true')) fail(403, 'Parent registration is closed. Ask the academy owner for access.');
          const email = text(data.email, 'email', 254).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
          const name = text(data.name, 'parent name', 60); const hash = await hashPassword(password(data.password));
          if (q('SELECT id FROM parents WHERE email=?').get(email)) fail(409, 'An account could not be created with these details. Try signing in.');
          const id = randomUUID(); q('INSERT INTO parents(id,email,name,password) VALUES(?,?,?,?)').run(id, email, name, hash);
          const csrf = newSession(res, 'parent', id, sess); return json(res, 201, { ok: true, csrfToken: csrf });
        }
        const child = path === '/api/child-login';
        const login = text(child ? data.username : data.email, 'login', 254).toLowerCase();
        rate(`account:${child}:${digest(login)}`, 15);
        const user = child ? q('SELECT id,password FROM children WHERE username=? AND active=1 AND EXISTS(SELECT 1 FROM parents WHERE parents.id=children.parent_id AND parents.active=1)').get(login) : q('SELECT id,password FROM parents WHERE email=? AND active=1').get(login);
        const valid = await verify(data.password, user?.password ?? dummy);
        if (!user || !valid) fail(401, 'Those sign-in details did not match. Please try again.');
        const csrf = newSession(res, child ? 'child' : 'parent', user.id, sess);
        return json(res, 200, { ok: true, csrfToken: csrf });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        requireSession(sess); q('DELETE FROM sessions WHERE token=?').run(sess.token);
        res.setHeader('Set-Cookie', `academy_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${production ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/children') {
        requireSession(sess, 'parent');
        if (q('SELECT count(*) AS n FROM children WHERE parent_id=?').get(sess.user_id).n >= 10) fail(400, 'This family already has ten student profiles.');
        const data = await body(req); const name = username(data.username); const nickname = text(data.nickname, 'nickname', 30);
        const hash = await hashPassword(password(data.password));
        if (q('SELECT id FROM children WHERE username=?').get(name)) fail(409, 'Choose a different student username.');
        const id = randomUUID();
        transaction(() => { q('INSERT INTO children(id,parent_id,nickname,username,password) VALUES(?,?,?,?,?)').run(id, sess.user_id, nickname, name, hash); log(id, 'parent', 'Joined the academy'); });
        return json(res, 201, { ok: true, childId: id });
      }
      if (req.method === 'POST' && path === '/api/child-settings') {
        requireSession(sess, 'parent'); const data = await body(req); const child = childFor(sess, data.childId);
        if (data.password !== undefined) {
          const hash = await hashPassword(password(data.password));
          transaction(() => { q('UPDATE children SET password=? WHERE id=?').run(hash, child.id); q("DELETE FROM sessions WHERE user_id=? AND role='child'").run(child.id); log(child.id, 'parent', 'Student passphrase reset; existing sessions signed out'); });
        } else {
          const nickname = text(data.nickname, 'nickname', 30); const schedule = text(data.schedule, 'study plan', 500, false);
          const unlocked = integer(data.unlocked, 1, 24, 'unlocked week');
          q('UPDATE children SET nickname=?,schedule=?,unlocked=? WHERE id=?').run(nickname, schedule, unlocked, child.id);
          log(child.id, 'parent', `Study plan updated; weeks 1–${unlocked} available`);
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/progress') {
        requireSession(sess, ['child','parent']); const data = await body(req); const child = childFor(sess, sess.role === 'child' ? sess.user_id : data.childId);
        if(sess.role === 'parent' && data.action !== 'step') fail(403, 'Knowledge checks must be completed from the student account.');
        const week = integer(data.week, 1, child.unlocked, 'week'); const p = getProgress(child.id, week);
        if (['submitted', 'approved'].includes(p.status)) fail(409, 'This week is awaiting review or already approved. Ask a parent to request changes first.');
        if (data.action === 'step') {
          if (!stepIds.includes(data.stepId) || typeof data.completed !== 'boolean') fail(400, 'Invalid lesson step.');
          const steps = new Set(JSON.parse(p.steps)); data.completed ? steps.add(data.stepId) : steps.delete(data.stepId);
          q("UPDATE progress SET steps=?,status='in_progress',scores='[]' WHERE child_id=? AND week=?").run(JSON.stringify([...steps]), child.id, week);
          if(sess.role === 'parent') log(child.id, 'parent', `${data.completed ? 'Completed' : 'Reopened'} learning step ${data.stepId} for week ${week}`);
        } else if (data.action === 'quiz') {
          const answer = integer(data.answer, 0, management.lesson(week).quiz.options.length - 1, 'answer');
          const passed = answer === management.lesson(week).quiz.answer;
          q("UPDATE progress SET quiz=?,status='in_progress',scores='[]' WHERE child_id=? AND week=?").run(passed ? 1 : 0, child.id, week);
          return json(res, 200, { ok: true, passed, message: passed ? 'You have it! Explain your answer to your parent.' : 'Have another look at the lesson and try again.' });
        } else fail(400, 'Unknown progress action.');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/upload') {
        requireSession(sess, 'child'); const child = childFor(sess, sess.user_id);
        const week = integer(Number(url.searchParams.get('week')), 1, child.unlocked, 'week');
        const p = getProgress(child.id, week);
        if (['submitted', 'approved'].includes(p.status)) fail(409, 'This week is closed for editing.');
        const name = text(url.searchParams.get('name'), 'filename', 120).replace(/[^a-zA-Z0-9._ -]/g, '_');
        const extension = extname(name).toLowerCase();
        if (!['.png','.jpg','.jpeg','.pdf','.txt','.py','.sb3','.hex'].includes(extension)) fail(400, 'Choose PNG, JPG, PDF, TXT, PY, SB3 or HEX files.');
        const usage = q('SELECT coalesce(sum(length(bytes)),0) AS n FROM files WHERE child_id=?').get(child.id).n;
        if (usage >= 100 * 1024 * 1024) fail(413, 'This student has reached the 100 MB storage allowance. Ask the owner to export and manage stored files.');
        const bytes = await body(req, MAX_FILE, true);
        if (!bytes.length || usage + bytes.length > 100 * 1024 * 1024) fail(413, 'File is empty or exceeds the storage allowance.');
        const starts = hex => bytes.subarray(0, hex.length / 2).toString('hex') === hex;
        if (extension === '.png' && !starts('89504e470d0a1a0a') || ['.jpg','.jpeg'].includes(extension) && !starts('ffd8ff') || extension === '.pdf' && !bytes.subarray(0,5).equals(Buffer.from('%PDF-')) || extension === '.sb3' && !starts('504b0304')) fail(400, 'The file contents do not match its extension.');
        const id = randomUUID(); q('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run(id, child.id, week, name, 'application/octet-stream', bytes, now());
        return json(res, 201, { ok: true, fileId: id, filename: name });
      }
      if (req.method === 'POST' && path === '/api/projects') {
        requireSession(sess, 'child'); const data = await body(req); const child = childFor(sess, sess.user_id);
        const week = integer(data.week, 1, child.unlocked, 'week'); const p = getProgress(child.id, week);
        if (['submitted', 'approved'].includes(p.status)) fail(409, 'This week is closed for editing.');
        if (!p.quiz || JSON.parse(p.steps).length !== stepIds.length) fail(400, 'Complete both sessions and the knowledge check before submitting.');
        const title = text(data.title, 'project title', 120); const description = text(data.description, 'project description'); const reflection = text(data.reflection, 'reflection');
        const link = text(data.link ?? '', 'project link', 1000, false);
        if (link) { try { const u = new URL(link); if (u.protocol !== 'https:' || u.username || u.password) throw Error(); } catch { fail(400, 'Use an HTTPS project link without embedded login details.'); } }
        const fileId = data.fileId || null;
        if (fileId && !q('SELECT id FROM files WHERE id=? AND child_id=? AND week=?').get(fileId, child.id, week)) fail(400, 'Attachment not found for this week.');
        transaction(() => {
          const version = q('SELECT coalesce(max(version),0)+1 AS n FROM projects WHERE child_id=? AND week=?').get(child.id, week).n;
          q('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), child.id, week, title, description, reflection, link, fileId, version, now());
          q("UPDATE progress SET status='submitted',scores='[]',feedback='' WHERE child_id=? AND week=?").run(child.id, week);
          log(child.id, 'child', `Submitted week ${week}: ${title}`);
        });
        return json(res, 201, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/review') {
        requireSession(sess, ['parent','tutor']); const data = await body(req); const child = childFor(sess, data.childId);
        const week = integer(data.week, 1, 24, 'week'); const p = getProgress(child.id, week);
        if (!['submitted','approved'].includes(p.status)) fail(409, 'There is no submitted project to review.');
        if (!['approved','changes_requested'].includes(data.status)) fail(400, 'Choose approve or request changes.');
        if (!Array.isArray(data.scores) || data.scores.length !== 5) fail(400, 'Score each of the five skills.');
        data.scores.forEach(score => integer(score, 0, 3, 'skill score'));
        const feedback = text(data.feedback, 'feedback');
        transaction(() => {
          q('UPDATE progress SET status=?,scores=?,feedback=? WHERE child_id=? AND week=?').run(data.status, JSON.stringify(data.scores), feedback, child.id, week);
          if (data.status === 'approved') q('UPDATE children SET unlocked=max(unlocked,?) WHERE id=?').run(Math.min(24, week + 1), child.id);
          log(child.id, sess.role, `${sess.role === 'tutor' ? 'Tutor: ' : ''}${data.status === 'approved' ? 'Approved' : 'Requested changes for'} week ${week}`);
        });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path.startsWith('/api/files/')) {
        requireSession(sess); const id = path.slice('/api/files/'.length);
        const file = q('SELECT * FROM files WHERE id=?').get(id);
        if (!file) fail(404, 'File not found.'); childFor(sess, file.child_id);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file.name}"`, 'Content-Length': file.bytes.length, 'Content-Security-Policy': "sandbox; default-src 'none'" });
        return res.end(Buffer.from(file.bytes));
      }
      if (req.method === 'GET' && path === '/api/export') {
        requireSession(sess, 'parent');
        const family = state(sess); delete family.csrfToken; delete family.lessons;
        family.aiMessages = family.children.flatMap(c => q('SELECT id,child_id AS childId,week,role,content,flagged,created AS createdAt FROM ai_messages WHERE child_id=? ORDER BY id').all(c.id));
        family.files = family.children.flatMap(c => q('SELECT id,week,name,bytes FROM files WHERE child_id=?').all(c.id).map(f => ({ id: f.id, childId: c.id, week: f.week, name: f.name, base64: Buffer.from(f.bytes).toString('base64') })));
        res.setHeader('Content-Disposition', 'attachment; filename="academy-family-export.json"');
        return json(res, 200, family);
      }
      if (req.method === 'GET' && (path === '/' || publicFiles.has(path))) {
        const file = publicFiles.get(path === '/' ? '/index.html' : path);
        res.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8` }); return res.end(file.bytes);
      }
      if (path.startsWith('/api/')) fail(404, 'This action was not found.');
      fail(404, 'Page not found.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!error.status) console.error('Request failed:', error.code ?? error.name);
      json(res, error.status ?? 500, { error: error.status ? error.message : 'Something went wrong. Please try again.', ...(error.code==='STALE_CSRF'?{code:error.code}:{}) });
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return { server, db, close: () => new Promise((resolveClose, reject) => { clearInterval(cleanup); server.close(error => { db.close(); error ? reject(error) : resolveClose(); }); server.closeIdleConnections(); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createAcademy(); const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Junior Tech Academy listening on port ${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
}
