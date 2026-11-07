import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getDb } from "@/db";
import { media } from "@/db/schema";
import { MAX_UPLOAD } from "@/lib/domain";
const types = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"];
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Войдите в аккаунт." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403 });
  const type = request.headers.get("content-type") || "";
  const size = Number(request.headers.get("content-length"));
  if (!types.includes(type) || size <= 0 || size > MAX_UPLOAD) return Response.json({ error: "Загрузите MP4, MOV, JPG, PNG или WebP до 90 МБ." }, { status: 400 });
  const id = crypto.randomUUID(), key = `${user.userId}/${id}`;
  try {
    await env.BUCKET!.put(key, request.body!, { httpMetadata: { contentType: type } });
    const name = decodeURIComponent(request.headers.get("x-file-name") || "Файл").slice(0, 200);
    await getDb().insert(media).values({ id, owner: user.userId, key, name, type, size, createdAt: new Date().toISOString() });
    return Response.json({ id });
  } catch {
    await env.BUCKET!.delete(key);
    return Response.json({ error: "Не удалось сохранить файл. Повторите загрузку." }, { status: 500 });
  }
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return new Response(null, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") || "";
  const [m] = await getDb().select().from(media).where(and(eq(media.id, id), eq(media.owner, user.userId)));
  if (!m) return new Response(null, { status: 404 });
  const object = await env.BUCKET!.get(m.key, { range: request.headers });
  if (!object) return new Response(null, { status: 404 });
  const headers = new Headers({ "Content-Type": m.type, "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
  if (object.range && "offset" in object.range && "length" in object.range) {
    const { offset = 0, length = object.size } = object.range;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
