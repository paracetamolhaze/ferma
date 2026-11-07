export const NETWORKS = [
  { id: "youtube", name: "YouTube", symbol: "▶", color: "#ef4242" },
  { id: "tiktok", name: "TikTok", symbol: "♪", color: "#171b20" },
  { id: "instagram", name: "Instagram", symbol: "◎", color: "#bc4c8f" },
  { id: "threads", name: "Threads", symbol: "@", color: "#171b20" },
  { id: "twitter", name: "X", symbol: "𝕏", color: "#171b20" },
];
export const MAX_UPLOAD = 90 * 1024 * 1024;
export function validateSchedule(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < Date.now() + 120000) throw new Error("Выберите время хотя бы на 2 минуты позже текущего.");
  return new Date(timestamp).toISOString();
}
export function validateTargets(platforms: string[], content: string, type?: string) {
  if (!platforms.length || platforms.length > 2 || new Set(platforms).size !== platforms.length || platforms.some(p => !NETWORKS.some(n => n.id === p))) throw new Error("Выберите одну или две соцсети.");
  if (platforms.some(p => ["youtube", "tiktok"].includes(p)) && type !== "video") throw new Error("Для YouTube и TikTok нужно видео.");
  if (platforms.includes("instagram") && !type) throw new Error("Для Instagram добавьте изображение или видео.");
  if (platforms.includes("twitter") && content.length > 280) throw new Error("Для X сократите подпись до 280 символов.");
  if (platforms.includes("threads") && content.length > 500) throw new Error("Для Threads сократите подпись до 500 символов.");
  if (platforms.includes("instagram") && content.length > 2200) throw new Error("Для Instagram сократите подпись до 2200 символов.");
}
