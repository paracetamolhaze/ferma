import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Run the real API routes, SQLite migrations, encryption and R2 with a fake
// external provider. No user data or real social accounts are used.
test('workspace lifecycle: ownership, media, drafts, scheduling, retry and status sync', { timeout: 90000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const bundle = await build({ stdin: { contents: `
    import * as workspace from './app/api/workspace/route';
    import * as media from './app/api/media/route';
    import * as settings from './app/api/settings/route';
    import { setRequest } from 'test-auth';
    export default { async fetch(request) {
      setRequest(request);
      const routes = { '/api/workspace':workspace, '/api/media':media, '/api/settings':settings };
      return routes[new URL(request.url).pathname][request.method](request);
    }};`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'), plugins: [{ name:'test-auth', setup(build) {
      build.onResolve({filter:/chatgpt-auth$|^test-auth$/}, () => ({path:'auth',namespace:'test'}));
      build.onLoad({filter:/.*/,namespace:'test'}, () => ({contents:`let request; export function setRequest(r){ request=r; } export async function getChatGPTUser(){ const userId=request.headers.get('test-owner'); return userId?{userId}:null; }`}));
    }}] });
  let postMode = 'ok', postStatus = 'scheduled';
  let accounts = [{_id:'remote-threads',platform:'threads',username:'qa',profileId:'remote-profile',isActive:true}];
  const submissions = [], uploads = [];
  const mf = new Miniflare({ modules:true, script:bundle.outputFiles[0].text, compatibilityDate:'2026-05-15', d1Databases:['DB'], r2Buckets:['BUCKET'], bindings:{SETTINGS_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64')}, outboundService:async request => {
    const url = new URL(request.url);
    if (request.headers.get('authorization') === 'Bearer replacement-key') {
      if (url.pathname.endsWith('/profiles')) return Response.json({profiles:[{_id:'new-remote',name:'Other account'}]});
      if (url.pathname.endsWith('/accounts')) {
        assert.equal(url.searchParams.get('profileId'), 'new-remote');
        return Response.json({accounts:[{_id:'new-ig',platform:'instagram',username:'new-account',profileId:'new-remote',isActive:true}]});
      }
      throw new Error('Old post must not be requested with the replacement key');
    }
    if (url.hostname === 'upload.test') { uploads.push(new Uint8Array(await request.arrayBuffer())); return new Response(null,{status:200}); }
    if (request.headers.get('authorization') !== 'Bearer fixture-profile-key') return Response.json({error:'Invalid API key'},{status:401});
    if (url.pathname.endsWith('/profiles')) return Response.json({profiles:[{_id:'remote-profile',name:'Test remote'}]});
    if (url.pathname.endsWith('/accounts')) return Response.json({accounts});
    if (url.pathname.endsWith('/media/presign')) return Response.json({uploadUrl:'https://upload.test/media',publicUrl:'https://cdn.test/media.png'});
    if (url.pathname.endsWith('/posts') && request.method==='POST') {
      submissions.push({key:request.headers.get('idempotency-key'),payload:await request.json()});
      if (postMode==='uncertain') return Response.json({error:'Temporary failure'},{status:503});
      if (postMode==='rejected') return Response.json({error:'Caption rejected'},{status:422});
      return Response.json({post:{_id:'remote-post'}});
    }
    if (url.pathname.endsWith('/posts/remote-post')) return Response.json({post:{status:postStatus,platforms:[]}});
    throw new Error(`Unexpected provider request: ${request.method} ${url.pathname}`);
  }});
  t.after(()=>mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root,'drizzle'))).filter(f=>f.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root,'drizzle',file),'utf8')).replaceAll('--> statement-breakpoint','');
    for (const statement of sql.split(';').map(v=>v.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  async function call(body, {owner='owner', origin='http://test', route='/api/workspace'}={}) {
    const response = await mf.dispatchFetch(`http://test${route}`,{method:body?'POST':'GET',headers:{'test-owner':owner,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  }
  assert.equal((await call(null,{owner:''})).status,401);
  assert.equal((await call({action:'profile',name:'x',color:'#123456'},{origin:'https://other.test'})).status,403);
  assert.equal((await call({action:'profile',name:'  ',color:'#123456'})).status,400);
  const profileId=(await call({action:'profile',name:'QA profile',color:'#123456'})).data.id;
  assert.ok(profileId);
  assert.equal((await call({action:'renameProfile',profileId,name:'  Renamed  '})).status,200);
  assert.equal((await call()).data.profiles[0].name,'Renamed');
  assert.equal((await call({action:'renameProfile',profileId,name:'stolen'},{owner:'other'})).status,400);
  assert.equal((await call({action:'renameProfile',profileId,name:' '})).status,400);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6B9sAAAAASUVORK5CYII=','base64');
  const upload=await mf.dispatchFetch('http://test/api/media',{method:'POST',headers:{'test-owner':'owner',origin:'http://test','content-type':'image/png','content-length':String(png.length),'x-file-name':encodeURIComponent('Проверка.png')},body:png});
  assert.equal(upload.status,200);
  const mediaId=(await upload.json()).id;
  const mediaResponse=await mf.dispatchFetch(`http://test/api/media?id=${mediaId}`,{headers:{'test-owner':'owner'}});
  assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()),png);
  const range=await mf.dispatchFetch(`http://test/api/media?id=${mediaId}`,{headers:{'test-owner':'owner',range:'bytes=0-7'}});
  assert.equal(range.status,206);
  assert.equal((await range.arrayBuffer()).byteLength,8);
  assert.equal((await mf.dispatchFetch(`http://test/api/media?id=${mediaId}`,{headers:{'test-owner':'other'}})).status,404);
  const draft={action:'draft',profileId,title:'QA draft',content:'Caption',mediaId,platforms:['threads']};
  const id=(await call(draft)).data.id;
  assert.ok(id);
  assert.equal((await call({...draft,id,title:'Edited'})).status,200);
  assert.equal((await call({...draft,id},{owner:'other'})).status,400);
  assert.equal((await call()).data.posts[0].title,'Edited');
  const when=new Date(Date.now()+3600000).toISOString();
  assert.equal((await call({action:'schedule',id,scheduledFor:when})).status,503);
  assert.equal((await call({profileId,apiKey:'fixture-profile-key'},{route:'/api/settings'})).status,200);
  let state=(await call()).data;
  assert.equal(state.profiles[0].configured,true);
  assert.equal(state.channels.length,1);
  assert.equal(JSON.stringify(state).includes('fixture-profile-key'),false);
  assert.equal((await call({profileId,apiKey:'invalid'},{route:'/api/settings'})).status,400);
  assert.equal((await call({action:'importAccounts',profileId})).status,200);
  assert.equal((await call({action:'schedule',id,scheduledFor:'bad'})).status,400);
  assert.equal(submissions.length,0);
  postMode='uncertain';
  assert.equal((await call({action:'schedule',id,scheduledFor:when})).status,503);
  state=(await call()).data;
  assert.equal(state.posts[0].status,'uncertain');
  assert.equal((await call({...draft,id})).status,400);
  postMode='ok';
  assert.equal((await call({action:'schedule',id,scheduledFor:when})).status,200);
  assert.equal(submissions.length,2);
  assert.deepEqual(submissions[0],submissions[1]);
  assert.equal(submissions[0].payload.platforms[0].accountId,'remote-threads');
  assert.equal(submissions[0].payload.scheduledFor,when);
  assert.deepEqual(Buffer.from(uploads[0]),png);
  assert.equal((await call({action:'schedule',id,scheduledFor:when})).status,400);
  assert.equal((await call({action:'deleteDraft',id})).status,400);
  postStatus='published';
  assert.equal((await call({action:'sync',profileId})).status,200);
  assert.equal((await call()).data.posts.find(p=>p.id===id).status,'published');
  const rejectedId=(await call({...draft,title:'Rejected'})).data.id;
  postMode='rejected';
  assert.equal((await call({action:'schedule',id:rejectedId,scheduledFor:when})).status,502);
  assert.equal((await call()).data.posts.find(p=>p.id===rejectedId).status,'draft');
  accounts=[];
  const before=submissions.length;
  assert.equal((await call({action:'schedule',id:rejectedId,scheduledFor:when})).status,400);
  assert.equal(submissions.length,before);
  assert.equal((await call({action:'deleteDraft',id:rejectedId})).status,200);
  assert.equal((await call()).data.posts.some(p=>p.id===rejectedId),false);
  const reveal = {action:'reveal',profileId};
  assert.equal((await call(reveal,{route:'/api/settings'})).data.apiKey,'fixture-profile-key');
  assert.equal((await call(reveal,{route:'/api/settings',owner:'other'})).status,404);
  assert.equal((await call(reveal,{route:'/api/settings',origin:'https://other.test'})).status,403);
  assert.equal((await call(reveal,{route:'/api/settings',owner:''})).status,401);
  const revealed = await mf.dispatchFetch('http://test/api/settings',{method:'POST',headers:{'test-owner':'owner',origin:'http://test','content-type':'application/json'},body:JSON.stringify(reveal)});
  assert.equal(revealed.headers.get('cache-control'),'no-store');
  accounts=[{_id:'remote-threads',platform:'threads',username:'qa',profileId:'remote-profile',isActive:true}];
  postMode='ok';
  const pendingId=(await call({...draft,title:'Scheduled in old account'})).data.id;
  assert.equal((await call({action:'schedule',id:pendingId,scheduledFor:when})).status,200);
  const unsentId=(await call({...draft,title:'Unsent draft'})).data.id;
  assert.equal((await call({profileId,apiKey:'fixture-profile-key'},{route:'/api/settings'})).status,200);
  assert.equal((await db.prepare('SELECT zernioId FROM profiles WHERE id=?').bind(profileId).first()).zernioId,'remote-profile');
  assert.equal((await call({profileId,apiKey:'replacement-key'},{route:'/api/settings'})).status,200);
  assert.equal((await db.prepare('SELECT zernioId FROM profiles WHERE id=?').bind(profileId).first()).zernioId,'new-remote');
  state=(await call()).data;
  assert.deepEqual(state.channels.map(c=>c.accountId),['new-ig']);
  assert.equal(state.posts.find(p=>p.id===pendingId).status,'external');
  assert.equal(state.posts.find(p=>p.id===unsentId).platforms,'[]');
  assert.equal((await call(reveal,{route:'/api/settings'})).data.apiKey,'replacement-key');
  assert.equal((await call({action:'sync',profileId})).status,200);
  assert.equal(JSON.stringify(state).includes('replacement-key'),false);
  assert.equal((await call({profileId,apiKey:'invalid'},{route:'/api/settings'})).status,400);
  assert.equal((await call(reveal,{route:'/api/settings'})).data.apiKey,'replacement-key');
});
