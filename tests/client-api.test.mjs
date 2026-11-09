import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../lib/client-api.ts';

test('API failures show readable errors instead of JSON parsing or network internals', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch=original; });
  globalThis.fetch=async()=>new Response('',{status:502});
  await assert.rejects(requestJson('/api/workspace'),/Сервер временно недоступен/);
  globalThis.fetch=async()=>new Response('<html>error</html>',{status:200});
  await assert.rejects(requestJson('/api/workspace'),/Не удалось прочитать ответ/);
  globalThis.fetch=async()=>{throw new TypeError('Failed to fetch');};
  await assert.rejects(requestJson('/api/workspace'),/Нет связи с сервером/);
  globalThis.fetch=async()=>Response.json({error:'Профиль не найден.'},{status:400});
  await assert.rejects(requestJson('/api/workspace'),/Профиль не найден/);
  globalThis.fetch=async()=>Response.json({ok:true});
  assert.deepEqual(await requestJson('/api/workspace'),{ok:true});
});
