import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publicLessons, rubric } from '../curriculum.mjs';

// Pure view tests: no browser, external network, production accounts or fixture data shipped.
const source = readFileSync(new URL('../public/app.js', import.meta.url),'utf8');
function renderer(fixture) {
  const root={innerHTML:''};
  const context=vm.createContext({
    document:{querySelector:()=>root,addEventListener:()=>{}},
    location:{hash:''},addEventListener:()=>{},
    fetch:()=>new Promise(()=>{}),fixture,
    window:{scrollTo:()=>{}},setTimeout,clearTimeout,URL,
  });
  vm.runInContext(source,context);
  return (route,week=1)=>{
    context.nextRoute=route;context.nextWeek=week;
    vm.runInContext('state=fixture; route=nextRoute; week=nextWeek; render()',context);
    return root.innerHTML;
  };
}
const child={id:'child-1',nickname:'Explorer',username:'student-one',unlocked:24,schedule:'Two sessions'};
const base={lessons:publicLessons,rubric,registrationOpen:true,children:[child],progress:[],projects:[],activity:[],user:{name:'Parent',nickname:'Explorer'},csrfToken:'test-token',ai:{configured:true,typedQuestionsAllowed:false,helpModes:[{id:'explain',label:'Explain this idea'}]},aiMessages:[],aiSettings:[{childId:child.id,enabled:1,mode:'guided',dailyLimit:20,used:1}],assignments:[]};
test('guest account choices render and all authenticated pages produce content',()=>{
  assert.match(renderer({...base,role:'guest'})('dashboard'),/Create a parent account/);
  for(const role of ['parent','child']) for(const route of ['dashboard','curriculum','projects',...(role==='parent'?['family']:[])]) {
    const html=renderer({...base,role})(route);
    assert.match(html,/<main id="main"/); assert.ok(!html.includes('undefined'));
  }
});
test('all 24 lessons render with complete sessions and correct role controls',()=>{
  for(const role of ['parent','child']) {
    const render=renderer({...base,role});
    for(let week=1;week<=24;week++) {
      const html=render('lesson',week);
      assert.ok(html.includes(publicLessons[week-1].title));
      assert.equal((html.match(/data-step=/g)||[]).length,6);
      assert.equal(html.includes('Parent teaching notes'),role==='parent');
      assert.equal(html.includes('id="project-form"'),role==='child');
    }
  }
});
test('user content is escaped in names, project fields and attachment labels',()=>{
  const attack='"><img src=x onerror=alert(1)>';
  const fixture={...base,role:'parent',user:{name:attack},children:[{...child,nickname:attack}],projects:[{id:'p',childId:child.id,week:1,title:attack,description:attack,reflection:attack,link:'https://example.test/',fileId:'f',filename:attack,version:1,createdAt:'2026-11-19'}]};
  for(const route of ['dashboard','family','projects','lesson']) {
    const html=renderer(fixture)(route);
    assert.ok(!html.includes('<img src=x')); assert.ok(html.includes('&lt;img'));
  }
});
test('tutor roster, parent support controls and admin management render by role',()=>{
  const teacher=renderer({...base,role:'tutor'});
  assert.match(teacher('dashboard'),/Your tutor workspace/);
  assert.ok(!teacher('lesson').includes('id="project-form"'));
  assert.ok(!teacher('dashboard').includes('href="#family"'));
  assert.match(renderer({...base,role:'parent'})('support'),/Grant tutor access/);
  assert.match(renderer({...base,role:'parent',isAdmin:true,admin:{familyCount:1,studentCount:1,tutors:[]}})('admin'),/Create tutor account/);
  assert.ok(!renderer({...base,role:'parent',isAdmin:false})('admin').includes('id="tutor-create-form"'));
});
test('AI guided mode offers no text entry; transcript text is safely escaped',()=>{
  const fixture={...base,role:'child',aiMessages:[{id:1,childId:child.id,week:1,role:'assistant',content:'<script>bad()</script>',flagged:0}]};
  const html=renderer(fixture)('ai');assert.match(html,/data-ai-mode="explain"/);assert.ok(!html.includes('id="ai-chat-form"'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  const chat=renderer({...fixture,ai:{...base.ai,typedQuestionsAllowed:true},aiSettings:[{...base.aiSettings[0],mode:'chat'}]})('ai');
  assert.match(chat,/id="ai-chat-form"/);
});
