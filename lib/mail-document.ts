// Mail HTML is untrusted. It renders only inside <iframe sandbox> with this policy:
// no scripts or forms, and no remote images that would reveal the opening of a message.
const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
export function mailDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank"><style>body{margin:12px;font:14px/1.5 "Segoe UI",sans-serif;color:#1f2933;overflow-wrap:anywhere}img,table{max-width:100%}</style></head><body>${html}</body></html>`;
}
export const MAIL_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
